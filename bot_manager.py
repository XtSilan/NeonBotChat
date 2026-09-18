# -*- coding: utf-8 -*-
"""
bot_manager.py — 多 Bot 实例管理器
管理多个 QQ Bot 账号的登录、切换和生命周期
"""

import asyncio
import threading
import time as _time
from typing import Dict, Optional, Any
from dataclasses import dataclass, field
from datetime import datetime

import botpy
from botpy import logging as botpy_logging
from botpy.message import GroupMessage, C2CMessage

from database import (
    add_account, get_account, get_all_accounts, delete_account,
    update_account_info, update_account_last_login
)

_log = botpy_logging.get_logger("BotManager")


@dataclass
class BotInstance:
    """单个 Bot 实例"""
    appid: str
    secret: str
    bot_name: str = ""
    bot_avatar: str = ""
    is_running: bool = False
    start_time: Optional[float] = None
    client: Optional[Any] = None
    thread: Optional[threading.Thread] = None
    loop: Optional[asyncio.AbstractEventLoop] = None


class BotManager:
    """多 Bot 实例管理器"""
    
    def __init__(self):
        self.bots: Dict[str, BotInstance] = {}
        self.active_appid: Optional[str] = None
        self._lock = threading.Lock()

    def _activate_credentials(self, bot: BotInstance) -> None:
        """让依赖全局凭据的主动消息 API 跟随当前账号。"""
        import PatchActiveMsg
        import database

        PatchActiveMsg.APP_ID = bot.appid
        PatchActiveMsg.CLIENT_SECRET = bot.secret
        PatchActiveMsg._access_token = None
        PatchActiveMsg._token_expire_at = 0.0
        database.bot_name = bot.bot_name or "Bot"
        database.bot_start_time = bot.start_time or 0.0

        try:
            import web_server
            web_server._BOT_APP_ID = bot.appid
        except Exception:
            pass
    
    async def login(self, appid: str, secret: str) -> dict:
        """登录并启动 Bot
        
        Args:
            appid: QQ Bot AppID
            secret: QQ Bot AppSecret
            
        Returns:
            dict: {"ok": bool, "account": dict, "error": str}
        """
        if appid in self.bots and self.bots[appid].is_running:
            self.active_appid = appid
            self._activate_credentials(self.bots[appid])
            await update_account_last_login(appid)
            return {"ok": True, "account": await get_account(appid)}

        # 验证缓存也必须隔离，否则第二个账号会误用第一个账号的 token。
        try:
            from PatchActiveMsg import _get_access_token
            import PatchActiveMsg
            old_state = (
                PatchActiveMsg.APP_ID,
                PatchActiveMsg.CLIENT_SECRET,
                PatchActiveMsg._access_token,
                PatchActiveMsg._token_expire_at,
            )
            PatchActiveMsg.APP_ID = appid
            PatchActiveMsg.CLIENT_SECRET = secret
            PatchActiveMsg._access_token = None
            PatchActiveMsg._token_expire_at = 0.0
            try:
                token = await _get_access_token()
                if not token:
                    return {"ok": False, "error": "AppID 或 Secret 无效"}
            finally:
                (
                    PatchActiveMsg.APP_ID,
                    PatchActiveMsg.CLIENT_SECRET,
                    PatchActiveMsg._access_token,
                    PatchActiveMsg._token_expire_at,
                ) = old_state
        except Exception as e:
            return {"ok": False, "error": f"验证失败: {str(e)}"}

        account = await add_account(appid, secret)
        bot = BotInstance(appid=appid, secret=secret)
        with self._lock:
            self.bots[appid] = bot
        try:
            await self._start_bot(bot)
            self.active_appid = appid
            self._activate_credentials(bot)
            return {"ok": True, "account": account}
        except Exception as e:
            with self._lock:
                self.bots.pop(appid, None)
            return {"ok": False, "error": f"启动失败: {str(e)}"}
    
    async def _start_bot(self, bot: BotInstance):
        """启动单个 Bot 实例"""
        def run_bot():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            bot.loop = loop
            
            intents = botpy.Intents(public_messages=True)
            client = MyClient(bot_manager=self, appid=bot.appid, intents=intents)
            bot.client = client
            
            try:
                bot.is_running = True
                bot.start_time = _time.time()
                loop.run_until_complete(client.start(appid=bot.appid, secret=bot.secret))
            except Exception as e:
                _log.error(f"Bot {bot.appid} 异常: {e}")
            finally:
                bot.is_running = False
                loop.close()
        
        thread = threading.Thread(target=run_bot, name=f"bot-{bot.appid}", daemon=True)
        bot.thread = thread
        thread.start()
        
        # 等待 Bot 启动
        for _ in range(50):  # 最多等待 5 秒
            if bot.is_running:
                break
            await asyncio.sleep(0.1)
        
        if not bot.is_running:
            raise RuntimeError("Bot 启动超时")
    
    async def logout(self, appid: str):
        """登出 Bot"""
        with self._lock:
            bot = self.bots.get(appid)
        if not bot:
            return

        if bot.client and bot.loop and bot.loop.is_running():
            try:
                future = asyncio.run_coroutine_threadsafe(bot.client.close(), bot.loop)
                await asyncio.wait_for(asyncio.wrap_future(future), timeout=3)
            except Exception:
                pass

        bot.is_running = False
        if self.active_appid == appid:
            self.active_appid = None
            for other_appid, other_bot in self.bots.items():
                if other_appid != appid and other_bot.is_running:
                    self.active_appid = other_appid
                    self._activate_credentials(other_bot)
                    break
    
    async def switch(self, appid: str) -> dict:
        """切换当前账号"""
        if appid not in self.bots or not self.bots[appid].is_running:
            account = await get_account(appid)
            if not account:
                return {"ok": False, "error": "账号不存在"}
            return await self.login(appid, account["secret"])
        
        self.active_appid = appid
        self._activate_credentials(self.bots[appid])
        await update_account_last_login(appid)
        return {"ok": True}
    
    def get_active(self) -> Optional[BotInstance]:
        """获取当前活跃的 Bot"""
        if self.active_appid and self.active_appid in self.bots:
            return self.bots[self.active_appid]
        return None
    
    def get_active_appid(self) -> Optional[str]:
        """获取当前活跃的 AppID"""
        return self.active_appid
    
    def get_all(self) -> Dict[str, BotInstance]:
        """获取所有 Bot"""
        return self.bots.copy()
    
    def get_bot(self, appid: str) -> Optional[BotInstance]:
        """获取指定 Bot"""
        return self.bots.get(appid)
    
    async def remove(self, appid: str):
        """删除账号"""
        await self.logout(appid)
        with self._lock:
            if appid in self.bots:
                del self.bots[appid]
        await delete_account(appid)
    
    def is_running(self, appid: str) -> bool:
        """检查 Bot 是否在运行"""
        return appid in self.bots and self.bots[appid].is_running
    
    async def start_all_saved(self):
        """启动所有已保存的账号"""
        accounts = await get_all_accounts()
        for account in accounts:
            if account.get("enabled", 1):
                try:
                    await self.login(account["appid"], account["secret"])
                except Exception as e:
                    _log.error(f"启动账号 {account['appid']} 失败: {e}")


class MyClient(botpy.Client):
    """支持多账号的 Bot 客户端"""
    
    def __init__(self, bot_manager: BotManager, appid: str, **kwargs):
        super().__init__(**kwargs)
        self.bot_manager = bot_manager
        self.appid = appid
    
    async def on_ready(self):
        import database, time
        bot = self.bot_manager.get_bot(self.appid)
        if bot:
            bot.bot_name = self.robot.name
            await update_account_info(self.appid, bot_name=self.robot.name)
            if self.bot_manager.get_active_appid() == self.appid:
                self.bot_manager._activate_credentials(bot)
        _log.info(f"🤖 robot 「{self.robot.name}」 (appid={self.appid}) on_ready!")
    
    async def on_group_message_create(self, message: GroupMessage):
        await self._handle_group_message(message)
    
    async def on_group_at_message_create(self, message: GroupMessage):
        await self._handle_group_message(message, at_received=True)
    
    async def on_c2c_message_create(self, message: C2CMessage):
        await self._handle_c2c_message(message)
    
    async def _handle_c2c_message(self, message: C2CMessage) -> None:
        """统一处理私聊消息"""
        try:
            from database import save_message, upsert_conversation, is_echo, maybe_update_direct_name
            from web_server import push_bot_message
            from PatchMsg import is_author_bot
            from PatchUserInfo import getUserNameCached, buildAvatarUrl
            
            user_id = ""
            author = getattr(message, "author", None)
            if author:
                user_id = getattr(author, "user_openid", "") or ""
            if not user_id:
                user_id = getattr(message, "user_openid", "") or ""
            if not user_id:
                return
            
            content = getattr(message, "content", "") or ""
            msg_id = getattr(message, "id", "") or ""
            
            # 去重
            if is_author_bot(msg_id) and is_echo(user_id, content):
                return
            
            # 处理表情标记
            import re as _re
            content = _re.sub(r'<faceType=1,[^>]*>', '[表情符号]', content)
            content = _re.sub(r'<faceType=6,[^>]*>', '', content)
            
            # 附件归一化
            import json as _json
            norm_attachments = []
            for a in (getattr(message, "attachments", None) or []):
                if isinstance(a, dict):
                    norm_attachments.append(a)
                elif hasattr(a, "__dict__"):
                    norm_attachments.append({k: v for k, v in a.__dict__.items() if not k.startswith("_")})
            attachments_json = _json.dumps(norm_attachments, ensure_ascii=False)
            
            # 创建/更新私聊会话
            await upsert_conversation(
                user_id, name=f"私聊 {user_id[:10]}", conv_type="direct", account_id=self.appid
            )
            
            # 自动刷新对方最新昵称/头像
            try:
                dm_name = await getUserNameCached(self.appid, user_id)
                if dm_name:
                    await maybe_update_direct_name(user_id, dm_name)
            except Exception:
                dm_name = ""
            dm_avatar = buildAvatarUrl(self.appid, user_id)
            
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
                account_id=self.appid,
            )
            saved["conv_type"] = "direct"
            account = self.bot_manager.get_bot(self.appid)
            saved["account_name"] = account.bot_name if account else ""
            push_bot_message({"type": "new_message", "data": saved})
        except Exception as e:
            _log.warning(f"[C2C] 处理失败: {e}")
    
    async def _handle_group_message(self, message: GroupMessage, at_received: bool = False):
        """统一处理群消息"""
        try:
            from database import save_message, upsert_conversation
            from web_server import push_bot_message
            from PatchMsg import (
                get_raw_attachments, get_username, get_msg_type, get_msg_elements,
                get_msg_ref_idx, get_ref_msg_idx, is_author_bot, is_bot_mentioned,
                clean_group_message_content, get_member_role
            )
            from PatchUserInfo import getUserName, replace_mentions_with_names
            
            group_id = getattr(message, "group_openid", "") or message.group_openid
            author = getattr(message, "author", None)
            author_id = ""
            if author:
                for attr in ("id", "user_id", "member_openid", "user_openid"):
                    val = getattr(author, attr, None)
                    if val:
                        author_id = val
                        break
            
            content = getattr(message, "content", "") or ""
            msg_id_for_att = getattr(message, "id", "") or ""
            
            # 提取附件
            raw_attachments = get_raw_attachments(msg_id_for_att)
            
            # 归一化附件
            import json as _json
            norm_attachments = []
            for a in raw_attachments:
                if isinstance(a, dict):
                    norm_attachments.append(a)
                elif hasattr(a, "__dict__"):
                    norm_attachments.append({k: v for k, v in a.__dict__.items() if not k.startswith("_")})
            attachments_json = _json.dumps(norm_attachments, ensure_ascii=False)
            
            # 跳过 Bot 自己发出去的消息回显
            msg_id = getattr(message, "id", "") or ""
            from database import is_echo
            if is_author_bot(msg_id) and is_echo(group_id, content):
                return
            
            # 处理表情标记
            import re as _re
            content = _re.sub(r'<faceType=1,[^>]*>', '[表情符号]', content)
            content = _re.sub(r'<faceType=6,[^>]*>', '', content)
            
            # 将 <@OpenID> 替换为 @昵称
            mentions = getattr(message, "mentions", None) or []
            display_content = await replace_mentions_with_names(self.appid, content)
            if display_content == content:
                display_content = clean_group_message_content(content, mentions)
            
            # 获取发送者昵称
            author_name = get_username(msg_id_for_att)
            if not author_name and author_id:
                try:
                    author_name = await getUserName(self.appid, author_id)
                except Exception:
                    author_name = author_id[:8] if author_id else ""
            
            # 标记机器人用户
            if is_author_bot(msg_id) and author_name:
                author_name = f"{author_name} 🤖"
            
            member_role = get_member_role(msg_id)
            if member_role == "owner":
                member_role = "群主"
            elif member_role == "admin":
                member_role = "管理员"
            
            # 确保会话存在
            group_name = f"群聊 {group_id[:8]}"
            await upsert_conversation(
                group_id, name=group_name, conv_type="group", account_id=self.appid
            )
            
            # 保存消息
            avatar_url = f"https://q.qlogo.cn/qqapp/{self.appid}/{author_id}/100" if author_id else ""
            saved = await save_message(
                conversation_id=group_id,
                sender_openid=author_id,
                sender_name=author_name or f"用户{author_id[:6] if author_id else '???'}",
                content=display_content or "[富媒体文件]",
                direction="incoming",
                msg_id=msg_id,
                msg_type=getattr(message, "message_type", 0) or 0,
                sender_avatar=avatar_url,
                attachments=attachments_json,
                member_role=member_role,
                ref_idx=get_msg_ref_idx(msg_id_for_att),
                account_id=self.appid,
            )
            
            # 补上 @信息
            if at_received and display_content:
                saved["is_at"] = True
            if is_bot_mentioned(mentions):
                saved["is_at"] = True
            
            # 附带账号信息
            saved["account_name"] = self.bot_manager.get_bot(self.appid).bot_name if self.bot_manager.get_bot(self.appid) else ""
            
            # 推送到 WebUI
            push_bot_message({"type": "new_message", "data": saved})
            
        except Exception as e:
            _log.error(f"[_handle_group_message] {e}", exc_info=True)


# 全局 Bot 管理器实例
bot_manager = BotManager()
