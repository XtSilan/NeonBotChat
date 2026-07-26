"""
file_server.py — 图床/文件服务器（独立配置，独立启动）
启动方式: python file_server/file_server.py
"""
import os
import time
import hashlib
import logging
from pathlib import Path

from fastapi import FastAPI, Request, UploadFile, File, HTTPException
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

log = logging.getLogger("file_server")
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(name)s] %(message)s", datefmt="%H:%M:%S")


# ═══════════════════════════════════════════════════
# 配置（从同目录 config.yaml 读取）
# ═══════════════════════════════════════════════════

def _load_config():
    config_path = os.path.join(os.path.dirname(__file__), "config.yaml")
    if not os.path.isfile(config_path):
        return {}
    with open(config_path, "r", encoding="utf-8") as f:
        raw = f.read()
    try:
        from botpy.ext.cog_yaml import read
        return read(config_path) or {}
    except Exception:
        pass
    try:
        import yaml
        return yaml.safe_load(raw) or {}
    except Exception:
        pass
    return {}

_cfg = _load_config()

HOST = _cfg.get("host", "0.0.0.0")
PORT = int(_cfg.get("port", 36337))
AUTH_TOKEN = _cfg.get("token", "")
CACHE_DIR = _cfg.get("cache-dir", os.path.join(os.path.dirname(__file__), "file_cache"))
MAX_CACHE_MB = int(_cfg.get("max-cache-mb", 1024))
MAX_FILE_MB = int(_cfg.get("max-file-mb", 100))
PUBLIC_BASE_URL = _cfg.get("public-url", "").rstrip("/")

os.makedirs(CACHE_DIR, exist_ok=True)
META_FILE = os.path.join(CACHE_DIR, ".meta.json")


# ═══════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════

def _load_meta() -> dict:
    import json as _json
    if os.path.isfile(META_FILE):
        with open(META_FILE, "r", encoding="utf-8") as f:
            return _json.load(f)
    return {}

def _save_meta(meta: dict) -> None:
    import json as _json
    with open(META_FILE, "w", encoding="utf-8") as f:
        _json.dump(meta, f, ensure_ascii=False)

def _get_cache_size_mb() -> float:
    total = 0.0
    for f in Path(CACHE_DIR).rglob("*"):
        if f.is_file() and f.name != ".meta.json":
            total += f.stat().st_size
    return total / (1024 * 1024)

def _evict_if_needed() -> None:
    meta = _load_meta()
    current = _get_cache_size_mb()
    if current <= MAX_CACHE_MB:
        return
    log.warning(f"[EVICT] 缓存超限 {current:.1f}/{MAX_CACHE_MB}MB，开始清理…")
    removed = 0
    for fid, info in sorted(meta.items(), key=lambda x: x[1].get("atime", 0) if isinstance(x[1], dict) else 0):
        fp = os.path.join(CACHE_DIR, fid)
        if os.path.isfile(fp):
            os.remove(fp)
        del meta[fid]
        removed += 1
        if _get_cache_size_mb() <= MAX_CACHE_MB * 0.8:
            break
    _save_meta(meta)
    log.info(f"[EVICT] 清理完成，移除了 {removed} 个文件")

def _check_auth(request: Request) -> None:
    if not AUTH_TOKEN:
        return
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


# ═══════════════════════════════════════════════════
# FastAPI App
# ═══════════════════════════════════════════════════

app = FastAPI(title="NeonBot File Server", version="1.0.0")


@app.post("/upload")
async def upload_file(request: Request, file: UploadFile = File(...)):
    _check_auth(request)

    if not file.filename:
        return JSONResponse({"code": 400, "message": "文件名不能为空"}, status_code=400)

    data = await file.read()
    size_mb = len(data) / (1024 * 1024)
    log.info(f"[UPLOAD] 收到: {file.filename} ({size_mb:.2f}MB)")

    if size_mb > MAX_FILE_MB:
        log.warning(f"[UPLOAD] 文件过大: {size_mb:.2f}MB > {MAX_FILE_MB}MB")
        return JSONResponse({"code": 413, "message": f"文件过大（{size_mb:.1f}MB），上限 {MAX_FILE_MB}MB"}, status_code=413)

    # 去重
    content_hash = hashlib.sha256(data).hexdigest()
    meta = _load_meta()
    for existing_fid, info in list(meta.items()):
        if isinstance(info, dict) and info.get("hash") == content_hash:
            if os.path.isfile(os.path.join(CACHE_DIR, existing_fid)):
                meta[existing_fid]["atime"] = time.time()
                _save_meta(meta)
                url = f"{PUBLIC_BASE_URL}/get/{existing_fid}" if PUBLIC_BASE_URL else f"/get/{existing_fid}"
                log.info(f"[UPLOAD] 去重命中 → {existing_fid}")
                return {"code": 200, "file_id": existing_fid, "url": url, "size": info["size"], "message": "上传成功（去重）"}

    # 新文件
    h = hashlib.sha256(data + str(time.time()).encode()).hexdigest()[:16]
    ext = os.path.splitext(file.filename)[1] or ""
    fid = f"{h}{ext}"
    fp = os.path.join(CACHE_DIR, fid)
    with open(fp, "wb") as f:
        f.write(data)

    meta[fid] = {
        "filename": file.filename,
        "content_type": file.content_type or "application/octet-stream",
        "size": len(data),
        "hash": content_hash,
        "atime": time.time(),
        "ctime": time.time(),
    }
    _save_meta(meta)

    try:
        _evict_if_needed()
    except Exception:
        pass

    url = f"{PUBLIC_BASE_URL}/get/{fid}" if PUBLIC_BASE_URL else f"/get/{fid}"
    log.info(f"[UPLOAD] 完成 → {fid} ({size_mb:.2f}MB)")
    return {"code": 200, "file_id": fid, "url": url, "size": len(data), "message": "上传成功"}


@app.get("/get/{file_id}")
async def get_file(file_id: str):
    fid = os.path.basename(file_id)
    fp = os.path.join(CACHE_DIR, fid)
    if not os.path.isfile(fp):
        return JSONResponse({"code": 404, "message": "文件不存在或已过期"}, status_code=404)

    try:
        meta = _load_meta()
        if fid in meta:
            if isinstance(meta[fid], dict):
                meta[fid]["atime"] = time.time()
            else:
                meta[fid] = {"atime": time.time()}
        _save_meta(meta)
    except Exception:
        pass

    info = _load_meta().get(fid, {})
    ct = info.get("content_type", "application/octet-stream") if isinstance(info, dict) else "application/octet-stream"
    fn = info.get("filename", fid) if isinstance(info, dict) else fid
    return FileResponse(fp, media_type=ct, filename=fn)


@app.get("/api/status")
async def api_status(request: Request):
    _check_auth(request)
    cache_mb = _get_cache_size_mb()
    file_count = len(_load_meta())
    return {
        "cache_size_mb": round(cache_mb, 2),
        "max_cache_mb": MAX_CACHE_MB,
        "file_count": file_count,
        "cache_dir": CACHE_DIR,
        "usage_percent": round(cache_mb / MAX_CACHE_MB * 100, 1) if MAX_CACHE_MB else 0,
    }


# ═══════════════════════════════════════════════════

if __name__ == "__main__":
    log.info(f"缓存: {CACHE_DIR} (最大 {MAX_CACHE_MB}MB)")
    log.info(f"鉴权: {'已启用' if AUTH_TOKEN else '未启用'}")
    log.info(f"监听: http://{HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning", access_log=False)
