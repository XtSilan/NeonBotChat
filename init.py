# -*- coding: utf-8 -*-
"""
NeonBotChat — 带 WebUI 的 QQ 机器人接管面板
=============================================
启动方式:
    python init.py

功能:
    - WebUI (http://127.0.0.1:8080) 查看消息、手动接管发送
    - 自动将 QQ 群消息转发到 WebUI
    - 消息历史本地持久化 (SQLite)
"""
import asyncio
import os
import sys
import threading
import logging as std_logging

import botpy
from botpy import logging as botpy_logging
from botpy.ext.cog_yaml import read
from botpy.message import GroupMessage, Message

from PatchMsg import (
    _ensure_group_message_create_parser,
    clean_group_message_content,
    is_bot_mentioned,
    is_author_bot,
    get_raw_attachments,
    get_username,
    get_msg_type,
    get_msg_elements,
)
from PatchActiveMsg import send_group_msg
from PatchUserInfo import getUserName, replace_mentions_with_names

# ═══════════════════════════════════════════════════
# 配置
# ═══════════════════════════════════════════════════

_config_path = os.path.join(os.path.dirname(__file__), "config.yaml")
if not os.path.isfile(_config_path):
    # 兼容 PatchActiveMsg 里读 configs/config.yaml 的路径
    _alt = os.path.join(os.path.dirname(__file__), "configs", "config.yaml")
    if os.path.isfile(_alt):
        _config_path = _alt

config = read(_config_path)
APP_ID = config["appid"]
CLIENT_SECRET = config["secret"]

_log = botpy_logging.get_logger("NeonBotChat")

# 延迟导入 Web 层（确保数据库先初始化）
# 这里只是声明，实际在 main() 里导入

# ═══════════════════════════════════════════════════
# 补丁：注册 GROUP_MESSAGE_CREATE 解析器
# ═══════════════════════════════════════════════════
_ensure_group_message_create_parser()


# ═══════════════════════════════════════════════════
# Bot 客户端
# ═══════════════════════════════════════════════════

class MyClient(botpy.Client):
    """NeonBot 客户端 —— 接收消息并转发到 WebUI"""

    async def on_ready(self):
        import database, time
        database.bot_name = self.robot.name
        database.bot_start_time = time.time()
        _log.info(f"🤖 robot 「{self.robot.name}」 on_ready!")

    async def on_group_message_create(self, message: GroupMessage):
        """
        收到群消息 → 入库 → 推送到 WebUI
        （由 PatchMsg 补丁解析 GROUP_MESSAGE_CREATE 事件）
        """
        await self._handle_group_message(message)

    async def on_group_at_message_create(self, message: GroupMessage):
        """
        收到 @机器人 的群消息
        """
        await self._handle_group_message(message, at_received=True)

    async def _handle_group_message(self, message: GroupMessage, at_received: bool = False):
        """统一处理群消息"""
        try:
            from database import save_message, upsert_conversation
            from web_server import push_bot_message

            group_id = getattr(message, "group_openid", "") or message.group_openid
            author = getattr(message, "author", None)
            # 尝试多种可能的属性名获取用户 ID
            author_id = ""
            if author:
                for attr in ("id", "user_id", "member_openid", "user_openid"):
                    val = getattr(author, attr, None)
                    if val:
                        author_id = val
                        break
                if not author_id:
                    _log.warning(f"[author] 未知结构: type={type(author).__name__} attrs={[a for a in dir(author) if not a.startswith('_')]}")
            author_name = ""  # 后面异步获取

            content = getattr(message, "content", "") or ""

            # 提取附件（优先用原始 JSON，botpy 可能丢失 voice_wav_url 等字段）
            msg_id_for_att = getattr(message, "id", "") or ""
            raw_attachments = get_raw_attachments(msg_id_for_att)

            # 引用回复消息：提取被引用消息的内容
            quoted_sender = ""
            quoted_content = ""
            msg_type_raw = get_msg_type(msg_id_for_att)
            if msg_type_raw == 103:
                elements = get_msg_elements(msg_id_for_att)
                if elements:
                    quoted_content = elements[0].get("content", "")
                    # 尝试从本地 DB 反查被引用消息的发件人
                    if quoted_content:
                        try:
                            import sqlite3, os as _os
                            qconn = sqlite3.connect(_os.path.join(_os.path.dirname(__file__), "neonbot.db"))
                            qconn.row_factory = sqlite3.Row
                            qrow = qconn.execute(
                                "SELECT sender_name FROM messages WHERE conversation_id=? AND content=? ORDER BY id DESC LIMIT 1",
                                (group_id, quoted_content)
                            ).fetchone()
                            qconn.close()
                            if qrow:
                                quoted_sender = qrow["sender_name"] or ""
                        except Exception:
                            pass
            if not raw_attachments:
                # 降级：从 botpy 对象取
                for src in ("attachments", "data", "_data"):
                    obj = getattr(message, src, None)
                    if obj is None:
                        continue
                    if isinstance(obj, dict):
                        raw_attachments = obj.get("attachments", [])
                    elif hasattr(obj, "attachments"):
                        raw_attachments = obj.attachments or []
                    elif isinstance(obj, list):
                        raw_attachments = obj
                    if raw_attachments:
                        break
            # 归一化
            import json as _json
            norm_attachments = []
            for a in raw_attachments:
                if isinstance(a, dict):
                    norm_attachments.append(a)
                elif hasattr(a, "__dict__"):
                    norm_attachments.append({k: v for k, v in a.__dict__.items() if not k.startswith("_")})
            attachments_json = _json.dumps(norm_attachments, ensure_ascii=False)

            # 跳过 Bot 自己发出去的消息回显
            # 双重判断：author.bot=True 且内容匹配最近发出的消息
            msg_id = getattr(message, "id", "") or ""
            from database import is_echo
            if is_author_bot(msg_id) and is_echo(group_id, content):
                _log.debug("[去重] 跳过 Bot 回显: %s", content[:40])
                return

            # 处理表情标记
            import re as _re
            has_face6 = _re.search(r'<faceType=6,[^>]*>', content)
            content = _re.sub(r'<faceType=1,[^>]*>', '[表情符号]', content)
            content = _re.sub(r'<faceType=6,[^>]*>', '', content)

            # 将 <@OpenID> 替换为 @昵称
            mentions = getattr(message, "mentions", None) or []
            display_content = await replace_mentions_with_names(APP_ID, content)
            # 如果 replace 没生效（API 挂了等），退而用 clean 版本
            if display_content == content:
                display_content = clean_group_message_content(content, mentions)

            # 获取发送者昵称：优先 JSON 里的 username，没有则调第三方 API
            author_name = get_username(msg_id_for_att)
            if not author_name and author_id:
                try:
                    author_name = await getUserName(APP_ID, author_id)
                except Exception:
                    author_name = author_id[:8] if author_id else ""

            # 标记机器人用户（从原始 JSON 提取，botpy 的 GroupMessage 不暴露 bot 字段）
            msg_id = getattr(message, "id", "") or ""
            if is_author_bot(msg_id) and author_name:
                author_name = f"{author_name} 🤖"
            from PatchMsg import get_member_role
            member_role = get_member_role(msg_id)
            # 统一角色名
            if member_role == "owner":
                member_role = "群主"
            elif member_role == "admin":
                member_role = "管理员"

            # 确保会话存在
            group_name = f"群聊 {group_id[:8]}"  # 默认名，后面可以优化
            await upsert_conversation(group_id, name=group_name, conv_type="group")

            # 保存消息
            # 判断附件类型
            has_image = any(a.get("content_type", "").startswith("image/") for a in norm_attachments)
            has_video = any(a.get("content_type", "").startswith("video/") for a in norm_attachments)
            has_voice = any(a.get("content_type", "") == "voice" for a in norm_attachments)
            has_file = any(a.get("content_type", "") == "file" for a in norm_attachments)
            if not display_content.strip():
                if has_image and has_face6:
                    display_content = "[表情]"
                elif has_image:
                    display_content = "[图片]"
                elif has_video:
                    display_content = "[视频]"
                elif has_voice:
                    display_content = "[语音]"
                elif has_file:
                    fn = next((a.get("filename", "") for a in norm_attachments if a.get("content_type") == "file"), "文件")
                    display_content = f"[文件] {fn}"
                elif norm_attachments:
                    display_content = "[富媒体文件]"
                else:
                    display_content = "[富媒体文件]"

            avatar_url = f"https://q.qlogo.cn/qqapp/{APP_ID}/{author_id}/100" if author_id else ""
            saved = await save_message(
                conversation_id=group_id,
                sender_openid=author_id,
                sender_name=author_name or f"用户{author_id[:6] if author_id else '???'}",
                content=display_content,
                direction="incoming",
                msg_id=getattr(message, "id", "") or "",
                msg_type=getattr(message, "message_type", 0) or 0,
                sender_avatar=avatar_url,
                attachments=attachments_json,
                member_role=member_role,
                quoted_sender=quoted_sender,
                quoted_content=quoted_content,
            )

            # 补上 @信息
            if at_received and display_content:
                saved["is_at"] = True
            if is_bot_mentioned(mentions):
                saved["is_at"] = True

            # 推送到 WebUI
            push_bot_message({"type": "new_message", "data": saved})

            _log.debug(
                "[群消息] group=%s author=%s content=%s",
                group_id, author_name or author_id, display_content[:50],
            )

        except Exception as e:
            _log.error(f"[_handle_group_message] {e}", exc_info=True)


def run_bot():
    """在独立线程中运行 bot（botpy 自带事件循环）"""
    # ⚠️ 必须先创建事件循环，botpy.Client.__init__ 里会调 asyncio.get_event_loop()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    intents = botpy.Intents(public_messages=True)
    client = MyClient(intents=intents)

    try:
        # botpy.Client.run() 内部调用 asyncio.run() ——
        # 但我们已经在事件循环里了，所以直接调 start()
        loop.run_until_complete(
            client.start(appid=APP_ID, secret=CLIENT_SECRET)
        )
    except KeyboardInterrupt:
        _log.info("Bot 线程收到中断信号")
    except Exception as e:
        _log.error(f"Bot 线程异常: {e}", exc_info=True)
    finally:
        loop.close()


# ═══════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════

async def main():
    """启动 Web 服务器 + Bot 线程"""
    import uvicorn
    from database import init_db
    from web_server import app, pump_bot_messages

    # 1) 初始化数据库
    print("[NeonBot] 初始化数据库…")
    init_db()
    print("[NeonBot] 数据库就绪 ✓")

    # 2) 启动 bot 线程
    print(f"[NeonBot] 启动 Bot (AppID={APP_ID})…")
    bot_thread = threading.Thread(target=run_bot, name="qqbot", daemon=True)
    bot_thread.start()
    print("[NeonBot] Bot 线程已启动 ✓")

    # 3) 启动消息泵（后台任务，转发 bot 消息到 WebSocket）
    asyncio.create_task(pump_bot_messages())

    # 4) 启动 Web 服务器
    webui_port = int(config.get("webui-port", 8080))
    webui_host = "0.0.0.0" if config.get("enable-public", False) else "127.0.0.1"
    # 密码保护
    pwd = config.get("webui-password", "").strip()
    if pwd:
        import web_server
        web_server.WEBUI_PASSWORD = pwd
        print(f"[NeonBot] WebUI 密码保护已启用")
    print(f"[NeonBot] WebUI → http://{webui_host}:{webui_port}")
    config_obj = uvicorn.Config(
        app,
        host=webui_host,
        port=webui_port,
        log_level="info",
        access_log=False,
    )
    server = uvicorn.Server(config_obj)
    await server.serve()


if __name__ == "__main__":
    # Windows 下 asyncio 兼容
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[NeonBot] 已退出")
