"""日程上下文：把预制日程表转成每次 chat 可注入的文本。"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from backend import storage

WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def _tz() -> ZoneInfo:
    try:
        return ZoneInfo("Asia/Shanghai")
    except Exception:  # noqa: BLE001
        return ZoneInfo("UTC")


def now_local() -> datetime:
    return datetime.now(_tz())


def place_map(schedule: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {p["id"]: p for p in (schedule.get("places") or []) if isinstance(p, dict) and p.get("id")}


def travel_minutes(schedule: dict[str, Any], frm: str, to: str) -> int | None:
    for t in schedule.get("travel_buffers") or []:
        if t.get("from") == frm and t.get("to") == to:
            try:
                return int(t.get("minutes") or 0)
            except (TypeError, ValueError):
                return None
    return None


def today_items(schedule: dict[str, Any], *, when: datetime | None = None) -> list[dict[str, Any]]:
    when = when or now_local()
    day = WEEKDAY_CN[when.weekday()]
    places = place_map(schedule)
    items = []
    for ev in schedule.get("weekly") or []:
        if day not in (ev.get("days") or []):
            continue
        place = places.get(ev.get("place_id") or "", {})
        items.append(
            {
                **ev,
                "day": day,
                "place_name": place.get("name") or ev.get("place_id") or "未知地点",
                "place_address": place.get("address") or "",
            }
        )
    for ev in schedule.get("one_off") or []:
        if ev.get("date") == when.strftime("%Y-%m-%d"):
            place = places.get(ev.get("place_id") or "", {})
            items.append(
                {
                    **ev,
                    "day": day,
                    "place_name": place.get("name") or ev.get("place_id") or "未知地点",
                    "place_address": place.get("address") or "",
                }
            )
    items.sort(key=lambda x: x.get("start") or "99:99")
    return items


def upcoming_reminders(schedule: dict[str, Any], *, role: str, when: datetime | None = None) -> list[dict[str, Any]]:
    """粗略计算今日即将到来的提醒（不含持久化推送，供看板/上下文使用）。"""
    when = when or now_local()
    now_hm = when.strftime("%H:%M")
    out = []
    for ev in today_items(schedule, when=when):
        roles = ev.get("notify_roles") or ["child", "parent"]
        if role == "child" and "child" not in roles:
            continue
        if role == "parent" and "parent" not in roles:
            continue
        advance = (
            ev.get("remind_child_minutes")
            if role == "child"
            else ev.get("remind_parent_minutes")
        )
        try:
            advance = int(advance if advance is not None else 30)
        except (TypeError, ValueError):
            advance = 30
        start = ev.get("start") or ""
        out.append(
            {
                "id": ev.get("id"),
                "title": ev.get("title"),
                "start": start,
                "end": ev.get("end"),
                "place_name": ev.get("place_name"),
                "place_address": ev.get("place_address"),
                "advance_minutes": advance,
                "notes": ev.get("notes") or "",
                "passed": bool(start and start < now_hm),
            }
        )
    return out


def build_schedule_context(member: dict[str, Any], schedule: dict[str, Any] | None = None) -> str:
    schedule = schedule or storage.load_schedule()
    when = now_local()
    day = WEEKDAY_CN[when.weekday()]
    role = member.get("role") or "child"
    name = member.get("name") or "用户"
    items = today_items(schedule, when=when)
    places = place_map(schedule)
    travels = schedule.get("travel_buffers") or []

    lines = [
        f"【当前时间】{when.strftime('%Y-%m-%d %H:%M')}（{day}）",
        f"【对话对象】{name}（角色：{'小朋友' if role == 'child' else '家长监管'}）",
        f"【孩子】{schedule.get('child_name') or '小葡萄'}",
        "",
        "【今日行程】",
    ]
    if not items:
        lines.append("- 今日暂无预制日程")
    else:
        for ev in items:
            lines.append(
                f"- {ev.get('start')}-{ev.get('end')} {ev.get('title')} "
                f"@ {ev.get('place_name')}（{ev.get('place_address') or '地址待补'}）"
            )
            if ev.get("notes"):
                lines.append(f"  备注：{ev['notes']}")
            if role == "parent":
                lines.append(
                    f"  提醒：孩子提前 {ev.get('remind_child_minutes')} 分钟；"
                    f"家长提前 {ev.get('remind_parent_minutes')} 分钟"
                )

    lines.append("")
    lines.append("【常用地点】")
    for p in places.values():
        lines.append(f"- {p.get('name')}: {p.get('address') or ''} {p.get('notes') or ''}".rstrip())

    lines.append("")
    lines.append("【路程缓冲】")
    if not travels:
        lines.append("- 暂无")
    else:
        for t in travels:
            frm = places.get(t.get("from") or "", {}).get("name") or t.get("from")
            to = places.get(t.get("to") or "", {}).get("name") or t.get("to")
            lines.append(f"- {frm} → {to}: 约 {t.get('minutes')} 分钟（{t.get('mode') or '出行'}）")

    rules = schedule.get("reminder_rules") or {}
    tone = rules.get("child_tone") if role == "child" else rules.get("parent_tone")
    if tone:
        lines.append("")
        lines.append(f"【语气要求】{tone}")

    return "\n".join(lines)


def format_schedule_for_api(schedule: dict[str, Any] | None = None) -> dict[str, Any]:
    schedule = schedule or storage.load_schedule()
    when = now_local()
    return {
        "schedule": schedule,
        "today": today_items(schedule, when=when),
        "now": when.isoformat(),
        "weekday": WEEKDAY_CN[when.weekday()],
        "reminders_child": upcoming_reminders(schedule, role="child", when=when),
        "reminders_parent": upcoming_reminders(schedule, role="parent", when=when),
    }
