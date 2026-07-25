"""自迭代深度功能：需口令激活；激活后可用 Cursor Agent 改代码（脚手架）。"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from backend import storage


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def activation_code() -> str:
    return os.environ.get("SELF_ITERATE_ACTIVATION_CODE", "").strip()


def is_configured() -> bool:
    return bool(activation_code())


def status() -> dict[str, Any]:
    data = storage.load_self_iterate()
    return {
        "configured": is_configured(),
        "activated": bool(data.get("activated")),
        "activated_at": data.get("activated_at"),
        "history_count": len(data.get("history") or []),
    }


def activate(code: str, *, by_user: str) -> dict[str, Any]:
    expected = activation_code()
    if not expected:
        raise ValueError("服务端未配置自迭代激活口令，功能未开放")
    if (code or "").strip() != expected:
        raise ValueError("激活口令不正确")
    data = storage.load_self_iterate()
    data["activated"] = True
    data["activated_at"] = _now()
    data["activated_by"] = by_user
    hist = data.get("history") or []
    hist.append({"type": "activate", "by": by_user, "at": _now()})
    data["history"] = hist[-50:]
    storage.save_self_iterate(data)
    return status()


def deactivate(*, by_user: str) -> dict[str, Any]:
    data = storage.load_self_iterate()
    data["activated"] = False
    hist = data.get("history") or []
    hist.append({"type": "deactivate", "by": by_user, "at": _now()})
    data["history"] = hist[-50:]
    storage.save_self_iterate(data)
    return status()


def require_activated() -> None:
    data = storage.load_self_iterate()
    if not data.get("activated"):
        raise PermissionError("自迭代未激活：请先在家长端完成深度激活")


def record_request(user_id: str, message: str, result_meta: dict[str, Any] | None = None) -> None:
    data = storage.load_self_iterate()
    hist = data.get("history") or []
    hist.append(
        {
            "type": "request",
            "by": user_id,
            "message": (message or "")[:500],
            "meta": result_meta or {},
            "at": _now(),
        }
    )
    data["history"] = hist[-50:]
    storage.save_self_iterate(data)
