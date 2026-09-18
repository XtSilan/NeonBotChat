import aiohttp
import json
import logging
import asyncio
import re
import os
import time

# 设置日志
logger = logging.getLogger(__name__)

"""
用户信息获取模块
提供获取昵称和头像的公开接口
"""

async def getUserName(appid: str, openid: str) -> str:
    """
    获取用户昵称
    :param appid: 应用ID (对应 API 文档中的 appid)
    :param openid: 用户唯一标识 (对应 API 文档中的 openid)
    :return: 成功返回昵称字符串，失败返回空字符串
    """
    # API 文档地址: https://oiapi.net/api/Openid
    api_url = "http://oiapi.net/api/Openid"
    
    payload = {
        "appid": appid,
        "openid": openid
    }

    try:
        timeout = aiohttp.ClientTimeout(total=5) # 5秒超时
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(api_url, json=payload) as response:
                # 确保状态码是200
                if response.status == 200:
                    data = await response.json()
                    
                    # 按照文档示例，code=1 表示成功
                    # 注意：不同API的code定义可能不同，这里依据你截图中的 {"code": 1, "message": "Neon."} 判断
                    if data.get("code") == 1:
                        nickname = data.get("data", {}).get("nickname")
                        if nickname:
                            return nickname
                        else:
                            logger.warning(f"[UserInfo] 获取昵称成功，但字段缺失: {data}")
                            return ""
                    else:
                        logger.error(f"[UserInfo] 获取昵称API返回错误: {data.get('message')}")
                        return ""
                else:
                    logger.error(f"[UserInfo] 请求失败，状态码: {response.status}")
                    return ""
                    
    except aiohttp.ClientError as e:
        logger.error(f"[UserInfo] 网络请求异常 (getUserName): {e}")
        return ""
    except json.JSONDecodeError:
        logger.error("[UserInfo] 昵称API返回数据解析失败")
        return ""

# 昵称内存缓存：openid -> (拉取时间, 昵称)。oiapi 是第三方接口，避免高频重复调用
_USER_NAME_CACHE: dict = {}
_USER_NAME_TTL = 600  # 10 分钟

async def getUserNameCached(appid: str, openid: str, ttl: int = _USER_NAME_TTL) -> str:
    """带 TTL 缓存的昵称获取：缓存期内直接返回，过期/未命中才调 oiapi"""
    now = time.time()
    hit = _USER_NAME_CACHE.get(openid)
    if hit and now - hit[0] < ttl:
        return hit[1]
    name = await getUserName(appid, openid)
    if name:
        _USER_NAME_CACHE[openid] = (now, name)
    return name


def buildAvatarUrl(appid: str, openid: str) -> str:
    """构造 QQ 头像直链（q.qlogo.cn），无需下载"""
    return f"https://q.qlogo.cn/qqapp/{appid}/{openid}/100" if appid and openid else ""


async def getUserAvatar(appid: str, openid: str, save_local: bool = False) -> bytes | None:
    """
    获取用户头像
    :param appid: 应用ID (对应 BotAppID)
    :param openid: 用户唯一标识 (对应 Member_OpenID)
    :return: 成功返回图片二进制数据(bytes)，失败返回 None
    """
    # 文档说明：直接get这个链接内容就行
    # 格式: https://q.qlogo.cn/qqapp/{BotAppID}/{Member_OpenID}/100
    avatar_url = f"https://q.qlogo.cn/qqapp/{appid}/{openid}/640"
    
    try:
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(avatar_url) as response:
                # 检查状态码是否为 200 OK
                if response.status == 200:
                    # 直接读取二进制内容
                    image_data = await response.read()
                    logger.info(f"[UserInfo] 头像下载成功，大小: {len(image_data)} bytes")
                    if save_local:
                        base_dir = os.path.join(os.path.dirname(__file__), "cache", "avatars")
                        os.makedirs(base_dir, exist_ok=True)
                        save_path = os.path.join(base_dir, f"{openid}.png")
                        try:
                            with open(save_path, "wb") as f:
                                f.write(image_data)
                            logger.info(f"[UserInfo] 头像已缓存: {save_path}")
                        except OSError as e:
                            logger.warning(f"[UserInfo] 头像存盘失败（不影响返回）: {e}")
                    return image_data
                else:
                    logger.error(f"[UserInfo] 头像请求失败，状态码: {response.status}")
                    return None
                    
    except aiohttp.ClientError as e:
        logger.error(f"[UserInfo] 网络请求异常 (getUserAvatar): {e}")
        return None

async def replace_mentions_with_names(appid: str, content: str) -> str:
    """
    将消息中的 <@OpenID> / <@!OpenID> 替换为 @昵称
    """
    # 匹配 QQ 的 mention 格式（带不带 ! 都覆盖）
    mention_pattern = re.compile(r"<@!?([A-Za-z0-9]+)>")
    openids = mention_pattern.findall(content)
    
    if not openids:
        return content
    
    # 并发获取所有昵称（避免串行 await 拖慢）
    nicknames = await asyncio.gather(
        *(getUserName(appid, oid) for oid in openids)
    )
    
    # 逐个替换
    for oid, nick in zip(openids, nicknames):
        # 拿不到昵称就用 OpenID 前6位兜底，避免 MC 里出现 "@" 后面空白
        display = nick if nick else f"用户{oid[:6]}"
        content = content.replace(f"<@{oid}>", f"@{display}").replace(f"<@!{oid}>", f"@{display}")
    
    return content
