"""
web_server.py — FastAPI + WebSocket 实时推送
桥接 QQ Bot ↔ WebUI
"""
import asyncio
import json
import queue
import os
import re
import html
import time as _time
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
import aiohttp
from urllib.parse import unquote, urlparse

from database import (
    init_db, get_conversations, get_conversation, get_messages, get_recent_messages,
    save_message, upsert_conversation, reset_unread,
)
from PatchActiveMsg import send_group_msg, recall_group_msg

# ── 线程安全消息桥 ──────────────────────────────────────
# bot 线程 → FastAPI 主线程
message_queue: queue.Queue = queue.Queue()

# ── FastAPI ─────────────────────────────────────────────
app = FastAPI(title="NeonBotChat", version="0.1.0")

# ── 密码保护中间件 ──────────────────────────────────────
WEBUI_PASSWORD: str = ""  # 由 init.py 设置

class PasswordMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not WEBUI_PASSWORD:
            return await call_next(request)
        # WebSocket 和登录接口不走密码检查
        if request.url.path in ("/ws", "/api/login", "/api/logout"):
            return await call_next(request)
        # 检查 cookie
        pwd_ok = request.cookies.get("nb_pwd") == WEBUI_PASSWORD
        if pwd_ok:
            resp = await call_next(request)
            # 设置持久 cookie
            if not request.cookies.get("nb_pwd"):
                resp.set_cookie("nb_pwd", WEBUI_PASSWORD, max_age=86400 * 30, httponly=True)
            return resp
        # 密码错误 → 显示登录页
        return HTMLResponse(LOGIN_HTML, status_code=401)

app.add_middleware(PasswordMiddleware)

LOGIN_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>NeonBotChat - 登录</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
.svg-icon { vertical-align: middle; filter: invert(1); }
body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;
  background: #1a1b1e; color: #e4e5e7; display: flex; align-items: center; justify-content: center;
  min-height: 100vh; }
.login-box { background: #1e1f23; border-radius: 12px; padding: 32px; border: 1px solid #3e3f44;
  text-align: center; width: 360px; max-width: 90vw; }
.login-box h2 { margin-bottom: 20px; }
.login-box input { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid #3e3f44;
  background: #2c2d31; color: #e4e5e7; font-size: 1em; outline: none; margin-bottom: 14px; }
.login-box input:focus { border-color: #5865f2; }
.login-box button { width: 100%; padding: 10px; border-radius: 8px; border: none;
  background: #5865f2; color: #fff; font-size: 1em; font-weight: 600; cursor: pointer; }
.login-box button:hover { background: #4752c4; }
.error { color: #ed4245; font-size: 0.85em; margin-bottom: 10px; }
</style></head><body>
<div class="login-box"><h2><img src="icons/bot.svg" class="svg-icon" style="width:28px;height:28px;" alt=""> NeonBotChat</h2>
<p class="error" id="err"></p>
<input type="password" id="pwd" placeholder="请输入访问密码" autofocus>
<button onclick="login()">登 录</button></div>
<script>
function login() {
  var p = document.getElementById('pwd').value;
  if (!p) return;
  fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pwd:p})})
    .then(function(r) { return r.json().then(function(d) { return {ok:r.ok, data:d}; }); })
    .then(function(r) {
      if (r.ok) { window.location.reload(); }
      else { document.getElementById('err').textContent = r.data.error || '密码错误'; }
    });
}
document.getElementById('pwd').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') login();
});
</script></body></html>"""

# 静态文件
TEMPLATES = os.path.join(os.path.dirname(__file__), "web")
if os.path.isdir(TEMPLATES):
    app.mount("/static", StaticFiles(directory=TEMPLATES), name="static")
icons_dir = os.path.join(os.path.dirname(__file__), "icons")
if os.path.isdir(icons_dir):
    app.mount("/icons", StaticFiles(directory=icons_dir), name="icons")

# ── WebSocket 连接管理 ──────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self._connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self._connections:
            self._connections.remove(ws)

    async def broadcast(self, data: dict) -> None:
        dead: list[WebSocket] = []
        payload = json.dumps(data, ensure_ascii=False)
        for ws in self._connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    @property
    def online_count(self) -> int:
        return len(self._connections)


manager = ConnectionManager()


# ── 后台任务：轮询 bot 消息队列 ─────────────────────────

async def pump_bot_messages() -> None:
    """把 bot 线程推送的消息转发到所有 WebSocket 客户端"""
    loop = asyncio.get_event_loop()
    while True:
        try:
            msg = await loop.run_in_executor(None, lambda: message_queue.get(timeout=0.1))
            await manager.broadcast(msg)
        except queue.Empty:
            pass
        await asyncio.sleep(0.05)


# ── 从外部（bot 线程）推送消息 ──────────────────────────

def push_bot_message(data: dict) -> None:
    """线程安全：bot 线程调用，消息进入队列"""
    message_queue.put(data)


# ── 按会话类型分流：direct → C2C 私聊，否则群聊 ──────────

async def _send_by_type(conv_id, content, msg_type=0, message_reference=None, keyboard_content=None, raw_payload=None):
    from database import get_conversation
    from PatchActiveMsg import send_c2c_msg
    conv = await get_conversation(conv_id)
    if conv and conv.get("type") == "direct":
        return await send_c2c_msg(conv_id, content, msg_type=msg_type,
                                  message_reference=message_reference, keyboard_content=keyboard_content, raw_payload=raw_payload)
    return await send_group_msg(conv_id, content, msg_type=msg_type,
                                message_reference=message_reference, keyboard_content=keyboard_content, raw_payload=raw_payload)


async def _upload_by_type(conv_id, file_url, file_type="image", srv_send_msg=False, file_name=""):
    from database import get_conversation
    from PatchActiveMsg import upload_c2c_media_by_url, upload_group_media_by_url
    conv = await get_conversation(conv_id)
    if conv and conv.get("type") == "direct":
        return await upload_c2c_media_by_url(conv_id, file_url, file_type=file_type,
                                             srv_send_msg=srv_send_msg, file_name=file_name)
    return await upload_group_media_by_url(conv_id, file_url, file_type=file_type,
                                           srv_send_msg=srv_send_msg, file_name=file_name)


def _normalize_media_url(value: str) -> str:
    """兼容前端/历史数据中的 Markdown 链接，返回可请求的裸 URL。"""
    value = html.unescape(str(value or "").strip())
    match = re.fullmatch(r"\[[^\]]*\]\((https?://[^)]+)\)", value, flags=re.IGNORECASE | re.DOTALL)
    if match:
        value = match.group(1).strip()
    if value.startswith("<") and value.endswith(">"):
        value = value[1:-1].strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("图床返回的链接不是有效的 HTTP(S) 地址")
    return value


async def _download_media_bytes(file_url: str) -> bytes:
    """由本机下载图床文件，避免 QQ 云端访问不到私有局域网地址。"""
    timeout = aiohttp.ClientTimeout(total=120, connect=15, sock_read=120)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(file_url) as resp:
            if resp.status != 200:
                detail = (await resp.text())[:240]
                raise RuntimeError(f"本机无法读取图床文件 ({resp.status}): {detail}")
            data = await resp.read()
            if not data:
                raise RuntimeError("图床返回空文件")
            return data


async def _upload_bytes_by_type(conv_id, media_bytes, file_type="image", srv_send_msg=False, file_name=""):
    from database import get_conversation
    from PatchActiveMsg import upload_c2c_media_bytes, upload_group_media_bytes
    conv = await get_conversation(conv_id)
    if conv and conv.get("type") == "direct":
        return await upload_c2c_media_bytes(conv_id, media_bytes, file_type=file_type,
                                             srv_send_msg=srv_send_msg, file_name=file_name)
    return await upload_group_media_bytes(conv_id, media_bytes, file_type=file_type,
                                          srv_send_msg=srv_send_msg, file_name=file_name)


# ── API 路由 ────────────────────────────────────────────

@app.post("/api/logout")
async def api_logout():
    """清除登录 cookie"""
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("nb_pwd")
    return resp


@app.post("/api/login")
async def api_login(request: Request):
    """验证密码并设置 cookie"""
    try:
        body = await request.json()
        pwd = body.get("pwd", "")
    except Exception:
        return JSONResponse({"error": "invalid"}, status_code=400)
    if WEBUI_PASSWORD and pwd == WEBUI_PASSWORD:
        resp = JSONResponse({"ok": True})
        resp.set_cookie("nb_pwd", WEBUI_PASSWORD, max_age=86400 * 30, httponly=True)
        return resp
    return JSONResponse({"error": "密码错误"}, status_code=401)


# 拆分后的 CSS / JS 静态文件
app.mount("/css", StaticFiles(directory=os.path.join(TEMPLATES, "css")), name="css")
app.mount("/js", StaticFiles(directory=os.path.join(TEMPLATES, "js")), name="js")
app.mount("/sounds", StaticFiles(directory=os.path.join(TEMPLATES, "sounds")), name="sounds")


def _read_web_page(filename: str) -> HTMLResponse:
    path = os.path.join(TEMPLATES, filename)
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse(f"<h1>{filename} 未找到</h1>", status_code=404)


def _active_account_id() -> str:
    try:
        from bot_manager import bot_manager
        return bot_manager.get_active_appid() or ""
    except Exception:
        return ""


def _active_account_name() -> str:
    try:
        from bot_manager import bot_manager
        bot = bot_manager.get_active()
        return (bot.bot_name or bot.appid) if bot else ""
    except Exception:
        return ""


@app.get("/", response_class=HTMLResponse)
async def index():
    if not _active_account_id():
        return _read_web_page("login.html")
    return _read_web_page("index.html")


@app.get("/login", response_class=HTMLResponse)
async def account_login_page():
    return _read_web_page("login.html")


@app.get("/api/image")
async def api_image_proxy(url: str = Query(...)):
    """代理下载 QQ 媒体文件，绕过防盗链。图片/视频均流式传输"""
    try:
        decoded = unquote(url)
        async with aiohttp.ClientSession() as session:
            async with session.get(decoded, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    return Response(status_code=502)
                content_type = resp.headers.get("Content-Type", "image/png")
                content_length = resp.headers.get("Content-Length")
                # 视频等大文件：流式传输
                if content_type.startswith("video/") or content_type.startswith("audio/"):
                    return StreamingResponse(
                        resp.content.iter_chunked(64 * 1024),
                        media_type=content_type,
                        headers={"Content-Length": content_length} if content_length else {},
                    )
                # 图片等小文件：直接读
                data = await resp.read()
                return Response(content=data, media_type=content_type)
    except Exception:
        return Response(status_code=502)


@app.get("/api/readme", response_class=HTMLResponse)
async def api_readme():
    """返回 README.md（简单 HTML 渲染）"""
    import re as _re
    readme_path = os.path.join(os.path.dirname(__file__), "README.md")
    if not os.path.isfile(readme_path):
        return HTMLResponse("<h1>README.md 未找到</h1>", status_code=404)
    with open(readme_path, "r", encoding="utf-8") as f:
        text = f.read()
    # 简单的 markdown→html 转换
    text = _re.sub(r'### (.+)', r'<h3>\1</h3>', text)
    text = _re.sub(r'## (.+)', r'<h2>\1</h2>', text)
    text = _re.sub(r'# (.+)', r'<h1>\1</h1>', text)
    text = _re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = _re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    text = _re.sub(r'\n- (.+)', r'<br>• \1', text)
    text = _re.sub(r'```bash\n(.+?)```', r'<pre><code>\1</code></pre>', text, flags=_re.DOTALL)
    text = text.replace('\n\n', '</p><p>').replace('\n', '<br>')
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>README - NeonBotChat</title>
<style>
body {{ font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif; max-width:800px; margin:40px auto; padding:0 20px; background:#1a1b1e; color:#e4e5e7; line-height:1.7; }}
h1,h2 {{ border-bottom:1px solid #3e3f44; padding-bottom:8px; }}
code {{ background:#2c2d31; padding:2px 6px; border-radius:4px; }}
pre {{ background:#2c2d31; padding:16px; border-radius:8px; overflow-x:auto; }}
a {{ color:#5865f2; }}
</style></head>
<body><p>{text}</p></body></html>"""
    return HTMLResponse(html)


# ── Bot 设置存储（JSON 文件，跨设备共享）───────────────
import json as _json_module
SETTINGS_PATH = os.path.join(os.path.dirname(__file__), "bot_settings.json")

def _load_settings() -> dict:
    if os.path.isfile(SETTINGS_PATH):
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            return _json_module.load(f)
    return {}

def _save_settings(data: dict) -> None:
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        _json_module.dump(data, f, ensure_ascii=False, indent=2)


@app.post("/api/send-media")
async def api_send_media(request: Request):
    """从图床下载图片 → 上传到 QQ → 发送富媒体消息"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    raw_file_url = body.get("url", "")
    conv_id = body.get("conv_id", "")
    file_type = body.get("file_type", "image")
    file_name = body.get("file_name", "")
    if not raw_file_url or not conv_id:
        return JSONResponse({"error": "缺少 url 或 conv_id"}, status_code=400)

    try:
        file_url = _normalize_media_url(raw_file_url)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    from botpy import logging as _blog
    _log = _blog.get_logger("NeonBotChat")
    _log.info(f"📤 [send-media] 图床链接: {file_url}  → 会话: {conv_id}")

    # 分步发送：1) 上传拿 file_info  2) 发送富媒体消息（获取消息 id / ref_idx 入库）
    try:
        media_bytes = await _download_media_bytes(file_url)
        up_result = await _upload_bytes_by_type(
            conv_id, media_bytes, file_type=file_type, srv_send_msg=False, file_name=file_name
        )
        file_info = up_result.get("file_info", "") if isinstance(up_result, dict) else ""
        if not file_info:
            return JSONResponse({"error": "上传失败：未返回 file_info"}, status_code=400)
        from PatchActiveMsg import MEDIA_TYPE
        result = await _send_by_type(conv_id, "", msg_type=7, raw_payload={
            "media": {"file_info": file_info, "file_type": MEDIA_TYPE.get(file_type, 1)},
        })
        # 检查 QQ API 是否返回了错误
        if result.get("code") or result.get("err_code"):
            err_msg = result.get("message", "") or result.get("msg", "") or "未知错误"
            return JSONResponse({"error": f"发送失败：{err_msg}"}, status_code=400)

        # 保存到本地数据库
        import database as _db, json as _json
        placeholder_map = {"video": "[视频]", "voice": "[语音]", "image": "[图片]", "file": "[文件]"}
        placeholder = placeholder_map.get(file_type, "[图片]")
        ct_map = {"video": "video/mp4", "voice": "audio/wav", "image": "image/png", "file": "application/octet-stream"}
        ext_map = {"video": "mp4", "voice": "wav", "image": "png", "file": "bin"}
        attachments = _json.dumps([{"content_type": ct_map.get(file_type, "image/png"), "url": file_url, "filename": file_name or f"media.{ext_map.get(file_type, 'png')}"}], ensure_ascii=False)
        qq_msg_id = str(result.get("id", ""))
        ref_idx = result.get("ext_info", {}).get("ref_idx", "") if isinstance(result, dict) else ""
        saved = await _db.save_message(
            conversation_id=conv_id,
            sender_openid="self",
            sender_name=_db.bot_name + " 🤖",
            content=placeholder,
            direction="outgoing",
            msg_type=0,
            msg_id=qq_msg_id,
            attachments=attachments,
            ref_idx=ref_idx,
            account_id=_active_account_id(),
        )
        saved["account_name"] = _active_account_name()
        saved["conv_type"] = (await get_conversation(conv_id) or {}).get("type", "group")
        await manager.broadcast({"type": "new_message", "data": saved})
        return {"ok": True, "message": saved, "qq_result": result}
    except Exception as e:
        import traceback as _tb
        _log.error(f"📤 [send-media] 发送失败: {e}\n{_tb.format_exc()}")
        return JSONResponse({"error": f"发送失败: {str(e)}"}, status_code=500)


@app.post("/api/upload-file")
async def api_upload_to_file_server(request: Request):
    """代理上传文件到图床服务器，返回 file_id 和 url"""
    from botpy.ext.cog_yaml import read as _read_cfg
    _raw = _read_cfg(os.path.join(os.path.dirname(__file__), "config.yaml"))
    fs_cfg = (_raw or {}).get("file-server", {})
    fs_url = fs_cfg.get("public-url", "").rstrip("/") or f"http://127.0.0.1:{fs_cfg.get('port', 36337)}"
    fs_token = fs_cfg.get("token", "")
    fs_upload = f"{fs_url}/upload"

    try:
        form = await request.form()
        file = form.get("file")
        if not file:
            return JSONResponse({"code": 400, "message": "未选择文件"}, status_code=400)
        data = await file.read()
        import aiohttp
        async with aiohttp.ClientSession() as session:
            form_data = aiohttp.FormData()
            form_data.add_field("file", data, filename=file.filename or "file", content_type=file.content_type or "application/octet-stream")
            headers = {}
            if fs_token:
                headers["Authorization"] = f"Bearer {fs_token}"
            async with session.post(fs_upload, data=form_data, headers=headers) as resp:
                result = await resp.json()
                return result
    except Exception as e:
        return JSONResponse({"code": 500, "message": f"上传失败: {str(e)}"}, status_code=500)


@app.get("/api/settings")
async def api_get_settings():
    data = _load_settings()
    # 附带文件服务器 URL（供前端判断直链）
    from botpy.ext.cog_yaml import read as _read_cfg
    _raw = _read_cfg(os.path.join(os.path.dirname(__file__), "config.yaml"))
    fs = (_raw or {}).get("file-server", {})
    data["_file_server_url"] = fs.get("public-url", "").rstrip("/")
    dev_mode = (_raw or {}).get("developerMode", False)
    data["_developer_mode"] = dev_mode if isinstance(dev_mode, bool) else str(dev_mode).lower() == "true"
    return data


@app.post("/api/settings")
async def api_save_settings(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    data = _load_settings()
    for key in ("avatar", "bio", "bg_image", "bg_opacity", "theme"):
        if key in body:
            data[key] = body[key]
    _save_settings(data)
    return {"ok": True}


@app.get("/api/bot-info")
async def api_bot_info():
    """读取机器人自身信息（GET /users/@me）。头像直接来自官方接口，成功后覆盖设置缓存"""
    from PatchActiveMsg import get_bot_info
    info = await get_bot_info()
    avatar = (info or {}).get("avatar") or ""
    if avatar:
        data = _load_settings()
        if data.get("avatar") != avatar:
            data["avatar"] = avatar
            _save_settings(data)
    else:
        avatar = (_load_settings().get("avatar") or "")  # 接口失败回退旧缓存
    return {"ok": True, "username": (info or {}).get("username") or "", "avatar": avatar}


@app.get("/api/link-preview")
async def api_link_preview(url: str = Query(...)):
    """抓取网页元数据（标题/描述/图标），供链接卡片渲染"""
    import re
    from urllib.parse import urlparse
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url,
                timeout=aiohttp.ClientTimeout(total=5),
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"},
            ) as resp:
                if resp.status != 200:
                    return {"ok": False}
                html = await resp.text(errors="ignore")
        # 标题
        title = ""
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
        if m:
            title = re.sub(r"\s+", " ", m.group(1)).strip()[:120]
        # 描述（description / og:description）
        desc = ""
        m = re.search(r'<meta[^>]+(?:name|property)=["\'](?:description|og:description)["\'][^>]+content=["\']([^"\']*)["\']', html, re.I)
        if not m:
            m = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:name|property)=["\'](?:description|og:description)["\']', html, re.I)
        if m:
            desc = re.sub(r"\s+", " ", m.group(1)).strip()[:200]
        # 图标（favicon）
        icon = ""
        m = re.search(r'<link[^>]+rel=["\'][^"\']*icon[^"\']*["\'][^>]+href=["\']([^"\']+)["\']', html, re.I)
        if not m:
            m = re.search(r'<link[^>]+href=["\']([^"\']+)["\'][^>]+rel=["\'][^"\']*icon[^"\']*["\']', html, re.I)
        if m:
            icon = m.group(1)
            if icon.startswith("//"):
                icon = "https:" + icon
            elif icon.startswith("/"):
                p = urlparse(url)
                icon = f"{p.scheme}://{p.netloc}{icon}"
        return {"ok": True, "title": title, "description": desc, "icon": icon, "url": url}
    except Exception:
        return {"ok": False}


@app.get("/api/export/{conv_id}")
async def api_export(conv_id: str, format: str = "md"):
    """导出聊天记录为 Markdown 或 JSON"""
    import urllib.parse
    from database import get_all_messages, get_conversation

    msgs = await get_all_messages(conv_id)
    conv = await get_conversation(conv_id)
    name = (conv or {}).get("display_name") or (conv or {}).get("name") or conv_id
    if format == "json":
        content = json.dumps(msgs, ensure_ascii=False, indent=2)
        media_type = "application/json"
        filename = f"{name}.json"
    else:
        lines = [f"# {name}\n"]
        for m in msgs:
            who = m["sender_name"] or m["sender_openid"] or ("Bot" if m["direction"] == "outgoing" else "未知用户")
            body = m["content"] or "[媒体消息]"
            lines.append(f"**{who}** ({m['timestamp']}):\n\n{body}\n")
        content = "\n".join(lines)
        media_type = "text/markdown; charset=utf-8"
        filename = f"{name}.md"
    encoded = urllib.parse.quote(filename)
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"},
    )


@app.get("/api/agreement")
async def api_agreement():
    """返回用户协议内容（AGREEMENT.md）"""
    agreement_path = os.path.join(os.path.dirname(__file__), "AGREEMENT.md")
    if os.path.isfile(agreement_path):
        with open(agreement_path, "r", encoding="utf-8") as f:
            return {"ok": True, "content": f.read()}
    return {"ok": False, "content": ""}


@app.post("/api/restart")
async def api_restart():
    """重启后端服务：延迟拉起新进程后退出当前进程"""
    import subprocess, sys, threading, time, tempfile
    root = os.path.dirname(__file__)
    cmd = [sys.executable, os.path.join(root, "init.py")]
    helper = os.path.join(tempfile.gettempdir(), "nb_restart_helper.py")
    try:
        with open(helper, "w", encoding="utf-8") as f:
            f.write("import time, subprocess, sys\n")
            f.write("time.sleep(2)\n")
            f.write(f"subprocess.Popen({cmd!r}, cwd={root!r})\n")
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        subprocess.Popen([sys.executable, helper], cwd=root,
                         creationflags=flags,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return JSONResponse({"error": f"重启失败: {e}"}, status_code=500)
    threading.Thread(target=lambda: (time.sleep(1.2), os._exit(0)), daemon=True).start()
    return {"ok": True}


@app.get("/api/stats")
async def api_stats(account_id: str = Query("")):
    """会话数据统计：今日收发、活跃群 TOP5、总消息数"""
    from database import get_stats
    return await get_stats(account_id.strip())


@app.get("/api/logs")
async def api_logs(since: int = Query(0)):
    """返回服务端日志（增量拉取，保留最近 500 条）"""
    from LogBuffer import get_logs
    return get_logs(since)


@app.get("/api/system-info")
async def api_system_info():
    """返回系统和 Bot 运行状态（使用 WMI 获取准确硬件信息）"""
    import platform, time, psutil, os as _os, math

    is_windows = platform.system() == "Windows"

    # OS - Windows 优先从注册表获取版本名
    os_name = f"{platform.system()} {platform.release()}"
    if is_windows:
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows NT\CurrentVersion')
            os_name, _ = winreg.QueryValueEx(key, 'ProductName')
            winreg.CloseKey(key)
        except Exception:
            pass

    # CPU - Windows 用 WMI，Linux 读 /proc/cpuinfo
    cpu_model = platform.processor() or "Unknown"
    if is_windows:
        try:
            import wmi
            cpu_info = wmi.WMI().Win32_Processor()[0]
            cpu_model = cpu_info.Name.strip()
        except Exception:
            pass
    elif platform.system() == "Linux":
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if "model name" in line:
                        cpu_model = line.split(":")[1].strip()
                        break
        except Exception:
            pass
    cpu_percent = psutil.cpu_percent(interval=0)  # 非阻塞，返回上次调用以来的值

    # 内存
    mem = psutil.virtual_memory()
    mem_used = mem.used / (1024**3)
    mem_total = math.ceil(mem.total / (1024**3))

    # 系统运行时间
    sys_uptime_sec = time.time() - psutil.boot_time()

    # Bot 运行时间
    from database import bot_start_time, bot_name
    bot_uptime_sec = time.time() - bot_start_time if bot_start_time else 0

    def fmt_uptime(sec):
        days = int(sec // 86400)
        hours = int((sec % 86400) // 3600)
        minutes = int((sec % 3600) // 60)
        s = int(sec % 60)
        return f"{days}天{hours}时{minutes}分{s}秒"

    return {
        "os": os_name,
        "cpu_model": cpu_model,
        "cpu_percent": round(cpu_percent, 1),
        "mem_used": round(mem_used, 1),
        "mem_total": round(mem_total, 1),
        "mem_percent": round(mem.percent, 1),
        "sys_uptime": fmt_uptime(sys_uptime_sec),
        "bot_name": bot_name,
        "bot_uptime": fmt_uptime(bot_uptime_sec),
    }


@app.get("/api/status")
async def api_status():
    return {
        "status": "running",
        "online_viewers": manager.online_count,
    }


@app.get("/api/conversations")
async def api_conversations(limit: int = 50, include_hidden: bool = False):
    convs = await get_conversations(
        limit, include_hidden=include_hidden, account_id=_active_account_id()
    )
    # 私聊头像自动获取（PatchUserInfo），不用手动上传
    await _fill_direct_avatars(convs)
    return {"conversations": convs}


@app.get("/api/avatar/{conv_id}")
async def api_refresh_direct_avatar(conv_id: str):
    """进入私聊页面时刷新一次个人头像：重新下载 q.qlogo.cn，更新内存缓存与数据库；失败静默保留旧头像"""
    import base64 as _b64
    from database import get_conversation, set_conversation_flags
    from PatchUserInfo import getUserAvatar

    conv = await get_conversation(conv_id)
    if not conv or conv.get("type") != "direct":
        return JSONResponse({"error": "会话不存在或不是私聊"}, status_code=404)
    if not _BOT_APP_ID:
        return {"ok": False, "avatar": ""}

    img = await getUserAvatar(_BOT_APP_ID, conv_id)
    if not isinstance(img, (bytes, bytearray)) or not img:
        return {"ok": False, "avatar": ""}

    url = "data:image/png;base64," + _b64.b64encode(img).decode("ascii")
    _avatar_cache[conv_id] = url
    try:
        await set_conversation_flags(conv_id, avatar=url)
    except Exception:
        pass
    return {"ok": True, "avatar": url}


@app.get("/api/user-info/{openid}")
async def api_user_info(openid: str):
    """按 OpenID 拉取最新昵称与头像直链（昵称带 10 分钟缓存）。
    点击成员卡片时调用，用于自动刷新显示；拉取失败返回空字段，前端保留旧值"""
    if not _BOT_APP_ID or not openid:
        return {"ok": False, "name": "", "avatar_url": ""}
    try:
        import time as _time
        from PatchUserInfo import getUserNameCached, buildAvatarUrl
        name = await getUserNameCached(_BOT_APP_ID, openid)
        # qlogo URL 由 openid 派生、换头像后 URL 不变——加时间戳参数绕过浏览器缓存，
        # 保证每次点击卡片都拉到最新头像
        return {"ok": True, "name": name, "avatar_url": buildAvatarUrl(_BOT_APP_ID, openid) + f"?v={int(_time.time())}"}
    except Exception:
        return {"ok": False, "name": "", "avatar_url": ""}


def _conv_group_info(conv: dict) -> dict:
    """从会话记录提取群信息返回体（简介/分类/标签解析 JSON）"""
    try:
        tags = json.loads(conv.get("group_tags") or "[]")
    except Exception:
        tags = []
    return {
        "official_name": conv.get("official_name") or "",
        "member_num": conv.get("member_num") or 0,
        "memo": conv.get("group_memo") or "",
        "class_text": conv.get("group_class") or "",
        "tags": tags if isinstance(tags, list) else [],
        "bot_role": conv.get("bot_role") or "",
        "proactive_msg": conv.get("proactive_msg") if conv.get("proactive_msg") is not None else -1,
        "recv_setting": conv.get("recv_setting") or "",
        "display_name": conv.get("display_name") or conv.get("id") or "",
    }


@app.get("/api/group-info/{conv_id}")
async def api_group_info(conv_id: str):
    """进入群聊时实时查询一次群基本信息 + 机器人在群状态（失败回退旧缓存）。返回 display_name 供前端直接使用"""
    from database import get_conversation, set_group_info, set_bot_state

    conv = await get_conversation(conv_id)
    if not conv or conv.get("type") != "group":
        return JSONResponse({"error": "会话不存在或不是群聊"}, status_code=404)

    from PatchActiveMsg import get_group_info, get_bot_state

    # 实时查询群信息
    raw = await get_group_info(conv_id)
    state = await get_bot_state(conv_id)
    if raw:
        bot_role = (state or {}).get("member_role") or "" if state else None
        proactive_msg = int(bool((state or {}).get("allow_proactive_msg"))) if state else None
        recv_setting = (state or {}).get("recv_msg_setting") or "" if state else None
        await set_group_info(
            conv_id,
            (raw.get("group_name") or "").strip(),
            int(raw.get("group_member_num") or 0),
            memo=(raw.get("group_finger_memo") or "").strip(),
            class_text=(raw.get("group_class_text") or "").strip(),
            tags=raw.get("group_tags") or [],
            bot_role=bot_role,
            proactive_msg=proactive_msg,
            recv_setting=recv_setting,
        )
        conv = await get_conversation(conv_id)
        return {"ok": True, **_conv_group_info(conv), "cached": False}

    # 群信息拉取失败：bot_state 仍单独刷新，返回旧缓存
    if state:
        await set_bot_state(conv_id, state)
        conv = await get_conversation(conv_id)

    if conv.get("official_name") or conv.get("member_num"):
        return {"ok": True, **_conv_group_info(conv), "cached": True}
    return JSONResponse({"error": "群信息获取失败（可能无接口权限或限频）"}, status_code=503)


@app.post("/api/mute")
async def api_mute(request: Request):
    """禁言/解除禁言群成员（需机器人是群管理员）。
    op=add 禁言：seconds 最大 30 天，到期时间用服务器时间计算；op=del 立即解除禁言"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    conv_id = body.get("conv_id", "")
    member_openid = body.get("member_openid", "")
    op = body.get("op", "add")
    if op not in ("add", "del"):
        return JSONResponse({"error": "op 必须是 add 或 del"}, status_code=400)
    if not conv_id or not member_openid:
        return JSONResponse({"error": "缺少 conv_id 或 member_openid"}, status_code=400)

    from database import get_conversation
    conv = await get_conversation(conv_id)
    if not conv or conv.get("type") != "group":
        return JSONResponse({"error": "会话不存在或不是群聊"}, status_code=404)

    from PatchActiveMsg import mute_member
    if op == "del":
        result = await mute_member(conv_id, member_openid, "", op="del")
        if result is None:
            return JSONResponse({"error": "解除禁言失败（可能机器人不是群管理员，或接口无权限）"}, status_code=502)
        return {"ok": True, "action": "del"}

    seconds = body.get("seconds", 0)
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        seconds = 0
    if seconds <= 0 or seconds > 30 * 24 * 3600:
        return JSONResponse({"error": "禁言时长必须在 1 秒 ~ 30 天之间"}, status_code=400)

    from datetime import datetime, timedelta, timezone
    mute_expire_at = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")
    result = await mute_member(conv_id, member_openid, mute_expire_at, op="add")
    if result is None:
        return JSONResponse({"error": "禁言失败（可能机器人不是群管理员、对方是管理员/群主，或接口无权限）"}, status_code=502)
    return {"ok": True, "action": "add", "mute_expire_at": mute_expire_at}


_mute_status_cache: dict = {}  # conv_id -> (拉取时间戳, members)
MUTE_STATUS_TTL = 2.0  # 前端 1s 轮询，QQ API 30 QPM 限制 → 后端缓存 2s（1s 内命中缓存直接返回）

# ── 加群申请：内存 seen 集合（事件 + 轮询 + 审批去重）─────
join_request_seen: dict[str, set] = {}  # group_openid -> 已见过的 join_request_id 集合


def mark_join_request_seen(group_openid: str, join_request_id: str) -> None:
    """标记该申请已处理过（事件/审批调用，避免轮询重复播报）"""
    join_request_seen.setdefault(group_openid, set()).add(join_request_id)


def is_join_request_seen(group_openid: str, join_request_id: str) -> bool:
    return join_request_id in join_request_seen.get(group_openid, set())


join_request_pending: dict[str, set] = {}  # group_openid -> 待审批 join_request_id 集合（前端徽章计数）


_join_requests_cache: dict = {}  # conv_id -> (拉取时间戳, requests)
JOIN_REQUESTS_TTL = 2.0  # 前端 1s 轮询，QQ API 30 QPM 限制 → 后端缓存 2s（与禁言一致）


# 加群申请人头像：PatchUserInfo.getUserAvatar 下载（q.qlogo.cn）→ base64 data URL
# 头像基本不变，内存永久缓存避免每 2s 重复下载
_avatar_cache: dict = {}  # member_openid -> data URL
_BOT_APP_ID = ""
_cfg_path = os.path.join(os.path.dirname(__file__), "config.yaml")
if not os.path.isfile(_cfg_path):
    _cfg_path = os.path.join(os.path.dirname(__file__), "configs", "config.yaml")
if os.path.isfile(_cfg_path):
    try:
        from botpy.ext.cog_yaml import read as _cfg_read
        _BOT_APP_ID = str(_cfg_read(_cfg_path).get("appid", ""))
    except Exception:
        pass


async def _fill_join_request_avatars(reqs: list) -> None:
    """为每条加群申请补 avatar（base64 data URL）；失败静默，前端保留首字符占位"""
    import base64 as _b64
    from PatchUserInfo import getUserAvatar
    if not reqs or not _BOT_APP_ID:
        return
    tasks = []
    for r in reqs:
        oid = (r.get("member_openid") or "")
        if not oid:
            continue
        if oid in _avatar_cache:
            r["avatar"] = _avatar_cache[oid]
        else:
            tasks.append((r, oid))
    if not tasks:
        return
    results = await asyncio.gather(
        *(getUserAvatar(_BOT_APP_ID, oid) for _, oid in tasks),
        return_exceptions=True,
    )
    for (r, oid), img in zip(tasks, results):
        if isinstance(img, (bytes, bytearray)) and img:
            url = "data:image/png;base64," + _b64.b64encode(img).decode("ascii")
            _avatar_cache[oid] = url
            r["avatar"] = url


async def _fill_direct_avatars(convs: list) -> None:
    """私聊会话头像：PatchUserInfo.getUserAvatar 自动获取（q.qlogo.cn），持久化到库。
    不再支持个人头像手动上传；头像基本不变，复用 _avatar_cache 避免重复下载"""
    import base64 as _b64
    from database import set_conversation_flags
    from PatchUserInfo import getUserAvatar
    if not convs or not _BOT_APP_ID:
        return
    tasks = []
    for c in convs:
        oid = c.get("id") or ""
        if c.get("type") != "direct" or not oid or c.get("avatar_url"):
            continue
        if oid in _avatar_cache:
            c["avatar_url"] = _avatar_cache[oid]
        else:
            tasks.append(c)
    if tasks:
        results = await asyncio.gather(
            *(getUserAvatar(_BOT_APP_ID, c["id"]) for c in tasks),
            return_exceptions=True,
        )
        for c, img in zip(tasks, results):
            if isinstance(img, (bytes, bytearray)) and img:
                url = "data:image/png;base64," + _b64.b64encode(img).decode("ascii")
                _avatar_cache[c["id"]] = url
                c["avatar_url"] = url
    # 持久化（缓存命中且库里还没有头像时也补写一次，之后加载直接跳过）
    for c in convs:
        if c.get("type") == "direct" and c.get("avatar_url"):
            try:
                await set_conversation_flags(c["id"], avatar=c["avatar_url"])
            except Exception:
                pass


@app.post("/api/system-note")
async def api_system_note(request: Request):
    """保存本地系统提示（禁言/解除禁言气泡），持久化到消息表（direction=center），刷新后仍可见"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    conv_id = body.get("conv_id", "")
    member_name = body.get("member_name", "")
    member_openid = body.get("sender_openid", "")  # 被禁言成员 openid：点气泡蓝字弹成员卡片用
    content = body.get("content", "")  # 如「被你禁言1天2小时」
    if not conv_id or not content:
        return JSONResponse({"error": "缺少 conv_id 或 content"}, status_code=400)

    from database import save_message
    saved = await save_message(
        conversation_id=conv_id, sender_openid=member_openid, sender_name=member_name,
        content=content, direction="center", account_id=_active_account_id(),
    )
    return {"ok": True, "id": saved.get("id") if isinstance(saved, dict) else 0}


@app.get("/api/mute-status/{conv_id}")
async def api_mute_status(conv_id: str):
    """查询群当前被禁言的成员列表（GET /v2/groups/{conv_id}/restrict_chat_setting）"""
    from database import get_conversation
    conv = await get_conversation(conv_id)
    if not conv or conv.get("type") != "group":
        return JSONResponse({"error": "会话不存在或不是群聊"}, status_code=404)
    # 机器人不是群管理员：禁言接口无权限（QQ API 返回 400），直接返回空列表，避免 1s 轮询反复打接口触发 30 QPM 限制
    if conv.get("bot_role") not in ("admin", "owner"):
        return {"ok": True, "members": [], "no_permission": True}

    cached = _mute_status_cache.get(conv_id)
    if cached and _time.time() - cached[0] < MUTE_STATUS_TTL:
        return {"ok": True, "members": cached[1], "cached": True}

    from PatchActiveMsg import get_group_mutes
    members = await get_group_mutes(conv_id)
    if members is None:
        # QQ API 失败（限频等）：有缓存则返回旧值，否则 502
        if cached:
            return {"ok": True, "members": cached[1], "cached": True}
        return JSONResponse({"error": "查询禁言状态失败（可能接口无权限或限频）"}, status_code=502)
    _mute_status_cache[conv_id] = (_time.time(), members)
    return {"ok": True, "members": members}


@app.get("/api/join-requests/summary")
async def api_join_requests_summary():
    """各管理群待审批申请数量（内存计数，事件+轮询维护）—— 前端图标徽章用。
    ⚠️ 必须注册在 /api/join-requests/{conv_id} 之前，否则 summary 会被当成 conv_id"""
    return {"ok": True,
            "total": sum(len(s) for s in join_request_pending.values()),
            "per_group": {gid: len(s) for gid, s in join_request_pending.items()}}


@app.get("/api/join-requests/{conv_id}")
async def api_join_requests(conv_id: str):
    """查询群待审批的加群申请列表（需机器人是群管理员/群主；5s 短缓存防连点）"""
    from database import get_conversation
    conv = await get_conversation(conv_id)
    if not conv or conv.get("type") != "group":
        return JSONResponse({"error": "会话不存在或不是群聊"}, status_code=404)
    if conv.get("bot_role") not in ("admin", "owner"):
        return JSONResponse({"error": "机器人不是群管理员，无法查看加群申请"}, status_code=403)

    cached = _join_requests_cache.get(conv_id)
    if cached and _time.time() - cached[0] < JOIN_REQUESTS_TTL:
        return {"ok": True, "requests": cached[1], "cached": True}

    from PatchActiveMsg import get_join_requests
    reqs = await get_join_requests(conv_id)
    if reqs is None:
        # QQ API 失败（限频等）：有缓存则返回旧值，否则 502
        if cached:
            return {"ok": True, "requests": cached[1], "cached": True}
        return JSONResponse({"error": "获取加群申请失败（可能接口无权限或限频）"}, status_code=502)
    _join_requests_cache[conv_id] = (_time.time(), reqs)
    # 头像补全（首次下载，之后走内存缓存；失败保留首字符占位）
    await _fill_join_request_avatars(reqs)
    return {"ok": True, "requests": reqs}


@app.post("/api/join-request/approval")
async def api_join_request_approval(request: Request):
    """手动审批加群申请：op=approve 同意 / decline 拒绝（可带拒绝原因、加入黑名单）"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    conv_id = body.get("conv_id", "")
    member_openid = body.get("member_openid", "")
    join_request_id = body.get("join_request_id", "")
    op = body.get("op", "")
    if op not in ("approve", "decline"):
        return JSONResponse({"error": "op 必须是 approve 或 decline"}, status_code=400)
    if not conv_id or not member_openid or not join_request_id:
        return JSONResponse({"error": "缺少 conv_id / member_openid / join_request_id"}, status_code=400)

    from database import get_conversation
    conv = await get_conversation(conv_id)
    if not conv or conv.get("type") != "group":
        return JSONResponse({"error": "会话不存在或不是群聊"}, status_code=404)
    if conv.get("bot_role") not in ("admin", "owner"):
        return JSONResponse({"error": "机器人不是群管理员，无法审批"}, status_code=403)

    from PatchActiveMsg import approval_join_request
    result = await approval_join_request(
        conv_id,
        member_openid,
        join_request_id,
        op,
        reject_reason=body.get("reject_reason", ""),
        add_to_blacklist=bool(body.get("add_to_blacklist", False)),
    )
    if result is None:
        return JSONResponse({"error": "审批失败（接口可能无权限或限频）"}, status_code=502)

    # 审批成功：该申请已处理，标记 seen 避免轮询再播报；从待审批计数移除；失效列表缓存
    mark_join_request_seen(conv_id, join_request_id)
    join_request_pending.get(conv_id, set()).discard(join_request_id)
    _join_requests_cache.pop(conv_id, None)

    # 同意 → 生成「XXX加入了群聊。」系统消息（direction=center 居中气泡，名字蓝色可点）
    # 走 save_message 入库：消息历史/会话预览/搜索均持久化，再广播到前端实时渲染
    if op == "approve":
        try:
            from database import save_message, bot_name
            username = (body.get("username") or "").strip() or member_openid
            # 头像：复用申请列表下载过的缓存（data URL）；缓存缺失则现下载一次
            # 存入 sender_avatar → 消息蓝字点开成员卡片显示真实头像，历史加载也持久化
            avatar = _avatar_cache.get(member_openid, "")
            if not avatar and _BOT_APP_ID:
                import base64 as _b64
                from PatchUserInfo import getUserAvatar
                img = await getUserAvatar(_BOT_APP_ID, member_openid)
                if img:
                    avatar = "data:image/png;base64," + _b64.b64encode(img).decode("ascii")
                    _avatar_cache[member_openid] = avatar
            sys_msg = await save_message(
                conv_id,
                sender_openid=member_openid,
                sender_name=username,
                content="加入了群聊。",
                direction="center",
                sender_avatar=avatar,
                account_id=_active_account_id(),
            )
            sys_msg["bot_name"] = bot_name
            await manager.broadcast({"type": "new_message", "data": sys_msg})
        except Exception as e:
            import logging as _std_logging
            _std_logging.getLogger("web_server").warning(f"[JOIN_APPROVAL] 系统消息入库失败: {e}")

    return {"ok": True}


@app.post("/api/conversations")
async def api_add_conversation(request: Request):
    """手动添加好友或群聊到会话列表"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    conv_type: str = (body.get("conv_type") or "group").strip().lower()
    openid: str = (body.get("openid") or body.get("group_openid") or "").strip()
    if not openid:
        return JSONResponse({"error": "OpenID 不能为空"}, status_code=400)

    if conv_type == "direct":
        # 好友：没填备注就尝试拉取真实昵称（拿不到退回默认名）
        name = (body.get("name") or "").strip()
        if not name:
            try:
                from PatchUserInfo import getUserName
                real = await getUserName(_BOT_APP_ID, openid) if _BOT_APP_ID else ""
                name = f"私聊 {real}" if real else f"私聊 {openid[:10]}"
            except Exception:
                name = f"私聊 {openid[:10]}"
        await upsert_conversation(
            openid, name=name, conv_type="direct", account_id=_active_account_id()
        )
        return {"ok": True, "id": openid, "name": name}

    name = (body.get("name") or "").strip() or f"群聊 {openid[:10]}"
    await upsert_conversation(
        openid, name=name, conv_type="group", account_id=_active_account_id()
    )
    return {"ok": True, "id": openid, "name": name}


@app.patch("/api/conversations/{conv_id}")
async def api_update_conversation(conv_id: str, request: Request):
    """修改会话：备注名 / 置顶 / 免打扰 / 隐藏"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    from database import get_conversation, rename_conversation, set_conversation_flags

    # 传了 name 就更新（可为空字符串 = 清除备注，回到官方群名显示）
    has_name = "name" in body
    new_name = (body.get("name") or "").strip() if has_name else ""
    if has_name:
        await rename_conversation(conv_id, new_name)

    flags = {}
    for key in ("pinned", "muted", "hidden"):
        if key in body:
            flags[key] = 1 if body[key] else 0
    if "avatar" in body:
        # 个人头像不支持手动上传：由系统通过 PatchUserInfo 自动获取
        c = await get_conversation(conv_id)
        if c and c.get("type") == "direct":
            return JSONResponse({"error": "个人头像由系统自动获取，不支持手动上传"}, status_code=400)
        flags["avatar"] = body["avatar"]  # 群头像（dataURL）
    if flags:
        await set_conversation_flags(conv_id, **flags)

    if not has_name and not flags:
        return JSONResponse({"error": "没有可更新的字段"}, status_code=400)

    return {"ok": True, "id": conv_id, "name": new_name, **flags}


@app.delete("/api/conversations/{conv_id}")
async def api_delete_conversation(conv_id: str):
    """删除会话（含全部聊天记录）"""
    from database import delete_conversation
    await delete_conversation(conv_id)
    return {"ok": True}


@app.delete("/api/messages")
async def api_clear_all_messages():
    """清空全部聊天记录"""
    from database import clear_all_messages
    await clear_all_messages()
    await manager.broadcast({"type": "clear_all"})
    return {"ok": True}


@app.delete("/api/messages/{conv_id}")
async def api_clear_messages(conv_id: str):
    """清空会话聊天记录"""
    from database import clear_messages
    await clear_messages(conv_id)
    return {"ok": True}


@app.get("/api/search")
async def api_search(q: str = "", limit: int = 50, conv_id: str = ""):
    """消息内容搜索（conv_id 为空则全局）"""
    from database import search_messages
    q = q.strip()
    if not q:
        return {"results": []}
    results = await search_messages(q, limit=limit, conv_id=conv_id.strip())
    return {"results": results}


@app.get("/api/messages/{conv_id}")
async def api_messages(conv_id: str, limit: int = 50, before: int = 0, around: int = 0):
    from database import get_messages_around
    if around:
        msgs = await get_messages_around(conv_id, around, limit=limit)
    else:
        msgs = await get_messages(conv_id, limit=limit, before_id=before)
    # 标记已读
    await reset_unread(conv_id)
    return {"messages": msgs}


@app.post("/api/send-raw")
async def api_send_raw(request: Request):
    """发送自定义消息（前端直接提供完整 payload）"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    conv_id: str = body.pop("conv_id", "")
    if not conv_id:
        return JSONResponse({"error": "conv_id 不能为空"}, status_code=400)

    msg_type = body.get("msg_type", 0)
    result = await _send_by_type(conv_id, "", msg_type=msg_type, raw_payload=body)

    if result.get("code") or result.get("err_code"):
        err_msg = result.get("message", "") or "未知错误"
        return JSONResponse({"error": f"发送失败：{err_msg}"}, status_code=400)

    from database import save_message, bot_name
    saved = await save_message(
        conversation_id=conv_id, sender_openid="self",
        sender_name=bot_name + " 🤖", content="[自定义消息]",
        direction="outgoing",
        msg_id=str(result.get("id", "")),
        msg_type=msg_type,
        account_id=_active_account_id(),
    )
    saved["account_name"] = _active_account_name()
    saved["conv_type"] = (await get_conversation(conv_id) or {}).get("type", "group")
    await manager.broadcast({"type": "new_message", "data": saved})
    return {"ok": True, "message": saved, "qq_result": result}


@app.post("/api/send")
async def api_send(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    conv_id: str = body.get("conv_id", "")
    content: str = body.get("content", "")
    msg_type: int = body.get("msg_type", 0)
    message_reference: dict = body.get("message_reference", None)
    keyboard_content: dict = body.get("keyboard", None)
    quote_thumbs: str = body.get("quote_thumbs", "")

    if not conv_id or not content.strip():
        return JSONResponse({"error": "conv_id 和 content 不能为空"}, status_code=400)

    # 1) 标记 outgoing（防止 WebSocket 回显重复入库）
    from database import mark_outgoing
    mark_outgoing(conv_id, content)

    # 特殊消息用占位文本（卡片消息保留原始 JSON 入库，便于前端重新渲染成卡片）
    display_content = content
    if msg_type == 8:
        display_content = content
    elif keyboard_content is not None:
        display_content = "[键盘] " + content

    # 2) 调用 QQ API 发送
    try:
        result = await _send_by_type(conv_id, content, msg_type=msg_type, message_reference=message_reference, keyboard_content=keyboard_content)
        # 检查 QQ API 是否返回了错误
        if result.get("code") or result.get("err_code") or result.get("error"):
            err_msg = result.get("message", "") or result.get("msg", "") or result.get("error", "") or "未知错误"
            return JSONResponse({"error": f"发送失败：{err_msg}"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"发送失败: {str(e)}"}, status_code=500)

    # 2) 写入本地数据库
    ref_idx = result.get("ext_info", {}).get("ref_idx", "") if isinstance(result, dict) else ""
    quoted_sender = ""
    quoted_content = ""
    if message_reference and message_reference.get("message_id"):
        import sqlite3, os as _os
        try:
            qconn = sqlite3.connect(_os.path.join(_os.path.dirname(__file__), "neonbot.db"))
            qconn.row_factory = sqlite3.Row
            # message_reference.message_id 就是被引用消息的 QQ 消息 ID；旧消息无 ref_idx 时才按 ref_idx 兜底
            qrow = qconn.execute(
                "SELECT sender_name, content, attachments FROM messages WHERE conversation_id=? AND msg_id=? ORDER BY id DESC LIMIT 1",
                (conv_id, message_reference["message_id"])
            ).fetchone()
            if not qrow:
                qrow = qconn.execute(
                    "SELECT sender_name, content, attachments FROM messages WHERE conversation_id=? AND ref_idx=? ORDER BY id DESC LIMIT 1",
                    (conv_id, message_reference["message_id"])
                ).fetchone()
            qconn.close()
            if qrow:
                quoted_sender = qrow["sender_name"] or ""
                quoted_content = qrow["content"] or ""
                # 如果有附件，提取 URL 供缩略图使用
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
                            quote_thumbs = _j.dumps(thumbs, ensure_ascii=False)
                    except Exception:
                        pass
        except Exception:
            pass
    from database import bot_name
    saved = await save_message(
        conversation_id=conv_id,
        sender_openid="self",
        sender_name=bot_name + " 🤖",
        content=display_content,
        direction="outgoing",
        msg_id=str(result.get("id", "")),
        msg_type=msg_type,
        ref_idx=ref_idx,
        quoted_sender=quoted_sender,
        quoted_content=quoted_content,
        quote_thumbs=quote_thumbs,
        quoted_ref_idx=message_reference.get("message_id", "") if message_reference else "",
        account_id=_active_account_id(),
    )
    saved["account_name"] = _active_account_name()
    # 卡片消息：会话列表预览用占位文本（DB 内保留原始 JSON）
    if msg_type == 8:
        try:
            import sqlite3 as _sq, os as _os2
            _c = _sq.connect(_os2.path.join(_os2.path.dirname(__file__), "neonbot.db"))
            _c.execute("UPDATE conversations SET last_message = '[卡片消息]' WHERE id = ?", (conv_id,))
            _c.commit()
            _c.close()
            saved["content"] = display_content
        except Exception:
            pass

    # 3) 广播给所有 WebUI 客户端
    saved["conv_type"] = (await get_conversation(conv_id) or {}).get("type", "group")
    await manager.broadcast({
        "type": "new_message",
        "data": saved,
    })

    return {"ok": True, "message": saved, "api_result": result}


@app.post("/api/recall/{msg_db_id:int}")
async def api_recall_message(msg_db_id: int):
    """撤回消息（QQ 撤回 + 本地删除）"""
    from database import get_message_by_db_id, delete_message

    msg = await get_message_by_db_id(msg_db_id)
    if not msg:
        return JSONResponse({"error": "消息不存在"}, status_code=404)

    qq_msg_id = msg.get("msg_id", "")
    conv_id = msg["conversation_id"]

    # 调 QQ API 撤回（按会话类型分流：私聊 → C2C 撤回）
    if qq_msg_id:
        try:
            from database import get_conversation
            from PatchActiveMsg import recall_c2c_msg
            conv = await get_conversation(conv_id)
            if conv and conv.get("type") == "direct":
                result = await recall_c2c_msg(conv_id, qq_msg_id)
            else:
                result = await recall_group_msg(conv_id, qq_msg_id)
            # 检查 QQ API 是否返回了错误
            if result.get("code") or result.get("err_code"):
                err_msg = result.get("message", "") or result.get("msg", "") or "未知错误"
                return JSONResponse({"error": f"撤回失败：{err_msg}", "qq_code": result.get("code") or result.get("err_code")}, status_code=400)
        except Exception as e:
            return JSONResponse({"error": f"撤回失败: {str(e)}"}, status_code=500)

    # 本地标记撤回（保留原内容用于重编辑）
    from database import bot_name
    import sqlite3, os as _os
    def _do_recall():
        conn = sqlite3.connect(_os.path.join(_os.path.dirname(__file__), "neonbot.db"))
        conn.row_factory = sqlite3.Row
        conn.execute("UPDATE messages SET recalled=1 WHERE id=?", (msg_db_id,))
        # 预览：被撤回的是会话最新一条消息 → 显示撤回提示；
        # 否则显示最新一条消息（未被撤回的那条）
        top = conn.execute(
            "SELECT id, content, sender_name, direction FROM messages "
            "WHERE conversation_id=? ORDER BY id DESC LIMIT 1",
            (conv_id,)
        ).fetchone()
        if top and top["id"] == msg_db_id:
            tip = '你撤回了一条消息' if msg.get("direction") == 'outgoing' \
                else f'你撤回了成员{msg.get("sender_name") or ""}的一条消息'
            preview = (tip, '', '')
        else:
            preview = (top["content"][:200], top["sender_name"], top["direction"]) if top else ('', '', '')
        conn.execute(
            "UPDATE conversations SET last_message=?, last_sender=?, last_direction=? WHERE id=?",
            (*preview, conv_id),
        )
        row = conn.execute("SELECT * FROM messages WHERE id=?", (msg_db_id,)).fetchone()
        result = dict(row) if row else None
        if result:
            result["preview"] = {"last_message": preview[0], "last_sender": preview[1], "last_direction": preview[2]}
        conn.commit()
        conn.close()
        return result
    recalled = await asyncio.to_thread(_do_recall)
    if recalled:
        recalled["bot_name"] = bot_name
        await manager.broadcast({"type": "recall_message", "data": recalled})
        return {"ok": True}
    return JSONResponse({"error": "撤回失败"}, status_code=500)


@app.post("/api/messages/batch-delete")
async def api_batch_delete(request: Request):
    """批量删除消息（仅本地）"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    ids = body.get("ids", [])
    if not ids or not isinstance(ids, list):
        return JSONResponse({"error": "ids 不能为空"}, status_code=400)

    from database import delete_messages_batch
    deleted_ids = await delete_messages_batch([int(i) for i in ids])
    await manager.broadcast({"type": "batch_delete", "data": {"ids": deleted_ids}})
    return {"ok": True, "deleted": len(deleted_ids)}


@app.delete("/api/message/{msg_db_id:int}")
async def api_delete_message(msg_db_id: int):
    """本地删除单条消息（不撤回 QQ 端）"""
    from database import delete_message
    deleted = await delete_message(msg_db_id)
    if deleted:
        deleted["deleted"] = True
        await manager.broadcast({"type": "delete_message", "data": deleted})
        return {"ok": True}
    return JSONResponse({"error": "消息不存在"}, status_code=404)


# ── 账号管理 API ──────────────────────────────────────────

def _public_account(account: Optional[dict]) -> Optional[dict]:
    if not account:
        return None
    return {key: value for key, value in account.items() if key != "secret"}

@app.post("/api/accounts/login")
async def api_login_account(request: Request):
    """登录账号（验证 AppID/Secret 并启动 Bot）"""
    try:
        body = await request.json()
        appid = body.get("appid", "").strip()
        secret = body.get("secret", "").strip()
        
        if not appid or not secret:
            return JSONResponse({"error": "AppID 和 Secret 不能为空"}, status_code=400)
        
        from bot_manager import bot_manager
        result = await bot_manager.login(appid, secret)
        
        if result.get("ok"):
            return {"ok": True, "account": _public_account(result.get("account"))}
        else:
            return JSONResponse({"error": result.get("error", "登录失败")}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/accounts")
async def api_get_accounts():
    """获取所有已保存的账号"""
    from database import get_all_accounts
    accounts = await get_all_accounts()
    
    # 添加运行状态
    from bot_manager import bot_manager
    for account in accounts:
        account["is_running"] = bot_manager.is_running(account["appid"])
        account["is_active"] = bot_manager.get_active_appid() == account["appid"]
    
    return {"accounts": [_public_account(account) for account in accounts]}


@app.delete("/api/accounts/{appid}")
async def api_delete_account(appid: str):
    """删除账号"""
    from bot_manager import bot_manager
    await bot_manager.remove(appid)
    return {"ok": True}


@app.post("/api/accounts/{appid}/switch")
async def api_switch_account(appid: str):
    """切换当前账号"""
    from bot_manager import bot_manager
    result = await bot_manager.switch(appid)
    
    if result.get("ok"):
        return {"ok": True}
    else:
        return JSONResponse({"error": result.get("error", "切换失败")}, status_code=400)


@app.get("/api/accounts/current")
async def api_get_current_account():
    """获取当前账号信息"""
    from bot_manager import bot_manager
    bot = bot_manager.get_active()
    
    if bot:
        return {
            "ok": True,
            "account": {
                "appid": bot.appid,
                "bot_name": bot.bot_name,
                "bot_avatar": bot.bot_avatar,
                "is_running": bot.is_running,
            }
        }
    else:
        return {"ok": False, "account": None}


@app.post("/api/accounts/add")
async def api_add_account(request: Request):
    """添加新账号（不登录，仅保存）"""
    try:
        body = await request.json()
        appid = body.get("appid", "").strip()
        secret = body.get("secret", "").strip()
        
        if not appid or not secret:
            return JSONResponse({"error": "AppID 和 Secret 不能为空"}, status_code=400)
        
        from database import add_account
        account = await add_account(appid, secret)
        return {"ok": True, "account": _public_account(account)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            # 保持连接，接收客户端心跳
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        manager.disconnect(ws)
