"""
database.py — SQLite 异步存储层 + 消息去重
会话列表 + 消息历史
"""
import sqlite3
import os
import asyncio
import time as _time
import threading
from datetime import datetime
from typing import Optional

# ── Bot 全局状态 ─────────────────────────────────────────
bot_name: str = "Bot"
bot_start_time: float = 0.0


# ── 消息去重：防止 Bot 发出的消息被 WebSocket 回显重复入库 ──
_recent_outgoing: set = set()
_OUTGOING_TTL = 10  # 秒


def mark_outgoing(conv_id: str, content: str) -> None:
    """记录一条即将发出的消息"""
    key = (conv_id, hash(content))
    _recent_outgoing.add(key)
    def _clean():
        _time.sleep(_OUTGOING_TTL)
        _recent_outgoing.discard(key)
    threading.Thread(target=_clean, daemon=True).start()


def is_echo(conv_id: str, content: str) -> bool:
    """判断是否为 Bot 发出的消息回显"""
    return (conv_id, hash(content)) in _recent_outgoing

DB_PATH = os.path.join(os.path.dirname(__file__), "neonbot.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            id          TEXT PRIMARY KEY,          -- group_openid 或 user_openid
            name        TEXT NOT NULL DEFAULT '',  -- 群名 / 用户名
            type        TEXT NOT NULL DEFAULT 'group',  -- 'group' | 'direct'
            avatar_url  TEXT DEFAULT '',
            last_message TEXT DEFAULT '',
            last_sender TEXT DEFAULT '',
            last_direction TEXT DEFAULT '',
            last_message_time REAL DEFAULT 0,
            unread_count INTEGER DEFAULT 0,
            created_at  TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            sender_openid   TEXT DEFAULT '',
            sender_name     TEXT DEFAULT '',
            sender_avatar   TEXT DEFAULT '',
            content         TEXT DEFAULT '',
            msg_type        INTEGER DEFAULT 0,   -- 0=文本
            direction       TEXT NOT NULL DEFAULT 'incoming',  -- 'incoming' | 'outgoing'
            msg_id          TEXT DEFAULT '',      -- QQ 消息 ID
            attachments     TEXT DEFAULT '[]',    -- JSON: 附件列表
            member_role     TEXT DEFAULT '',      -- 群角色
            recalled        INTEGER DEFAULT 0,    -- 是否已撤回
            quoted_sender   TEXT DEFAULT '',      -- 引用回复：被引用消息发送人
            quoted_content  TEXT DEFAULT '',      -- 引用回复：被引用消息内容
            timestamp       TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_msg_conv  ON messages(conversation_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_conv_time ON conversations(last_message_time DESC);
    """)
    conn.commit()
    conn.close()


# ── 会话操作 ──────────────────────────────────────────────

async def upsert_conversation(
    conv_id: str,
    name: str = "",
    conv_type: str = "group",
    avatar_url: str = "",
) -> None:
    def _do():
        conn = get_db()
        # 只在会话不存在时插入，已存在则只更新明确传了的字段
        existing = conn.execute(
            "SELECT name FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        if existing:
            # 已存在：仅当传了非空 name 且旧 name 是默认名时才更新
            if name and existing["name"] and existing["name"].startswith("群聊 "):
                conn.execute("UPDATE conversations SET name = ? WHERE id = ?", (name, conv_id))
        else:
            conn.execute(
                "INSERT INTO conversations (id, name, type, avatar_url) VALUES (?, ?, ?, ?)",
                (conv_id, name or f"群聊 {conv_id[:10]}", conv_type, avatar_url),
            )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def rename_conversation(conv_id: str, name: str) -> None:
    """强制重命名会话（用户手动设置备注）"""
    def _do():
        conn = get_db()
        conn.execute("UPDATE conversations SET name = ? WHERE id = ?", (name, conv_id))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def clear_messages(conv_id: str) -> None:
    """清空某个会话的所有消息"""
    def _do():
        conn = get_db()
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
        conn.execute(
            "UPDATE conversations SET last_message = '', last_message_time = 0 WHERE id = ?",
            (conv_id,),
        )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def touch_conversation(conv_id: str, last_message: str) -> None:
    def _do():
        conn = get_db()
        conn.execute("""
            UPDATE conversations
            SET last_message = ?,
                last_message_time = julianday('now'),
                unread_count = unread_count + 1
            WHERE id = ?
        """, (last_message, conv_id))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def reset_unread(conv_id: str) -> None:
    def _do():
        conn = get_db()
        conn.execute("UPDATE conversations SET unread_count = 0 WHERE id = ?", (conv_id,))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def get_conversations(limit: int = 50) -> list[dict]:
    def _do():
        conn = get_db()
        rows = conn.execute("""
            SELECT id, name, type, avatar_url, last_message, last_sender, last_direction,
                   unread_count, datetime(last_message_time) as last_time
            FROM conversations
            ORDER BY last_message_time DESC
            LIMIT ?
        """, (limit,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_do)


async def get_conversation(conv_id: str) -> Optional[dict]:
    def _do():
        conn = get_db()
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        conn.close()
        return dict(row) if row else None
    return await asyncio.to_thread(_do)


# ── 消息操作 ──────────────────────────────────────────────

async def save_message(
    conversation_id: str,
    sender_openid: str,
    sender_name: str,
    content: str,
    direction: str = "incoming",
    msg_id: str = "",
    msg_type: int = 0,
    sender_avatar: str = "",
    attachments: str = "[]",
    member_role: str = "",
    quoted_sender: str = "",
    quoted_content: str = "",
) -> dict:
    def _do():
        conn = get_db()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur = conn.execute("""
            INSERT INTO messages (conversation_id, sender_openid, sender_name,
                                  sender_avatar, content, msg_type, direction, msg_id, attachments, member_role,
                                  quoted_sender, quoted_content, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (conversation_id, sender_openid, sender_name, sender_avatar, content, msg_type, direction, msg_id, attachments, member_role, quoted_sender, quoted_content, now))
        msg_pk = cur.lastrowid

        # 更新会话摘要
        conn.execute("""
            UPDATE conversations
            SET last_message = ?,
                last_sender = ?,
                last_direction = ?,
                last_message_time = julianday('now')
            WHERE id = ?
        """, (content[:200], sender_name, direction, conversation_id))

        # 如果会话不存在，自动创建（群聊首次消息）
        if conn.execute("SELECT COUNT(*) FROM conversations WHERE id = ?", (conversation_id,)).fetchone()[0] == 0:
            conn.execute("""
                INSERT INTO conversations (id, name, type)
                VALUES (?, ?, ?)
            """, (conversation_id, conversation_id, "group"))

        conn.commit()
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_pk,)).fetchone()
        conn.close()
        return dict(row)
    return await asyncio.to_thread(_do)


async def get_messages(conversation_id: str, limit: int = 50, before_id: int = 0) -> list[dict]:
    def _do():
        conn = get_db()
        if before_id:
            rows = conn.execute("""
                SELECT * FROM messages
                WHERE conversation_id = ? AND id < ?
                ORDER BY id DESC LIMIT ?
            """, (conversation_id, before_id, limit)).fetchall()
        else:
            rows = conn.execute("""
                SELECT * FROM messages
                WHERE conversation_id = ?
                ORDER BY id DESC LIMIT ?
            """, (conversation_id, limit)).fetchall()
        conn.close()
        rows.reverse()  # 正序返回
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_do)


async def get_recent_messages(conversation_id: str, limit: int = 20) -> list[dict]:
    """拿最近 N 条（倒序、再反转成正序）"""
    return await get_messages(conversation_id, limit=limit, before_id=0)


async def clear_all_messages() -> None:
    """清空全部聊天记录"""
    def _do():
        conn = get_db()
        conn.execute("DELETE FROM messages")
        conn.execute("UPDATE conversations SET last_message = '', last_message_time = 0, unread_count = 0")
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def delete_messages_batch(msg_ids: list[int]) -> list[int]:
    """批量删除消息，返回已删除的 ID 列表"""
    def _do():
        conn = get_db()
        placeholders = ",".join("?" * len(msg_ids))
        conn.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", msg_ids)
        # 刷新受影响会话的预览
        conv_ids = conn.execute(
            f"SELECT DISTINCT conversation_id FROM messages WHERE id IN ({placeholders})", msg_ids
        ).fetchall()
        # 批量删除后再逐会话更新
        for conv_id in set(row[0] for row in conv_ids):
            latest = conn.execute(
                "SELECT content, sender_name, direction FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1",
                (conv_id,)
            ).fetchone()
            if latest:
                conn.execute(
                    "UPDATE conversations SET last_message=?, last_sender=?, last_direction=? WHERE id=?",
                    (latest["content"][:200], latest["sender_name"], latest["direction"], conv_id),
                )
            else:
                conn.execute(
                    "UPDATE conversations SET last_message='', last_sender='', last_direction='' WHERE id=?",
                    (conv_id,),
                )
        conn.commit()
        conn.close()
        return msg_ids
    return await asyncio.to_thread(_do)


async def get_message_by_db_id(msg_db_id: int) -> Optional[dict]:
    """通过本地 ID 获取消息"""
    def _do():
        conn = get_db()
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_db_id,)).fetchone()
        conn.close()
        return dict(row) if row else None
    return await asyncio.to_thread(_do)


async def delete_message(msg_id: int) -> Optional[dict]:
    """删除单条消息（本地 DB），返回被删消息用于 WebSocket 广播"""
    def _do():
        conn = get_db()
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()
        if not row:
            conn.close()
            return None
        deleted = dict(row)
        conv_id = deleted["conversation_id"]
        conn.execute("DELETE FROM messages WHERE id = ?", (msg_id,))
        # 更新会话预览为最新消息
        latest = conn.execute(
            "SELECT content, sender_name, direction FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
            (conv_id,)
        ).fetchone()
        if latest:
            conn.execute(
                "UPDATE conversations SET last_message=?, last_sender=?, last_direction=? WHERE id=?",
                (latest["content"][:200], latest["sender_name"], latest["direction"], conv_id),
            )
        else:
            conn.execute(
                "UPDATE conversations SET last_message='', last_sender='', last_direction='' WHERE id=?",
                (conv_id,),
            )
        conn.commit()
        conn.close()
        return deleted
    return await asyncio.to_thread(_do)
