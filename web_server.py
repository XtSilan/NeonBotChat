"""
web_server.py — FastAPI + WebSocket 实时推送
桥接 QQ Bot ↔ WebUI
"""
import asyncio
import json
import queue
import os
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
import aiohttp
from urllib.parse import unquote

from database import (
    init_db, get_conversations, get_messages, get_recent_messages,
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
TEMPLATES = os.path.join(os.path.dirname(__file__), "templates")
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


@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = os.path.join(TEMPLATES, "index.html")
    if os.path.isfile(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>index.html 未找到</h1>", status_code=404)


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

    file_url = body.get("url", "")
    conv_id = body.get("conv_id", "")
    file_type = body.get("file_type", "image")
    file_name = body.get("file_name", "")
    if not file_url or not conv_id:
        return JSONResponse({"error": "缺少 url 或 conv_id"}, status_code=400)

    from botpy import logging as _blog
    _log = _blog.get_logger("NeonBotChat")
    _log.info(f"📤 [send-media] 图床链接: {file_url}  → 群: {conv_id}")

    # 通过 URL 上传，srv_send_msg=True 自动发送（无需二次调用）
    try:
        from PatchActiveMsg import upload_group_media_by_url
        result = await upload_group_media_by_url(conv_id, file_url, file_type=file_type, srv_send_msg=True, file_name=file_name)
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
        saved = await _db.save_message(
            conversation_id=conv_id,
            sender_openid="self",
            sender_name=_db.bot_name + " 🤖",
            content=placeholder,
            direction="outgoing",
            msg_type=0,
            msg_id=qq_msg_id,
            attachments=attachments,
        )
        await manager.broadcast({"type": "new_message", "data": saved})
        return {"ok": True, "message": saved, "qq_result": result}
    except Exception as e:
        return JSONResponse({"error": f"发送失败: {str(e)}"}, status_code=500)
    except Exception as e:
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
    return _load_settings()


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
async def api_conversations(limit: int = 50):
    convs = await get_conversations(limit)
    return {"conversations": convs}


@app.post("/api/conversations")
async def api_add_conversation(request: Request):
    """手动添加群聊到会话列表"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    group_openid: str = (body.get("group_openid") or "").strip()
    group_name: str = (body.get("name") or "").strip()

    if not group_openid:
        return JSONResponse({"error": "group_openid 不能为空"}, status_code=400)

    name = group_name or f"群聊 {group_openid[:10]}"
    await upsert_conversation(group_openid, name=name, conv_type="group")

    return {"ok": True, "id": group_openid, "name": name}


@app.patch("/api/conversations/{conv_id}")
async def api_rename_conversation(conv_id: str, request: Request):
    """修改会话备注名"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    new_name = (body.get("name") or "").strip()
    if not new_name:
        return JSONResponse({"error": "name 不能为空"}, status_code=400)

    from database import rename_conversation
    await rename_conversation(conv_id, new_name)
    return {"ok": True, "id": conv_id, "name": new_name}


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


@app.get("/api/messages/{conv_id}")
async def api_messages(conv_id: str, limit: int = 50, before: int = 0):
    msgs = await get_messages(conv_id, limit=limit, before_id=before)
    # 标记已读
    await reset_unread(conv_id)
    return {"messages": msgs}


@app.post("/api/send")
async def api_send(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    conv_id: str = body.get("conv_id", "")
    content: str = body.get("content", "")
    msg_type: int = body.get("msg_type", 0)

    if not conv_id or not content.strip():
        return JSONResponse({"error": "conv_id 和 content 不能为空"}, status_code=400)

    # 1) 标记 outgoing（防止 WebSocket 回显重复入库）
    from database import mark_outgoing
    mark_outgoing(conv_id, content)

    # 2) 调用 QQ API 发送
    try:
        result = await send_group_msg(conv_id, content, msg_type=msg_type)
        # 检查 QQ API 是否返回了错误
        if result.get("code") or result.get("err_code") or result.get("error"):
            err_msg = result.get("message", "") or result.get("msg", "") or result.get("error", "") or "未知错误"
            return JSONResponse({"error": f"发送失败：{err_msg}"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"发送失败: {str(e)}"}, status_code=500)

    # 2) 写入本地数据库
    from database import bot_name
    saved = await save_message(
        conversation_id=conv_id,
        sender_openid="self",
        sender_name=bot_name + " 🤖",
        content=content,
        direction="outgoing",
        msg_id=str(result.get("id", "")),
        msg_type=msg_type,
    )

    # 3) 广播给所有 WebUI 客户端
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

    # 调 QQ API 撤回
    if qq_msg_id:
        try:
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
        conn.execute(
            "UPDATE conversations SET last_message='你撤回了一条消息', last_sender='', last_direction='' WHERE id=?",
            (conv_id,)
        )
        row = conn.execute("SELECT * FROM messages WHERE id=?", (msg_db_id,)).fetchone()
        conn.commit()
        conn.close()
        return dict(row) if row else None
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
