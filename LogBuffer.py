"""
LogBuffer.py — 捕获全部 Python 日志到环形缓冲，供 WebUI「日志」页读取
=======================================================================
用法：
    from LogBuffer import install
    install()   # 挂到 root logger，之后所有日志都会进缓冲
"""
import logging
import threading
import time
from collections import deque
from itertools import count

MAX_LOGS = 500

_log_buffer: deque = deque(maxlen=MAX_LOGS)
_seq = count(1)
_lock = threading.Lock()


class MemoryLogHandler(logging.Handler):
    """把每条日志记录格式化后写入环形缓冲"""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            ts = time.strftime("%H:%M:%S", time.localtime(record.created))
            msg = record.getMessage()
            with _lock:
                _log_buffer.append({
                    "seq": next(_seq),
                    "time": ts,
                    "level": record.levelname,
                    "msg": msg,
                })
        except Exception:
            pass  # 日志处理失败绝不能影响主流程


def install() -> None:
    """挂载到 root logger，捕获所有传播到 root 的日志（INFO 及以上，与控制台一致）"""
    root = logging.getLogger()
    root.setLevel(logging.INFO)  # 确保 INFO 能传播到我们的 handler
    handler = MemoryLogHandler()
    handler.setLevel(logging.INFO)
    root.addHandler(handler)


def get_logs(since: int = 0) -> dict:
    """返回 seq > since 的增量日志 + 最新 seq"""
    with _lock:
        items = list(_log_buffer)
    logs = [it for it in items if it["seq"] > since]
    latest = items[-1]["seq"] if items else 0
    return {"logs": logs, "latest_seq": latest}
