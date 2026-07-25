"""统一持久化存储：日程、自迭代状态、变更日志（单文件 app_store.json）。"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STORE_PATH = DATA_DIR / "app_store.json"
LEGACY_SCHEDULE = DATA_DIR / "schedule.json"
LEGACY_SELF_ITERATE = DATA_DIR / "self_iterate.json"

_lock = threading.Lock()

EMPTY_SCHEDULE: dict[str, Any] = {
    "child_name": "小葡萄",
    "timezone": "Asia/Shanghai",
    "home": {"name": "家", "address": "", "lat": None, "lng": None},
    "places": [],
    "travel_buffers": [],
    "weekly": [],
    "one_off": [],
    "reminder_rules": {
        "child_tone": "亲切、简短、鼓励",
        "parent_tone": "清晰、可执行，包含地点、出发时间、接送建议",
        "default_advance_minutes": 30,
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_store() -> dict[str, Any]:
    return {
        "version": 1,
        "updated_at": None,
        "schedule": json.loads(json.dumps(EMPTY_SCHEDULE)),
        "self_iterate": {
            "activated": False,
            "activated_at": None,
            "activated_by": None,
            "history": [],
        },
        "change_log": [],
    }


def ensure_store() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if STORE_PATH.exists():
        return
    # 首次：写入空真实结构，不迁移旧 mock 日程
    store = _default_store()
    STORE_PATH.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    # 清理遗留演示文件，避免双源
    for legacy in (LEGACY_SCHEDULE, LEGACY_SELF_ITERATE):
        if legacy.exists():
            try:
                legacy.unlink()
            except OSError:
                pass


def _read() -> dict[str, Any]:
    ensure_store()
    data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    if "schedule" not in data:
        data["schedule"] = json.loads(json.dumps(EMPTY_SCHEDULE))
    if "self_iterate" not in data:
        data["self_iterate"] = _default_store()["self_iterate"]
    if "change_log" not in data:
        data["change_log"] = []
    return data


def _write(data: dict[str, Any]) -> dict[str, Any]:
    ensure_store()
    data["updated_at"] = _now()
    STORE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def load_store() -> dict[str, Any]:
    with _lock:
        return _read()


def update_store(mutator: Callable[[dict[str, Any]], None], *, by: str = "system", action: str = "update") -> dict[str, Any]:
    with _lock:
        data = _read()
        before = json.dumps(data.get("schedule"), ensure_ascii=False, sort_keys=True)
        mutator(data)
        after = json.dumps(data.get("schedule"), ensure_ascii=False, sort_keys=True)
        if before != after or action.startswith("self_iterate"):
            log = data.get("change_log") or []
            log.append({"id": uuid.uuid4().hex[:10], "at": _now(), "by": by, "action": action})
            data["change_log"] = log[-200:]
        return _write(data)


def get_schedule() -> dict[str, Any]:
    return load_store()["schedule"]


def save_schedule(schedule: dict[str, Any], *, by: str = "api") -> dict[str, Any]:
    if not isinstance(schedule, dict):
        raise ValueError("schedule 必须是对象")

    def _mut(data: dict[str, Any]) -> None:
        merged = json.loads(json.dumps(EMPTY_SCHEDULE))
        for key in (
            "child_name",
            "timezone",
            "home",
            "places",
            "travel_buffers",
            "weekly",
            "one_off",
            "reminder_rules",
        ):
            if key in schedule:
                merged[key] = schedule[key]
        # 列表字段必须是 list
        for key in ("places", "travel_buffers", "weekly", "one_off"):
            if not isinstance(merged.get(key), list):
                merged[key] = []
        data["schedule"] = merged

    return update_store(_mut, by=by, action="save_schedule")["schedule"]


def get_self_iterate() -> dict[str, Any]:
    return load_store()["self_iterate"]


def save_self_iterate(payload: dict[str, Any], *, by: str = "api") -> dict[str, Any]:
    def _mut(data: dict[str, Any]) -> None:
        data["self_iterate"] = payload

    return update_store(_mut, by=by, action="self_iterate_update")["self_iterate"]


def reset_schedule_empty(*, by: str = "system") -> dict[str, Any]:
    """清空为无演示数据的空日程。"""

    def _mut(data: dict[str, Any]) -> None:
        data["schedule"] = json.loads(json.dumps(EMPTY_SCHEDULE))

    return update_store(_mut, by=by, action="reset_schedule")["schedule"]
