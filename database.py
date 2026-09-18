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

# ── 群基本信息（/v2/groups/{id}/info）缓存时长 ───────────
# 超过该时长视为过期：后台定时任务（30 分钟一轮）与前端按需拉取都会刷新
GROUP_INFO_TTL = 6 * 3600  # 6 小时（API 限频 30 QPM）


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,           -- 账号ID (appid)
            name TEXT NOT NULL DEFAULT '', -- 显示名称（自动从QQ API获取）
            appid TEXT NOT NULL UNIQUE,
            secret TEXT NOT NULL,
            bot_name TEXT DEFAULT '',
            bot_avatar TEXT DEFAULT '',
            enabled INTEGER DEFAULT 1,
            last_login REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id          TEXT PRIMARY KEY,          -- group_openid 或 user_openid
            name        TEXT NOT NULL DEFAULT '',  -- 群名 / 用户名
            type        TEXT NOT NULL DEFAULT 'group',  -- 'group' | 'direct'
            account_id  TEXT DEFAULT '',           -- 所属账号 ID
            avatar_url  TEXT DEFAULT '',
            last_message TEXT DEFAULT '',
            last_sender TEXT DEFAULT '',
            last_direction TEXT DEFAULT '',
            last_message_time REAL DEFAULT 0,
            unread_count INTEGER DEFAULT 0,
            pinned      INTEGER DEFAULT 0,         -- 置顶
            muted       INTEGER DEFAULT 0,         -- 消息免打扰（未读气泡灰色）
            hidden      INTEGER DEFAULT 0,         -- 不显示会话（搜索可找回）
            created_at  TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            account_id      TEXT DEFAULT '',          -- 所属账号 ID
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
            ref_idx         TEXT DEFAULT '',      -- 消息引用 ID（用于回复）
            quoted_sender   TEXT DEFAULT '',      -- 引用回复：被引用消息发送人
            quoted_content  TEXT DEFAULT '',      -- 引用回复：被引用消息内容
            quoted_ref_idx  TEXT DEFAULT '',      -- 引用回复：被引用消息的 ref_idx
            quote_thumbs    TEXT DEFAULT '',      -- 引用回复：缩略图 JSON
            timestamp       TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_msg_conv  ON messages(conversation_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_conv_time ON conversations(last_message_time DESC);
        CREATE INDEX IF NOT EXISTS idx_conv_account ON conversations(account_id);
        CREATE INDEX IF NOT EXISTS idx_msg_account ON messages(account_id);
    """)
    # 迁移：旧库补新列
    cols = {r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()}
    for col, ddl in (
        ("pinned", "ALTER TABLE conversations ADD COLUMN pinned INTEGER DEFAULT 0"),
        ("muted",  "ALTER TABLE conversations ADD COLUMN muted INTEGER DEFAULT 0"),
        ("hidden", "ALTER TABLE conversations ADD COLUMN hidden INTEGER DEFAULT 0"),
        # 群信息（QQ API /v2/groups/{id}/info 获取，TTL 缓存）
        ("user_note",       "ALTER TABLE conversations ADD COLUMN user_note TEXT DEFAULT ''"),
        ("official_name",   "ALTER TABLE conversations ADD COLUMN official_name TEXT DEFAULT ''"),
        ("member_num",      "ALTER TABLE conversations ADD COLUMN member_num INTEGER DEFAULT 0"),
        ("group_memo",      "ALTER TABLE conversations ADD COLUMN group_memo TEXT DEFAULT ''"),
        ("group_class",     "ALTER TABLE conversations ADD COLUMN group_class TEXT DEFAULT ''"),
        ("group_tags",      "ALTER TABLE conversations ADD COLUMN group_tags TEXT DEFAULT '[]'"),
        # 机器人在群内身份（QQ API /v2/groups/{id}/bot_state 获取：member/owner/admin）
        ("bot_role",        "ALTER TABLE conversations ADD COLUMN bot_role TEXT DEFAULT ''"),
        # 机器人主动消息权限（allow_proactive_msg：1/0，-1=尚未获取）+ 收消息设置（recv_msg_setting：all/only_mention/mention_and_context）
        ("proactive_msg",   "ALTER TABLE conversations ADD COLUMN proactive_msg INTEGER DEFAULT -1"),
        ("recv_setting",    "ALTER TABLE conversations ADD COLUMN recv_setting TEXT DEFAULT ''"),
        ("info_updated_at", "ALTER TABLE conversations ADD COLUMN info_updated_at REAL DEFAULT 0"),
        # 多账号支持：account_id 字段
        ("account_id",      "ALTER TABLE conversations ADD COLUMN account_id TEXT DEFAULT ''"),
    ):
        if col not in cols:
            conn.execute(ddl)
    
    # 迁移：messages 表添加 account_id 字段
    cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)").fetchall()}
    if "account_id" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN account_id TEXT DEFAULT ''")
    
    conn.commit()
    conn.close()


def conv_display_name(row: dict) -> str:
    """显示名优先级：用户备注 > QQ 官方群名 > 旧名 > 默认名"""
    return (row.get("user_note") or row.get("official_name") or row.get("name")
            or f"群聊 {str(row.get('id', ''))[:10]}")


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


async def maybe_update_direct_name(conv_id: str, name: str) -> None:
    """私聊收到消息时自动刷新会话名：仅当 user_note 为空（用户没手动备注过）时更新 name，
    不动 user_note，这样下次仍可继续自动刷新；用户手动备注后即停止自动覆盖"""
    def _do():
        conn = get_db()
        r = conn.execute("SELECT user_note FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if r and not (r["user_note"] or "").strip():
            conn.execute("UPDATE conversations SET name = ? WHERE id = ?", (name, conv_id))
            conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def rename_conversation(conv_id: str, name: str) -> None:
    """强制重命名会话（用户手动设置备注）。name 同时写 user_note，显示时备注优先于官方群名"""
    def _do():
        conn = get_db()
        conn.execute("UPDATE conversations SET name = ?, user_note = ? WHERE id = ?", (name, name, conv_id))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def set_group_info(
    conv_id: str,
    official_name: str,
    member_num: int,
    memo: str = "",
    class_text: str = "",
    tags: list = None,
    bot_role: str = None,
    proactive_msg: int = None,
    recv_setting: str = None,
) -> None:
    """写入 QQ API 获取的群基本信息（群名/人数/简介/分类/标签/机器人身份），不覆盖用户备注和旧 name。
    bot_role/proactive_msg/recv_setting 为 None 表示接口未取到，保持库中原值"""
    import json as _json
    if not isinstance(tags, list):
        tags = []
    tags_str = _json.dumps(tags, ensure_ascii=False)
    def _do():
        conn = get_db()
        conn.execute(
            """UPDATE conversations
               SET official_name = ?, member_num = ?, group_memo = ?, group_class = ?,
                   group_tags = ?, bot_role = COALESCE(?, bot_role),
                   proactive_msg = COALESCE(?, proactive_msg),
                   recv_setting = COALESCE(?, recv_setting),
                   info_updated_at = ?
               WHERE id = ?""",
            (official_name or "", int(member_num or 0), memo or "", class_text or "",
             tags_str, bot_role, proactive_msg, recv_setting, _time.time(), conv_id),
        )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def set_bot_state(conv_id: str, state: dict) -> None:
    """单独写入机器人在群内状态（bot_state：身份/主动消息权限/收消息设置），不碰群信息缓存时间"""
    if not state:
        return
    role = (state.get("member_role") or "").strip()
    proactive = int(bool(state.get("allow_proactive_msg")))
    recv = (state.get("recv_msg_setting") or "").strip()
    def _do():
        conn = get_db()
        conn.execute(
            "UPDATE conversations SET bot_role = ?, proactive_msg = ?, recv_setting = ? WHERE id = ?",
            (role, proactive, recv, conv_id),
        )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def get_group_convs_stale(stale_after: float = 24 * 3600) -> list[dict]:
    """返回群信息已过期（超过 stale_after 秒未更新）的群会话，用于后台定时刷新。
    任一关键字段为空（从未成功获取 / 旧版本只存了部分字段）也视为不完整，每轮重试直到刷出完整数据"""
    def _do():
        conn = get_db()
        rows = conn.execute("""
            SELECT id, type, official_name, member_num, group_memo, info_updated_at
            FROM conversations
            WHERE type = 'group'
              AND (info_updated_at < ?
                   OR official_name = ''
                   OR member_num = 0
                   OR group_memo = ''
                   OR bot_role = ''
                   OR recv_setting = '')
            ORDER BY info_updated_at ASC
        """, (_time.time() - stale_after,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_do)


async def get_admin_group_ids() -> list[str]:
    """返回机器人为群管理员/群主的群会话 id（bot_role ∈ admin/owner），加群申请轮询用"""
    def _do():
        conn = get_db()
        rows = conn.execute("""
            SELECT id FROM conversations
            WHERE type = 'group' AND bot_role IN ('admin', 'owner')
        """).fetchall()
        conn.close()
        return [r["id"] for r in rows]
    return await asyncio.to_thread(_do)


async def delete_conversation(conv_id: str) -> None:
    """删除整个会话及其全部消息（messages 外键级联删除）"""
    def _do():
        conn = get_db()
        conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
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


async def get_conversations(limit: int = 50, include_hidden: bool = False) -> list[dict]:
    def _do():
        conn = get_db()
        rows = conn.execute("""
            SELECT id, name, type, avatar_url, last_message, last_sender, last_direction,
                   unread_count, pinned, muted, hidden,
                   user_note, official_name, member_num, group_memo, group_class, group_tags, bot_role,
                   proactive_msg, recv_setting, info_updated_at,
                   datetime(last_message_time) as last_time
            FROM conversations
            {where}
            ORDER BY pinned DESC, last_message_time DESC
            LIMIT ?
        """.format(where="" if include_hidden else "WHERE hidden = 0"), (limit,)).fetchall()
        conn.close()
        convs = [dict(r) for r in rows]
        for c in convs:
            c["display_name"] = conv_display_name(c)
        return convs
    return await asyncio.to_thread(_do)


async def set_conversation_flags(conv_id: str, pinned=None, muted=None, hidden=None, avatar=None) -> None:
    """更新会话状态字段（置顶 / 免打扰 / 隐藏 / 群头像），只更新传了的值"""
    sets, args = [], []
    for col, val in (("pinned", pinned), ("muted", muted), ("hidden", hidden)):
        if val is not None:
            sets.append(f"{col} = ?")
            args.append(1 if val else 0)
    if avatar is not None:
        sets.append("avatar_url = ?")
        args.append(avatar)
    if not sets:
        return
    args.append(conv_id)
    def _do():
        conn = get_db()
        conn.execute(f"UPDATE conversations SET {', '.join(sets)} WHERE id = ?", args)
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def get_conversation(conv_id: str) -> Optional[dict]:
    def _do():
        conn = get_db()
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        conn.close()
        if not row:
            return None
        d = dict(row)
        d["display_name"] = conv_display_name(d)
        return d
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
    quote_thumbs: str = "",
    ref_idx: str = "",
    quoted_ref_idx: str = "",
) -> dict:
    def _do():
        conn = get_db()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        # 先确保会话存在（否则 messages 外键约束失败）
        if conn.execute("SELECT COUNT(*) FROM conversations WHERE id = ?", (conversation_id,)).fetchone()[0] == 0:
            conn.execute("""
                INSERT INTO conversations (id, name, type)
                VALUES (?, ?, ?)
            """, (conversation_id, conversation_id, "group"))
        cur = conn.execute("""
            INSERT INTO messages (conversation_id, sender_openid, sender_name,
                                  sender_avatar, content, msg_type, direction, msg_id, attachments, member_role,
                                  quoted_sender, quoted_content, quote_thumbs, ref_idx, quoted_ref_idx, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (conversation_id, sender_openid, sender_name, sender_avatar, content, msg_type, direction, msg_id, attachments, member_role, quoted_sender, quoted_content, quote_thumbs, ref_idx, quoted_ref_idx, now))
        msg_pk = cur.lastrowid

        # 更新会话摘要（转发消息预览统一为 [聊天记录]）
        conn.execute("""
            UPDATE conversations
            SET last_message = ?,
                last_sender = ?,
                last_direction = ?,
                last_message_time = julianday('now')
            WHERE id = ?
        """, (_conv_preview(content)[:200], sender_name, direction, conversation_id))

        conn.commit()
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_pk,)).fetchone()
        conn.close()
        return dict(row)
    return await asyncio.to_thread(_do)


def _conv_preview(content: str) -> str:
    """会话列表预览归一化：合并转发（聊天记录）消息统一显示为 [聊天记录]"""
    if content and (content.startswith("[群聊的聊天记录]") or content.startswith("[好友的聊天记录]")):
        return "[聊天记录]"
    return content


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


async def search_messages(q: str, limit: int = 50, conv_id: str = "") -> list[dict]:
    """搜索消息内容（conv_id 为空则全局），返回带会话名的结果（按时间倒序）"""
    def _do():
        conn = get_db()
        sql = """
            SELECT m.id, m.conversation_id, c.name AS conv_name, c.user_note, c.official_name,
                   m.sender_name, m.sender_avatar, m.content, m.msg_type, m.direction, m.timestamp
            FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
            WHERE (m.content LIKE ? OR m.sender_name LIKE ? OR m.attachments LIKE ?) AND m.recalled = 0
        """
        args: list = [f"%{q}%"] * 3
        if conv_id:
            sql += " AND m.conversation_id = ?"
            args.append(conv_id)
        sql += " ORDER BY m.id DESC LIMIT ?"
        args.append(limit)
        rows = conn.execute(sql, args).fetchall()
        conn.close()
        results = []
        for r in rows:
            d = dict(r)
            d["conv_name"] = conv_display_name(d)
            results.append(d)
        return results
    return await asyncio.to_thread(_do)


async def get_all_messages(conv_id: str) -> list[dict]:
    """导出用：取会话全部消息（按时间正序）"""
    def _do():
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC", (conv_id,)
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_do)


async def get_stats() -> dict:
    """会话数据统计：今日收发、活跃群 TOP5、近7天趋势/小时分布/媒体分布/引用、会话参与度"""
    def _do():
        conn = get_db()
        WEEK = "timestamp >= datetime('now', 'localtime', '-6 days')"
        today = conn.execute("""
            SELECT direction, COUNT(*) AS cnt FROM messages
            WHERE date(timestamp) = date('now', 'localtime')
            GROUP BY direction
        """).fetchall()
        top = conn.execute(f"""
            SELECT c.name AS name, c.user_note, c.official_name, c.id AS conv_id, COUNT(*) AS cnt
            FROM messages m
            LEFT JOIN conversations c ON c.id = m.conversation_id
            WHERE m.{WEEK}
            GROUP BY m.conversation_id
            ORDER BY cnt DESC LIMIT 5
        """).fetchall()
        total = conn.execute("SELECT COUNT(*) AS cnt FROM messages").fetchone()["cnt"]
        # 近 7 天每日趋势
        trend = conn.execute(f"""
            SELECT date(timestamp) AS d, COUNT(*) AS cnt FROM messages
            WHERE {WEEK}
            GROUP BY d ORDER BY d
        """).fetchall()
        # 近 7 天 24 小时分布
        hourly = conn.execute(f"""
            SELECT CAST(strftime('%H', timestamp) AS INTEGER) AS h, COUNT(*) AS cnt FROM messages
            WHERE {WEEK}
            GROUP BY h
        """).fetchall()
        # 近 7 天「星期×小时」热力图（strftime('%w')：周日=0 … 周六=6）
        heatmap = conn.execute(f"""
            SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
                   CAST(strftime('%H', timestamp) AS INTEGER) AS hr,
                   COUNT(*) AS cnt
            FROM messages WHERE {WEEK}
            GROUP BY dow, hr
        """).fetchall()
        hm = {}
        for r in heatmap:
            hm.setdefault(r["dow"], {})[r["hr"]] = r["cnt"]
        # 近 7 天媒体分布（attachments JSON 文本匹配）
        media = {}
        for key, pat in (
            ("image", '%"content_type": "image/%'),
            ("video", '%"content_type": "video/%'),
            ("voice", '%"content_type": "voice"%'),
            ("file",  '%"content_type": "file"%'),
        ):
            media[key] = conn.execute(
                f"SELECT COUNT(*) AS cnt FROM messages WHERE {WEEK} AND attachments LIKE ?", (pat,)
            ).fetchone()["cnt"]
        # 近 7 天引用回复数
        quoted = conn.execute(
            f"SELECT COUNT(*) AS cnt FROM messages WHERE {WEEK} AND quoted_ref_idx != ''"
        ).fetchone()["cnt"]
        # 近 7 天发言达人 TOP5（按成员昵称聚合）
        senders = conn.execute(f"""
            SELECT sender_name AS name, COUNT(*) AS cnt, MAX(sender_avatar) AS avatar
            FROM messages
            WHERE {WEEK} AND direction = 'incoming' AND sender_name != ''
            GROUP BY sender_name
            ORDER BY cnt DESC LIMIT 5
        """).fetchall()
        # 会话参与度
        total_convs = conn.execute("SELECT COUNT(*) AS cnt FROM conversations").fetchone()["cnt"]
        active_convs = conn.execute(
            f"SELECT COUNT(DISTINCT conversation_id) AS cnt FROM messages WHERE {WEEK}"
        ).fetchone()["cnt"]
        conn.close()
        stats = {"incoming": 0, "outgoing": 0}
        for r in today:
            stats[r["direction"]] = r["cnt"]
        return {
            "today": stats,
            "total": total,
            "top_convs": [
                {"name": conv_display_name(dict(r)) or r["conv_id"], "conv_id": r["conv_id"], "count": r["cnt"]}
                for r in top
            ],
            "top_senders": [
                {"name": r["name"], "count": r["cnt"], "avatar": r["avatar"]} for r in senders
            ],
            "trend": [{"d": r["d"], "count": r["cnt"]} for r in trend],
            "hourly": {r["h"]: r["cnt"] for r in hourly},
            "heatmap": hm,
            "media": media,
            "quoted": quoted,
            "convs": {"total": total_convs, "active": active_convs},
        }
    return await asyncio.to_thread(_do)


async def get_messages_around(conv_id: str, target_id: int, limit: int = 50) -> list[dict]:
    """以某条消息为中心加载上下窗口（id 自增与时间顺序一致）"""
    def _do():
        conn = get_db()
        half = max(limit // 2, 1)
        rows = conn.execute("""
            SELECT * FROM messages
            WHERE conversation_id = ? AND id BETWEEN ? AND ?
            ORDER BY id ASC
        """, (conv_id, target_id - half, target_id + half)).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_do)


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
                    (_conv_preview(latest["content"])[:200], latest["sender_name"], latest["direction"], conv_id),
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
                (_conv_preview(latest["content"])[:200], latest["sender_name"], latest["direction"], conv_id),
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


# ── 账号操作 ──────────────────────────────────────────────

async def add_account(appid: str, secret: str, bot_name: str = "", bot_avatar: str = "") -> dict:
    """添加新账号"""
    def _do():
        conn = get_db()
        # 检查是否已存在
        existing = conn.execute("SELECT id FROM accounts WHERE appid = ?", (appid,)).fetchone()
        if existing:
            # 更新 secret 和登录时间
            conn.execute(
                "UPDATE accounts SET secret = ?, last_login = ? WHERE appid = ?",
                (secret, _time.time(), appid)
            )
        else:
            conn.execute(
                "INSERT INTO accounts (id, name, appid, secret, bot_name, bot_avatar, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (appid, bot_name or appid, appid, secret, bot_name, bot_avatar, _time.time())
            )
        conn.commit()
        # 返回账号信息
        row = conn.execute("SELECT * FROM accounts WHERE appid = ?", (appid,)).fetchone()
        conn.close()
        return dict(row) if row else {"id": appid, "appid": appid}
    return await asyncio.to_thread(_do)


async def get_account(appid: str) -> Optional[dict]:
    """获取单个账号"""
    def _do():
        conn = get_db()
        row = conn.execute("SELECT * FROM accounts WHERE appid = ?", (appid,)).fetchone()
        conn.close()
        return dict(row) if row else None
    return await asyncio.to_thread(_do)


async def get_all_accounts() -> list[dict]:
    """获取所有账号"""
    def _do():
        conn = get_db()
        rows = conn.execute("SELECT * FROM accounts ORDER BY last_login DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_do)


async def delete_account(appid: str) -> bool:
    """删除账号"""
    def _do():
        conn = get_db()
        conn.execute("DELETE FROM accounts WHERE appid = ?", (appid,))
        conn.commit()
        conn.close()
        return True
    return await asyncio.to_thread(_do)


async def update_account_info(appid: str, bot_name: str = None, bot_avatar: str = None) -> None:
    """更新账号信息（机器人名称和头像）"""
    def _do():
        conn = get_db()
        if bot_name is not None:
            conn.execute("UPDATE accounts SET bot_name = ?, name = ? WHERE appid = ?", (bot_name, bot_name, appid))
        if bot_avatar is not None:
            conn.execute("UPDATE accounts SET bot_avatar = ? WHERE appid = ?", (bot_avatar, appid))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)


async def update_account_last_login(appid: str) -> None:
    """更新账号最后登录时间"""
    def _do():
        conn = get_db()
        conn.execute("UPDATE accounts SET last_login = ? WHERE appid = ?", (_time.time(), appid))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_do)
