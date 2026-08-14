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
import time as _time
import threading
import logging as std_logging

import botpy
from botpy import logging as botpy_logging
from botpy.ext.cog_yaml import read
from botpy.message import GroupMessage, Message, C2CMessage

from PatchMsg import (
    _ensure_group_message_create_parser,
    _ensure_group_join_request_parser,
    clean_group_message_content,
    is_bot_mentioned,
    is_author_bot,
    get_raw_attachments,
    get_username,
    get_msg_type,
    get_msg_elements,
    get_msg_ref_idx,
    get_ref_msg_idx,
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

# 日志文件统一写入 logs/ 目录（不再散落根目录）
import logging as _std_logging
from logging.handlers import TimedRotatingFileHandler as _TRFH
_log_dir = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(_log_dir, exist_ok=True)
botpy_logging.configure_logging(
    ext_handlers=[{
        "handler": _TRFH,
        "filename": os.path.join(_log_dir, "%(name)s.log"),
        "when": "D",
        "backupCount": 7,
        "encoding": "utf-8",
        "format": "%(asctime)s\t[%(levelname)s]\t(%(filename)s:%(lineno)s)%(funcName)s\t%(message)s",
        "level": _std_logging.INFO,
    }],
    force=True,
)

# 日志环形缓冲（供 WebUI「日志」页读取，保留最近 500 条）
from LogBuffer import install as install_log_buffer
install_log_buffer()

# 延迟导入 Web 层（确保数据库先初始化）
# 这里只是声明，实际在 main() 里导入

# ═══════════════════════════════════════════════════
# 补丁：注册 GROUP_MESSAGE_CREATE 解析器
# ═══════════════════════════════════════════════════
_ensure_group_message_create_parser()
_ensure_group_join_request_parser()  # GROUP_JOIN_REQUEST 事件解析（加群申请）


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

    async def on_c2c_message_create(self, message: C2CMessage):
        """收到私聊消息 → 入库 → 推送到 WebUI"""
        await self._handle_c2c_message(message)

    async def on_group_join_request(self, data: dict):
        """收到加群申请事件（GROUP_JOIN_REQUEST，数据为原始 dict）→ 去重 → 广播到 WebUI"""
        try:
            from web_server import push_bot_message, mark_join_request_seen, join_request_pending
            gid = (data or {}).get("group_openid") or ""
            rid = (data or {}).get("join_request_id") or ""
            if gid and rid:
                mark_join_request_seen(gid, rid)  # 幂等：轮询不再重复广播
                join_request_pending.setdefault(gid, set()).add(rid)  # 徽章计数
            push_bot_message({"type": "join_request", "data": data or {}})
        except Exception as e:
            _log.warning(f"[JOIN_REQUEST] 事件处理异常: {e}")

    async def _handle_c2c_message(self, message: C2CMessage) -> None:
        """统一处理私聊消息"""
        try:
            from database import save_message, upsert_conversation, is_echo, maybe_update_direct_name
            from web_server import push_bot_message

            # 发送者 user_openid
            user_id = ""
            author = getattr(message, "author", None)
            if author:
                user_id = getattr(author, "user_openid", "") or ""
            if not user_id:
                user_id = getattr(message, "user_openid", "") or ""
            if not user_id:
                _log.warning("[C2C] 缺少 user_openid，跳过")
                return

            content = getattr(message, "content", "") or ""
            msg_id = getattr(message, "id", "") or ""

            # 去重：Bot 自己发的回显
            if is_author_bot(msg_id) and is_echo(user_id, content):
                _log.debug("[C2C去重] 跳过回显: %s", content[:40])
                return

            # 处理表情标记（与群聊一致）
            import re as _re
            content = _re.sub(r'<faceType=1,[^>]*>', '[表情符号]', content)
            content = _re.sub(r'<faceType=6,[^>]*>', '', content)

            # 附件归一化（botpy 原生 attachments 对象列表）
            import json as _json
            norm_attachments = []
            for a in (getattr(message, "attachments", None) or []):
                if isinstance(a, dict):
                    norm_attachments.append(a)
                elif hasattr(a, "__dict__"):
                    norm_attachments.append({k: v for k, v in a.__dict__.items() if not k.startswith("_")})
            attachments_json = _json.dumps(norm_attachments, ensure_ascii=False)

            # 创建/更新私聊会话
            await upsert_conversation(user_id, name=f"私聊 {user_id[:10]}", conv_type="direct")

            # 自动刷新对方最新昵称/头像（带缓存），会话名仅在未手动备注时更新
            from PatchUserInfo import getUserNameCached, buildAvatarUrl
            try:
                dm_name = await getUserNameCached(APP_ID, user_id)
                if dm_name:
                    await maybe_update_direct_name(user_id, dm_name)
            except Exception:
                dm_name = ""
            dm_avatar = buildAvatarUrl(APP_ID, user_id)

            saved = await save_message(
                conversation_id=user_id,
                sender_openid=user_id,
                sender_name=dm_name,
                sender_avatar=dm_avatar,
                content=content,
                direction="incoming",
                msg_id=msg_id,
                msg_type=getattr(message, "message_type", 0) or 0,
                attachments=attachments_json,
            )
            saved["conv_type"] = "direct"
            push_bot_message({"type": "new_message", "data": saved})
            _log.info("📥 收到私聊 %s 的消息: %s", user_id, content[:50] or "[附件消息]")
        except Exception as e:
            _log.warning("[C2C] 处理失败: %s", e, exc_info=True)

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
            # （按 ref_msg_idx 引用标记判断，而非 msg_type==103——QQ 现在引用消息 msg_type 可能是 0）
            quoted_sender = ""
            quoted_content = ""
            quote_thumbs_str = ""
            if get_ref_msg_idx(msg_id_for_att):
                elements = get_msg_elements(msg_id_for_att)
                # 优先通过 ref_msg_idx 反查本地 DB
                qmsg_content = ""
                qelem_media = None  # 被引用富媒体（msg_elements 里的 image/video url）
                if elements:
                    # msg_elements[0] 可能是嵌套结构，递归提取文本字段
                    def _extract_elem_text(elem):
                        if isinstance(elem, str):
                            return elem.strip()
                        if isinstance(elem, dict):
                            for k in ("text", "content", "desc", "description", "title", "message", "msg"):
                                v = elem.get(k)
                                if isinstance(v, str) and v.strip():
                                    return v.strip()
                                if isinstance(v, dict):
                                    r = _extract_elem_text(v)
                                    if r:
                                        return r
                        return ""
                    qmsg_content = _extract_elem_text(elements[0])
                    # 被引用消息是富媒体时元素无文本，直接取 url 作缩略图
                    if not qmsg_content and isinstance(elements[0], dict):
                        _t = elements[0].get("type", "")
                        _u = elements[0].get("url", "")
                        if _u and _t in ("image", "video"):
                            qmsg_content = "[图片]" if _t == "image" else "[视频]"
                            qelem_media = [{"url": _u, "type": "image" if _t == "image" else "video"}]
                import sqlite3 as _sq, os as _os
                ref_target = get_ref_msg_idx(msg_id_for_att)
                try:
                    qconn = _sq.connect(_os.path.join(_os.path.dirname(__file__), "neonbot.db"))
                    qconn.row_factory = _sq.Row
                    # ref_msg_idx 就是被引用消息的 QQ 消息 ID（msg_id）；旧消息无 msg_idx 时才走 ref_idx 兜底
                    qrow = qconn.execute(
                        "SELECT sender_name, content, attachments FROM messages WHERE conversation_id=? AND msg_id=? ORDER BY id DESC LIMIT 1",
                        (group_id, ref_target)
                    ).fetchone()
                    if not qrow:
                        qrow = qconn.execute(
                            "SELECT sender_name, content, attachments FROM messages WHERE conversation_id=? AND ref_idx=? ORDER BY id DESC LIMIT 1",
                            (group_id, ref_target)
                        ).fetchone()
                    qconn.close()
                    if qrow:
                        quoted_sender = qrow["sender_name"] or ""
                        quoted_content = qrow["content"] or ""
                        # 提取缩略图
                        if qrow["attachments"]:
                            try:
                                import json as _j
                                atts = _j.loads(qrow["attachments"])
                                thumbs = []
                                for a in atts:
                                    ct = a.get("content_type", "")
                                    url = a.get("url", "")
                                    if url and (ct.startswith("image/") or ct.startswith("video/")):
                                        thumbs.append({"url": url, "type": "image" if ct.startswith("image/") else "video"})
                                if thumbs:
                                    quote_thumbs_str = _j.dumps(thumbs, ensure_ascii=False)
                            except Exception:
                                pass
                    elif qelem_media:
                        quoted_content = qmsg_content
                        import json as _j
                        quote_thumbs_str = _j.dumps(qelem_media, ensure_ascii=False)
                    elif qmsg_content and qmsg_content.strip():
                        quoted_content = qmsg_content
                except Exception:
                    if qmsg_content and qmsg_content.strip():
                        quoted_content = qmsg_content
            # QQ API 对「仅引用未输入新文字」的消息 content 为「引用了一条消息」占位：
            # 反查成功时正文由引用标签展示，清掉占位文案（详见下方 display_content 处理）
            quote_placeholder = bool(quoted_content and content.strip() == "引用了一条消息")
            if quote_placeholder:
                content = ""
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
            # Bot 自己发的特殊消息占位回显（卡片/键盘），前端已用真实内容渲染，跳过
            if is_author_bot(msg_id) and (content == "[卡片消息]" or content.startswith("[键盘] ")):
                _log.debug("[去重] 跳过特殊消息占位回显: %s", content[:30])
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

            # 懒刷新群信息（缓存过期才拉 QQ API，去重限速）
            asyncio.create_task(refresh_group_info(group_id))

            # 保存消息
            # 判断附件类型
            has_image = any(a.get("content_type", "").startswith("image/") for a in norm_attachments)
            has_video = any(a.get("content_type", "").startswith("video/") for a in norm_attachments)
            has_voice = any(a.get("content_type", "") == "voice" for a in norm_attachments)
            has_file = any(a.get("content_type", "") == "file" for a in norm_attachments)
            # 纯引用消息（content 是「引用了一条消息」占位且已反查到引用内容）：正文留空，只显示引用标签
            if quote_placeholder:
                display_content = ""
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
                ref_idx=get_msg_ref_idx(msg_id_for_att),
                quoted_sender=quoted_sender,
                quoted_content=quoted_content,
                quote_thumbs=quote_thumbs_str,
                quoted_ref_idx=get_ref_msg_idx(msg_id_for_att),
            )

            # 补上 @信息
            if at_received and display_content:
                saved["is_at"] = True
            if is_bot_mentioned(mentions):
                saved["is_at"] = True

            # 附带会话隐藏状态（前端据此决定是否插入会话列表）
            try:
                from database import get_db as _get_db
                _c = _get_db()
                _r = _c.execute("SELECT hidden FROM conversations WHERE id = ?", (group_id,)).fetchone()
                saved["conversation_hidden"] = bool(_r and _r["hidden"])
                _c.close()
            except Exception:
                saved["conversation_hidden"] = False

            # 推送到 WebUI
            push_bot_message({"type": "new_message", "data": saved})

            _log.debug(
                "[群消息] group=%s author=%s content=%s",
                group_id, author_name or author_id, display_content[:50],
            )

        except Exception as e:
            _log.error(f"[_handle_group_message] {e}", exc_info=True)


# ═══════════════════════════════════════════════════
# 群基本信息后台刷新（/v2/groups/{id}/info，限频 30 QPM）
# ═══════════════════════════════════════════════════

_inflight_group_info: set = set()

# 群信息后台刷新周期：每 30 分钟检查一轮，过期（GROUP_INFO_TTL）的群逐个刷新
GROUP_REFRESH_INTERVAL = 30 * 60


async def refresh_group_info(conv_id: str) -> bool:
    """刷新单个群的官方名称/人数/机器人身份：先查库是否过期，跨线程去重，成功返回 True"""
    from database import get_conversation, set_group_info, GROUP_INFO_TTL
    if conv_id in _inflight_group_info:
        return False
    try:
        conv = await get_conversation(conv_id)
        if not conv or conv.get("type") != "group":
            return False
        # 缓存新鲜且关键字段齐全 → 跳过；任一字段为空（旧数据只存了部分）→ 视为不完整重试
        fresh = _time.time() - (conv.get("info_updated_at") or 0) < GROUP_INFO_TTL
        complete = (conv.get("official_name") and conv.get("member_num")
                    and conv.get("group_memo") and conv.get("bot_role")
                    and conv.get("recv_setting"))
        if fresh and complete:
            return True
        _inflight_group_info.add(conv_id)
        from PatchActiveMsg import get_group_info, get_bot_state
        info = await get_group_info(conv_id)
        state = await get_bot_state(conv_id)
        if info:
            bot_role = (state or {}).get("member_role") or "" if state else None
            proactive_msg = int(bool((state or {}).get("allow_proactive_msg"))) if state else None
            recv_setting = (state or {}).get("recv_msg_setting") or "" if state else None
            await set_group_info(
                conv_id,
                (info.get("group_name") or "").strip(),
                int(info.get("group_member_num") or 0),
                memo=(info.get("group_finger_memo") or "").strip(),
                class_text=(info.get("group_class_text") or "").strip(),
                tags=info.get("group_tags") or [],
                bot_role=bot_role,
                proactive_msg=proactive_msg,
                recv_setting=recv_setting,
            )
            return True
        return False
    except Exception as e:
        _log.error(f"[GROUP_INFO] 刷新失败 {conv_id}: {e}")
        return False
    finally:
        _inflight_group_info.discard(conv_id)


async def _group_info_refresh_loop():
    """常驻定时任务：每轮把已过期的群信息刷一遍（限速 2.5s/个），完成后休眠等待下一轮"""
    from database import get_group_convs_stale
    while True:
        try:
            stale = await get_group_convs_stale()
            if stale:
                _log.info(f"[GROUP_INFO] 后台刷新 {len(stale)} 个群的群信息…")
                for row in stale:
                    await refresh_group_info(row["id"])
                    await asyncio.sleep(2.5)  # 限速（QQ API 30 QPM，留余量）
        except Exception as e:
            _log.warning(f"[GROUP_INFO] 后台刷新任务异常: {e}")
        await asyncio.sleep(GROUP_REFRESH_INTERVAL)  # 两轮之间休眠


async def _join_request_poll_loop():
    """低频轮询兜底：补偿事件丢失/重启期间错过的加群申请。

    每 60s 遍历机器人为管理员/群主的群，拉一次待审批申请列表（限速 2.5s/群），
    与内存 seen 集合比对，新 join_request_id → 广播到 WebUI（与事件路径幂等去重）。
    """
    from database import get_admin_group_ids
    from PatchActiveMsg import get_join_requests
    from web_server import push_bot_message, is_join_request_seen, mark_join_request_seen, join_request_pending
    while True:
        try:
            gids = await get_admin_group_ids()
            for gid in gids:
                reqs = await get_join_requests(gid) or []
                # 重建待审批计数（API 返回即全量待审批；已审批的申请自然消失，<60s 内收敛）
                join_request_pending[gid] = {
                    (r.get("join_request_id") or "") for r in reqs
                } - {""}
                for r in reqs:
                    rid = (r.get("join_request_id") or "")
                    if not rid or is_join_request_seen(gid, rid):
                        continue
                    mark_join_request_seen(gid, rid)
                    push_bot_message({"type": "join_request", "data": {"group_openid": gid, **r}})
                await asyncio.sleep(2.5)  # 限速（30 QPM，留余量）
        except Exception as e:
            _log.warning(f"[JOIN_REQUEST] 轮询任务异常: {e}")
        await asyncio.sleep(60)  # 低频兜底，两轮之间休眠


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
    _log.info("[NeonBot] 初始化数据库…")
    init_db()
    _log.info("[NeonBot] 数据库就绪 ✓")

    # 2) 启动 bot 线程
    _log.info(f"[NeonBot] 启动 Bot (AppID={APP_ID})…")
    bot_thread = threading.Thread(target=run_bot, name="qqbot", daemon=True)
    bot_thread.start()
    _log.info("[NeonBot] Bot 线程已启动 ✓")

    # 3) 启动消息泵（后台任务，转发 bot 消息到 WebSocket）
    asyncio.create_task(pump_bot_messages())

    # 3.5) 后台刷新所有群的基本信息（群名/人数，24h 缓存，限速）
    asyncio.create_task(_group_info_refresh_loop())

    # 3.6) 低频轮询加群申请（事件兜底，60s/轮，限速）
    asyncio.create_task(_join_request_poll_loop())

    # 4) 启动 Web 服务器
    webui_port = int(config.get("webui-port", 8080))
    webui_host = "0.0.0.0" if config.get("enable-public", False) else "127.0.0.1"
    # 密码保护
    pwd = config.get("webui-password", "").strip()
    if pwd:
        import web_server
        web_server.WEBUI_PASSWORD = pwd
        _log.info("[NeonBot] WebUI 密码保护已启用")
    _log.info(f"[NeonBot] WebUI → http://{webui_host}:{webui_port}")
    config_obj = uvicorn.Config(
        app,
        host=webui_host,
        port=webui_port,
        log_level="info",
        access_log=False,
        # log_config=None → uvicorn 不执行 dictConfig（否则会清掉 LogBuffer 挂的 root handlers）
        log_config=None,
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
        _log.info("[NeonBot] 已退出")
