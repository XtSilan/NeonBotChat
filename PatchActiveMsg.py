"""
PatchActiveMsg.py
绕过 botpy 的 API，直接使用 QQ 官方 HTTP API 主动发送群消息
解决 botpy 4年未更新导致的：
- 无法主动发送消息（必须被动回复）
- Message 对象无法手动构建
- 新参数不支持

依赖: pip install aiohttp

使用方法：
    from PatchActiveMsg import send_group_msg
    await send_group_msg("群OpenID", "Hello World")
"""

import asyncio
import time
import random
import json
import aiohttp
from typing import Optional
from botpy import logging
import os

from botpy.ext.cog_yaml import read
config = read(os.path.join(os.path.dirname(__file__), "config.yaml"))
_log=logging.get_logger("PatchActiveMsg")

# ================== 硬编码配置 ==================
APP_ID = config["appid"]
CLIENT_SECRET = config["secret"]

BASE_URL = "https://api.sgroup.qq.com"  # 注意不要以 / 结尾
TOKEN_URL = "https://bots.qq.com"
AUTH_TYPE = "QQBot"              # 注意不是 Bearer
TOKEN_URL_ = "/app/getAppAccessToken"
# ===============================================

# Access Token 缓存
_access_token: Optional[str] = None
_token_expire_at: float = 0.0

async def _get_access_token() -> str:
    global _access_token, _token_expire_at

    if _access_token and time.time() < _token_expire_at - 120:
        return _access_token

    url = f"{TOKEN_URL}{TOKEN_URL_}"  # → https://bots.qq.com/app/getAppAccessToken
    headers = {"Content-Type": "application/json"}
    data = {
        "appId": APP_ID,
        "clientSecret": CLIENT_SECRET,
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=data) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"获取 token 失败: {resp.status} {text}")
            result = await resp.json()
            _access_token = result["access_token"]
            _token_expire_at = time.time() + int(result.get("expires_in", 7200))
            _log.info(f"Token 已刷新，过期时间: {str(_token_expire_at)}")
            return _access_token


async def send_group_msg(
    group_openid: str,
    content: str,
    msg_type: int = 0,
) -> dict:
    """
    主动发送群消息（绕过 botpy）

    Args:
        group_openid: 群 OpenID
        content: 消息内容
        msg_type: 0=文本, 2=markdown, 3=ark 等

    Returns:
        dict: QQ 官方 API 返回的 JSON
    """


    token = await _get_access_token()

    url = f"{BASE_URL}/v2/groups/{group_openid}/messages"
    headers = {
        "Authorization": f"{AUTH_TYPE} {token}",
        "Content-Type": "application/json",
    }
    payload = {"msg_type": msg_type}
    if msg_type == 2:  # markdown
        payload["markdown"] = {"content": content}
    else:
        payload["content"] = content

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            result = await resp.json()
            if resp.status != 200:
                _log.error(f"📤 发送失败 ({resp.status}): {result}")
            else:
                _log.info(f"📤 发送成功:\n{json.dumps(result, ensure_ascii=False, indent=2)}")
            return result


async def recall_group_msg(
    group_openid: str,
    message_id: str,
) -> dict:
    """
    撤回群消息

    Args:
        group_openid: 群 OpenID
        message_id: 消息 ID（QQ 返回的原始 id）

    Returns:
        dict: QQ API 返回
    """
    token = await _get_access_token()
    url = f"{BASE_URL}/v2/groups/{group_openid}/messages/{message_id}"

    headers = {
        "Authorization": f"{AUTH_TYPE} {token}",
    }

    async with aiohttp.ClientSession() as session:
        async with session.delete(url, headers=headers) as resp:
            text = await resp.text()
            try:
                result = json.loads(text) if text else {}
            except json.JSONDecodeError:
                result = {"raw": text}
            if resp.status != 200:
                _log.error(f"📤 撤回失败 ({resp.status}): {result}")
            else:
                _log.info(f"📤 撤回成功:\n{json.dumps(result, ensure_ascii=False, indent=2)}")
            return result



# 富媒体 file_type 枚举（QQ 官方定义 - 本地文件上传）
MEDIA_TYPE = {
    "image": 1,   # 图片
    "voice": 3,   # 语音
    "video": 2,   # 视频
    "file": 4,    # 文件
}

# URL 上传接口使用相同的映射


async def upload_group_media_by_url(
    group_openid: str,
    media_url: str,
    file_type: str = "image",
    srv_send_msg: bool = False,
    file_name: str = "",
) -> dict:
    """
    通过 URL 上传富媒体到 QQ 服务器
    srv_send_msg=True 时自动发送到群，返回完整结果（含消息 ID）
    srv_send_msg=False 时返回 {"file_info": "..."}
    """
    if file_type not in MEDIA_TYPE:
        raise ValueError(f"file_type 必须是 {list(MEDIA_TYPE.keys())}，收到: {file_type}")

    token = await _get_access_token()
    url = f"{BASE_URL}/v2/groups/{group_openid}/files"

    headers = {
        "Authorization": f"{AUTH_TYPE} {token}",
        "Content-Type": "application/json",
    }

    payload = {
        "file_type": MEDIA_TYPE[file_type],
        "url": media_url,
        "srv_send_msg": srv_send_msg,
    }
    if file_name:
        payload["file_name"] = file_name

    _log.info(f"📤 [upload_by_url] 请求体: {json.dumps(payload, ensure_ascii=False)}")

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            text = await resp.text()
            if resp.status != 200:
                _log.error(f"📤 URL上传失败 ({resp.status}): {text}")
                raise RuntimeError(f"URL上传失败: {text}")
            result = json.loads(text)
            if srv_send_msg:
                _log.info(f"📤 上传并发送成功 file_type={file_type} id={result.get('id', '?')}")
                return result  # 返回完整结果，含 id
            file_info = result.get("file_info")
            if not file_info:
                raise RuntimeError(f"上传成功但未返回 file_info: {result}")
            _log.info(f"📤 URL上传成功 file_type={file_type} url={media_url[:60]}... file_info={file_info[:30]}...")
            return {"file_info": file_info}


async def upload_group_media(
    group_openid: str,
    file_path: str,
    file_type: str = "image",  # "image"|"voice"|"video"|"file"
) -> str:
    """
    第一步：上传富媒体文件到 QQ 服务器，返回 file_info
    """
    if file_type not in MEDIA_TYPE:
        raise ValueError(f"file_type 必须是 {list(MEDIA_TYPE.keys())}，收到: {file_type}")

    token = await _get_access_token()
    url = f"{BASE_URL}/v2/groups/{group_openid}/files"

    headers = {
        "Authorization": f"{AUTH_TYPE} {token}",
        # 注意：上传是 multipart/form-data，不是 application/json
    }

    from aiohttp import FormData
    form = FormData()
    form.add_field(
        "file_type",
        str(MEDIA_TYPE[file_type]),
    )
    # file 字段：文件名 + 二进制
    with open(file_path, "rb") as f:
        form.add_field(
            "file",
            f.read(),
            filename=os.path.basename(file_path),
            content_type="application/octet-stream",
        )

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, data=form) as resp:
            text = await resp.text()
            if resp.status != 200:
                _log.error(f"富媒体上传失败 ({resp.status}): {text}")
                raise RuntimeError(f"富媒体上传失败: {text}")
            result = await resp.json()
            file_info = result.get("file_info")
            if not file_info:
                raise RuntimeError(f"上传成功但未返回 file_info: {result}")
            _log.info(f"富媒体上传成功 file_type={file_type} file_info={file_info[:30]}...")
            return file_info


async def send_group_rich(
    group_openid: str,
    file_info: str,
    file_type: str = "image",
) -> dict:
    """
    第二步：用 file_info 发富媒体消息
    msg_type=7 固定是富媒体
    """
    token = await _get_access_token()
    url = f"{BASE_URL}/v2/groups/{group_openid}/messages"

    headers = {
        "Authorization": f"{AUTH_TYPE} {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "msg_type": 7,  # 富媒体
        "media": {
            "file_info": file_info,
            "file_type": MEDIA_TYPE[file_type],
        },
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            text = await resp.text()
            if resp.status != 200:
                _log.error(f"富媒体发送失败 ({resp.status}): {text}")
                return {"error": text}
            result = await resp.json()
            _log.info(f"富媒体消息发送成功: {result}")
            return result


async def send_group_image(
    group_openid: str,
    image_path: str,
) -> dict:
    file_info = await upload_group_media(group_openid, image_path, file_type="image")
    return await send_group_rich(group_openid, file_info, file_type="image")