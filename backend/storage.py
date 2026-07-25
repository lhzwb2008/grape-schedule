"""本地文件存储：会话；日程走统一 store。无密码。"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend import store as app_store

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SESSIONS_DIR = DATA_DIR / "sessions"

MEMBERS = [
    {"id": "xiaoputao", "name": "小葡萄", "emoji": "🍇", "color": "#6B3FA0", "role": "child"},
    {"id": "dad", "name": "爸爸", "emoji": "👨", "color": "#1F7AEC", "role": "parent"},
    {"id": "mom", "name": "妈妈", "emoji": "👩", "color": "#E85D75", "role": "parent"},
    {"id": "grandma", "name": "奶奶", "emoji": "👵", "color": "#D97706", "role": "parent"},
]

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for m in MEMBERS:
        (SESSIONS_DIR / m["id"]).mkdir(parents=True, exist_ok=True)
    app_store.ensure_store()


def list_members(*, role: str | None = None) -> list[dict[str, Any]]:
    ensure_dirs()
    result = []
    for m in MEMBERS:
        if role and m["role"] != role:
            continue
        result.append({**m})
    return result


def _session_dir(user_id: str) -> Path:
    d = SESSIONS_DIR / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _session_path(user_id: str, session_id: str) -> Path:
    return _session_dir(user_id) / f"{session_id}.json"


def get_member(user_id: str) -> dict[str, Any] | None:
    for m in MEMBERS:
        if m["id"] == user_id:
            return m
    return None


def login(user_id: str) -> dict[str, Any]:
    """无密码：选身份即进入。"""
    member = get_member(user_id)
    if not member:
        raise ValueError("未知账户")
    ensure_dirs()
    return {**member}


def load_schedule() -> dict[str, Any]:
    ensure_dirs()
    return app_store.get_schedule()


def save_schedule(data: dict[str, Any], *, by: str = "api") -> dict[str, Any]:
    ensure_dirs()
    return app_store.save_schedule(data, by=by)


def list_sessions(user_id: str) -> list[dict[str, Any]]:
    if not get_member(user_id):
        raise ValueError("未知账户")
    ensure_dirs()
    items = []
    for path in sorted(_session_dir(user_id).glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        data = json.loads(path.read_text(encoding="utf-8"))
        items.append(
            {
                "id": data["id"],
                "title": data.get("title") or "新对话",
                "updated_at": data.get("updated_at"),
                "created_at": data.get("created_at"),
            }
        )
    return items


def create_session(user_id: str, title: str = "新对话") -> dict[str, Any]:
    if not get_member(user_id):
        raise ValueError("未知账户")
    ensure_dirs()
    sid = uuid.uuid4().hex[:12]
    session = {
        "id": sid,
        "user_id": user_id,
        "title": title or "新对话",
        "messages": [],
        "agent_id": None,
        "created_at": _now(),
        "updated_at": _now(),
    }
    _session_path(user_id, sid).write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    return session


def get_session(user_id: str, session_id: str) -> dict[str, Any]:
    path = _session_path(user_id, session_id)
    if not path.exists():
        raise FileNotFoundError("会话不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def delete_session(user_id: str, session_id: str) -> None:
    path = _session_path(user_id, session_id)
    if not path.exists():
        raise FileNotFoundError("会话不存在")
    path.unlink()


def append_message(
    user_id: str,
    session_id: str,
    role: str,
    content: str,
    *,
    agent_id: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    with _lock:
        session = get_session(user_id, session_id)
        msg: dict[str, Any] = {
            "id": uuid.uuid4().hex[:10],
            "role": role,
            "content": content,
            "created_at": _now(),
        }
        if model:
            msg["model"] = model
        session["messages"].append(msg)
        if agent_id:
            session["agent_id"] = agent_id
        if role == "user" and len(session["messages"]) == 1:
            title = content.strip().replace("\n", " ")[:24] or "新对话"
            session["title"] = title
        session["updated_at"] = _now()
        _session_path(user_id, session_id).write_text(
            json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return session
