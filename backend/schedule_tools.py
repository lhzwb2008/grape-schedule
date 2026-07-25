"""日程读写工具：供大模型 function calling 真正落库。提醒对象由模型按角色自动选定。"""

from __future__ import annotations

import re
import uuid
from typing import Any

from backend import store, storage

DAY_ALIASES = {
    "星期一": "周一",
    "星期二": "周二",
    "星期三": "周三",
    "星期四": "周四",
    "星期五": "周五",
    "星期六": "周六",
    "星期日": "周日",
    "星期天": "周日",
    "周一": "周一",
    "周二": "周二",
    "周三": "周三",
    "周四": "周四",
    "周五": "周五",
    "周六": "周六",
    "周日": "周日",
}

MEMBER_ALIAS = {
    "小葡萄": "xiaoputao",
    "葡萄": "xiaoputao",
    "孩子": "xiaoputao",
    "xiaoputao": "xiaoputao",
    "爸爸": "dad",
    "dad": "dad",
    "妈妈": "mom",
    "mom": "mom",
    "奶奶": "grandma",
    "grandma": "grandma",
}


def _slug(text: str) -> str:
    raw = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", (text or "").strip()).strip("-")
    return (raw[:24] or uuid.uuid4().hex[:8]).lower()


def _norm_days(days: list[str] | None) -> list[str]:
    out = []
    for d in days or []:
        key = str(d).strip()
        mapped = DAY_ALIASES.get(key) or DAY_ALIASES.get(key.replace("星期", "周"))
        if mapped and mapped not in out:
            out.append(mapped)
    return out


def _norm_hm(value: str | None) -> str:
    if not value:
        return ""
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(value).strip())
    if not m:
        raise ValueError(f"时间格式无效：{value}，请用 HH:MM")
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        raise ValueError(f"时间超出范围：{value}")
    return f"{h:02d}:{mi:02d}"


def _valid_member_ids() -> set[str]:
    return {m["id"] for m in storage.MEMBERS}


def resolve_member_id(raw: str) -> str | None:
    key = str(raw or "").strip()
    if not key:
        return None
    if key in _valid_member_ids():
        return key
    return MEMBER_ALIAS.get(key) or MEMBER_ALIAS.get(key.lower())


def normalize_reminders(raw: Any) -> list[dict[str, Any]]:
    """统一为 [{member_id, minutes_before}]，至少一人。"""
    valid = _valid_member_ids()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                mid = resolve_member_id(item)
                if mid and mid in valid and mid not in seen:
                    seen.add(mid)
                    out.append({"member_id": mid, "minutes_before": 30})
                continue
            if not isinstance(item, dict):
                continue
            mid = resolve_member_id(str(item.get("member_id") or item.get("id") or item.get("name") or ""))
            if not mid or mid not in valid or mid in seen:
                continue
            try:
                minutes = int(item.get("minutes_before") if item.get("minutes_before") is not None else item.get("minutes") or 30)
            except (TypeError, ValueError):
                minutes = 30
            minutes = max(0, min(minutes, 24 * 60))
            seen.add(mid)
            out.append({"member_id": mid, "minutes_before": minutes})

    if not out:
        raise ValueError("提醒对象不能为空：请按角色选择具体成员（小葡萄/爸爸/妈妈/奶奶）")
    return out


def format_at_mentions(reminders: list[dict[str, Any]]) -> str:
    parts = []
    for r in reminders or []:
        mid = r.get("member_id")
        m = storage.get_member(str(mid or ""))
        name = (m or {}).get("name") or mid
        mins = r.get("minutes_before", 30)
        parts.append(f"@{name}（提前{mins}分）")
    return " ".join(parts)


TOOLS_PARENT: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_schedule",
            "description": "读取当前已持久化的真实日程。回答行程前应先确认库里有什么。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_home",
            "description": "设置家的真实地址。禁止填写示例/虚构地址。",
            "parameters": {
                "type": "object",
                "properties": {
                    "address": {"type": "string"},
                    "name": {"type": "string"},
                    "lat": {"type": ["number", "null"]},
                    "lng": {"type": ["number", "null"]},
                },
                "required": ["address"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "upsert_place",
            "description": "新增或更新真实地点（学校、琴房等）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": "string"},
                    "address": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_place",
            "description": "删除地点",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "upsert_travel_buffer",
            "description": "设置两地之间真实路程缓冲（分钟）",
            "parameters": {
                "type": "object",
                "properties": {
                    "from_place_id": {"type": "string"},
                    "to_place_id": {"type": "string"},
                    "minutes": {"type": "integer"},
                    "mode": {"type": "string"},
                },
                "required": ["from_place_id", "to_place_id", "minutes"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "upsert_weekly_event",
            "description": (
                "新增或更新每周重复日程。家长用自然语言告知行程时必须调用此工具落库。"
                "reminders 必填：由你根据角色自动选择需要知情的人（用户不会在对话里写@）。"
                "例如钢琴课：小葡萄 + 实际接送的家长；提前分钟数可按路程自行估算。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "days": {"type": "array", "items": {"type": "string"}},
                    "start": {"type": "string", "description": "HH:MM"},
                    "end": {"type": "string", "description": "HH:MM"},
                    "place_id": {"type": "string"},
                    "reminders": {
                        "type": "array",
                        "description": "由你按角色自动选择知情对象，如 [{member_id:'xiaoputao',minutes_before:20},{member_id:'mom',minutes_before:55}]",
                        "items": {
                            "type": "object",
                            "properties": {
                                "member_id": {"type": "string"},
                                "minutes_before": {"type": "integer"},
                            },
                            "required": ["member_id", "minutes_before"],
                        },
                    },
                    "notes": {"type": "string"},
                },
                "required": ["title", "days", "start", "end", "reminders"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_weekly_event",
            "description": "删除周程条目",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "upsert_one_off_event",
            "description": "新增或更新单次日程。reminders 必填，由你按角色自动选择知情对象。",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                    "place_id": {"type": "string"},
                    "reminders": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "member_id": {"type": "string"},
                                "minutes_before": {"type": "integer"},
                            },
                            "required": ["member_id", "minutes_before"],
                        },
                    },
                    "notes": {"type": "string"},
                },
                "required": ["title", "date", "start", "end", "reminders"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_one_off_event",
            "description": "删除单次日程",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clear_all_events",
            "description": "清空全部周程与单次日程（地点可保留）。仅在家长明确要求清空时使用。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
]

TOOLS_CHILD: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_schedule",
            "description": "读取当前真实日程，只能据此回答，不能编造",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
]


def tools_for_role(role: str) -> list[dict[str, Any]]:
    return TOOLS_PARENT if role == "parent" else TOOLS_CHILD


def _ok(result: Any) -> dict[str, Any]:
    return {"ok": True, "result": result}


def _err(message: str) -> dict[str, Any]:
    return {"ok": False, "error": message}


def execute_tool(name: str, args: dict[str, Any] | None, *, by: str) -> dict[str, Any]:
    args = args or {}
    try:
        if name == "get_schedule":
            return _ok(store.get_schedule())

        if name == "set_home":
            address = str(args.get("address") or "").strip()
            if not address or "示例" in address or "example" in address.lower():
                return _err("地址无效：请提供真实住址，不要用示例")
            home_name = str(args.get("name") or "家").strip() or "家"

            def _mut(data: dict[str, Any]) -> None:
                sch = data["schedule"]
                sch["home"] = {
                    "name": home_name,
                    "address": address,
                    "lat": args.get("lat"),
                    "lng": args.get("lng"),
                }
                # 家只存在 home 字段，避免 places 里再塞一条造成重复
                sch["places"] = [
                    p
                    for p in (sch.get("places") or [])
                    if p.get("id") != "home" and (p.get("name") or "") not in (home_name, "家")
                ]

            store.update_store(_mut, by=by, action="set_home")
            return _ok(store.get_schedule()["home"])

        if name == "upsert_place":
            place_name = str(args.get("name") or "").strip()
            if not place_name:
                return _err("地点名称不能为空")
            address = str(args.get("address") or "").strip()
            if address and ("示例" in address or "example" in address.lower()):
                return _err("地址无效：禁止示例地址")
            pid = str(args.get("id") or "").strip() or _slug(place_name)
            # 「家」走 set_home，避免与 home 重复
            if pid == "home" or place_name in ("家", "家里", "home"):
                if not address:
                    return _err("录入家地址时请提供真实住址")
                return execute_tool(
                    "set_home",
                    {"address": address, "name": "家", "lat": args.get("lat"), "lng": args.get("lng")},
                    by=by,
                )

            def _mut(data: dict[str, Any]) -> None:
                places = data["schedule"].setdefault("places", [])
                for p in places:
                    if p.get("id") == pid:
                        p["name"] = place_name
                        if address:
                            p["address"] = address
                        if args.get("notes") is not None:
                            p["notes"] = str(args.get("notes") or "")
                        return
                places.append(
                    {
                        "id": pid,
                        "name": place_name,
                        "address": address,
                        "notes": str(args.get("notes") or ""),
                    }
                )

            store.update_store(_mut, by=by, action="upsert_place")
            return _ok({"id": pid, "name": place_name, "address": address})

        if name == "remove_place":
            pid = str(args.get("id") or "").strip()
            if not pid:
                return _err("缺少 id")

            def _mut(data: dict[str, Any]) -> None:
                data["schedule"]["places"] = [p for p in (data["schedule"].get("places") or []) if p.get("id") != pid]

            store.update_store(_mut, by=by, action="remove_place")
            return _ok({"removed": pid})

        if name == "upsert_travel_buffer":
            frm = str(args.get("from_place_id") or "").strip()
            to = str(args.get("to_place_id") or "").strip()
            minutes = int(args.get("minutes"))
            if not frm or not to:
                return _err("缺少 from/to")
            if minutes < 0 or minutes > 24 * 60:
                return _err("minutes 无效")

            def _mut(data: dict[str, Any]) -> None:
                bufs = data["schedule"].setdefault("travel_buffers", [])
                for t in bufs:
                    if t.get("from") == frm and t.get("to") == to:
                        t["minutes"] = minutes
                        t["mode"] = str(args.get("mode") or t.get("mode") or "家长接送")
                        return
                bufs.append(
                    {
                        "from": frm,
                        "to": to,
                        "minutes": minutes,
                        "mode": str(args.get("mode") or "家长接送"),
                    }
                )

            store.update_store(_mut, by=by, action="upsert_travel")
            return _ok({"from": frm, "to": to, "minutes": minutes})

        if name == "upsert_weekly_event":
            title = str(args.get("title") or "").strip()
            days = _norm_days(args.get("days") if isinstance(args.get("days"), list) else [])
            start = _norm_hm(args.get("start"))
            end = _norm_hm(args.get("end"))
            if not title or not days or not start or not end:
                return _err("周程需要 title、days、start、end")
            try:
                reminders = normalize_reminders(args.get("reminders"))
            except ValueError as e:
                return _err(str(e))
            eid = str(args.get("id") or "").strip() or _slug(f"{title}-{days[0]}-{start}")
            place_id = str(args.get("place_id") or "").strip()
            event = {
                "id": eid,
                "title": title,
                "days": days,
                "start": start,
                "end": end,
                "place_id": place_id,
                "reminders": reminders,
                "notes": str(args.get("notes") or ""),
            }

            def _mut(data: dict[str, Any]) -> None:
                weekly = data["schedule"].setdefault("weekly", [])
                for i, ev in enumerate(weekly):
                    if ev.get("id") == eid:
                        weekly[i] = {**ev, **event}
                        # 清理旧字段
                        weekly[i].pop("notify_roles", None)
                        weekly[i].pop("remind_child_minutes", None)
                        weekly[i].pop("remind_parent_minutes", None)
                        return
                weekly.append(event)

            store.update_store(_mut, by=by, action="upsert_weekly")
            return _ok({**event, "at": format_at_mentions(reminders)})

        if name == "remove_weekly_event":
            eid = str(args.get("id") or "").strip()
            if not eid:
                return _err("缺少 id")

            def _mut(data: dict[str, Any]) -> None:
                data["schedule"]["weekly"] = [e for e in (data["schedule"].get("weekly") or []) if e.get("id") != eid]

            store.update_store(_mut, by=by, action="remove_weekly")
            return _ok({"removed": eid})

        if name == "upsert_one_off_event":
            title = str(args.get("title") or "").strip()
            date = str(args.get("date") or "").strip()
            start = _norm_hm(args.get("start"))
            end = _norm_hm(args.get("end"))
            if not title or not date or not start or not end:
                return _err("单次日程需要 title、date、start、end")
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
                return _err("date 需为 YYYY-MM-DD")
            try:
                reminders = normalize_reminders(args.get("reminders"))
            except ValueError as e:
                return _err(str(e))
            eid = str(args.get("id") or "").strip() or _slug(f"{title}-{date}-{start}")
            event = {
                "id": eid,
                "title": title,
                "date": date,
                "start": start,
                "end": end,
                "place_id": str(args.get("place_id") or "").strip(),
                "reminders": reminders,
                "notes": str(args.get("notes") or ""),
            }

            def _mut(data: dict[str, Any]) -> None:
                items = data["schedule"].setdefault("one_off", [])
                for i, ev in enumerate(items):
                    if ev.get("id") == eid:
                        items[i] = {**ev, **event}
                        items[i].pop("notify_roles", None)
                        items[i].pop("remind_child_minutes", None)
                        items[i].pop("remind_parent_minutes", None)
                        return
                items.append(event)

            store.update_store(_mut, by=by, action="upsert_one_off")
            return _ok({**event, "at": format_at_mentions(reminders)})

        if name == "remove_one_off_event":
            eid = str(args.get("id") or "").strip()
            if not eid:
                return _err("缺少 id")

            def _mut(data: dict[str, Any]) -> None:
                data["schedule"]["one_off"] = [e for e in (data["schedule"].get("one_off") or []) if e.get("id") != eid]

            store.update_store(_mut, by=by, action="remove_one_off")
            return _ok({"removed": eid})

        if name == "clear_all_events":

            def _mut(data: dict[str, Any]) -> None:
                data["schedule"]["weekly"] = []
                data["schedule"]["one_off"] = []

            store.update_store(_mut, by=by, action="clear_events")
            return _ok({"cleared": True})

        return _err(f"未知工具：{name}")
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))
