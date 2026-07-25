"""日程上下文：真实日程表 → chat 上下文；提醒按 @成员 展开。"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from backend import storage
from backend.schedule_tools import format_at_mentions, normalize_reminders

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


def event_reminders(ev: dict[str, Any]) -> list[dict[str, Any]]:
    """兼容旧字段，统一成 reminders 列表。"""
    if ev.get("reminders"):
        try:
            return normalize_reminders(ev.get("reminders"))
        except ValueError:
            pass
    # 旧数据兜底：按角色拆成成员（仅展示，写入时仍要求正式 reminders）
    legacy: list[dict[str, Any]] = []
    roles = ev.get("notify_roles") or []
    try:
        child_m = int(ev.get("remind_child_minutes") if ev.get("remind_child_minutes") is not None else 15)
    except (TypeError, ValueError):
        child_m = 15
    try:
        parent_m = int(ev.get("remind_parent_minutes") if ev.get("remind_parent_minutes") is not None else 30)
    except (TypeError, ValueError):
        parent_m = 30
    if not roles or "child" in roles:
        legacy.append({"member_id": "xiaoputao", "minutes_before": child_m})
    if not roles or "parent" in roles:
        for mid in ("dad", "mom", "grandma"):
            legacy.append({"member_id": mid, "minutes_before": parent_m})
    try:
        return normalize_reminders(legacy)
    except ValueError:
        return []


def today_items(schedule: dict[str, Any], *, when: datetime | None = None) -> list[dict[str, Any]]:
    when = when or now_local()
    day = WEEKDAY_CN[when.weekday()]
    places = place_map(schedule)
    items = []
    for ev in schedule.get("weekly") or []:
        if day not in (ev.get("days") or []):
            continue
        place = places.get(ev.get("place_id") or "", {})
        reminders = event_reminders(ev)
        items.append(
            {
                **ev,
                "day": day,
                "place_name": place.get("name") or ev.get("place_id") or "地点未录入",
                "place_address": place.get("address") or "",
                "reminders": reminders,
                "at_text": format_at_mentions(reminders),
            }
        )
    for ev in schedule.get("one_off") or []:
        if ev.get("date") == when.strftime("%Y-%m-%d"):
            place = places.get(ev.get("place_id") or "", {})
            reminders = event_reminders(ev)
            items.append(
                {
                    **ev,
                    "day": day,
                    "place_name": place.get("name") or ev.get("place_id") or "地点未录入",
                    "place_address": place.get("address") or "",
                    "reminders": reminders,
                    "at_text": format_at_mentions(reminders),
                }
            )
    items.sort(key=lambda x: x.get("start") or "99:99")
    return items


def upcoming_reminders(
    schedule: dict[str, Any],
    *,
    member_id: str | None = None,
    when: datetime | None = None,
) -> list[dict[str, Any]]:
    """今日提醒：一条行程一条；多角色写在 targets 里。

    若指定 member_id，则只返回该成员相关行程（仍一条行程一条，targets 仅含此人）。
    """
    when = when or now_local()
    now_hm = when.strftime("%H:%M")
    out = []
    for ev in today_items(schedule, when=when):
        targets = []
        for r in ev.get("reminders") or []:
            mid = r.get("member_id")
            if member_id and mid != member_id:
                continue
            m = storage.get_member(str(mid or ""))
            targets.append(
                {
                    "member_id": mid,
                    "member_name": (m or {}).get("name") or mid,
                    "member_emoji": (m or {}).get("emoji") or "",
                    "advance_minutes": r.get("minutes_before", 30),
                }
            )
        if not targets:
            continue
        start = ev.get("start") or ""
        at_bits = [
            f"@{t['member_name']}（提前{t['advance_minutes']}分）" for t in targets
        ]
        out.append(
            {
                "id": ev.get("id"),
                "title": ev.get("title"),
                "start": start,
                "end": ev.get("end"),
                "place_name": ev.get("place_name"),
                "place_address": ev.get("place_address"),
                "targets": targets,
                "member_id": targets[0]["member_id"],
                "member_name": targets[0]["member_name"],
                "advance_minutes": targets[0]["advance_minutes"],
                "at_text": " ".join(at_bits),
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
        "【成员可 @】小葡萄(xiaoputao)、爸爸(dad)、妈妈(mom)、奶奶(grandma)",
        "",
        "【今日行程】",
    ]
    if not items:
        lines.append("- （库中无今日行程；有行程请家长告知并写入，提醒对象由管家按角色自动选定）")
    else:
        for ev in items:
            addr = ev.get("place_address") or ""
            place_bit = f"@ {ev.get('place_name')}" + (f"（{addr}）" if addr else "（地址未录入）")
            lines.append(f"- {ev.get('start')}-{ev.get('end')} {ev.get('title')} {place_bit}")
            lines.append(f"  提醒对象：{ev.get('at_text') or '（未 @ 任何人）'}")
            if ev.get("notes"):
                lines.append(f"  备注：{ev['notes']}")

    lines.append("")
    lines.append("【常用地点】")
    if not places:
        lines.append("- （尚未录入地点）")
    else:
        for p in places.values():
            addr = (p.get("address") or "").strip()
            lines.append(f"- {p.get('name')}: {addr or '地址未录入'} {p.get('notes') or ''}".rstrip())

    lines.append("")
    lines.append("【路程缓冲】")
    if not travels:
        lines.append("- （尚未录入路程）")
    else:
        for t in travels:
            frm = places.get(t.get("from") or "", {}).get("name") or t.get("from")
            to = places.get(t.get("to") or "", {}).get("name") or t.get("to")
            lines.append(f"- {frm} → {to}: 约 {t.get('minutes')} 分钟（{t.get('mode') or '出行'}）")

    weekly = schedule.get("weekly") or []
    one_off = schedule.get("one_off") or []
    lines.append("")
    lines.append(f"【库存量】周程 {len(weekly)} 条，单次 {len(one_off)} 条，地点 {len(places)} 个")
    if not weekly and not one_off:
        lines.append("【重要】当前没有任何已保存行程。禁止臆造安排。")
    lines.append("【硬性】每条行程须指定具体提醒成员（由管家按角色自动选择），用户无需在对话里写@。")
    lines.append("【存储】仅本机 data/app_store.json，无外部数据库。")

    return "\n".join(lines)


def format_schedule_for_api(schedule: dict[str, Any] | None = None) -> dict[str, Any]:
    schedule = schedule or storage.load_schedule()
    when = now_local()
    today = today_items(schedule, when=when)
    return {
        "schedule": schedule,
        "today": today,
        "now": when.isoformat(),
        "weekday": WEEKDAY_CN[when.weekday()],
        "reminders": upcoming_reminders(schedule, when=when),
        "reminders_by_member": {
            m["id"]: upcoming_reminders(schedule, member_id=m["id"], when=when) for m in storage.MEMBERS
        },
        "members": [{"id": m["id"], "name": m["name"], "emoji": m["emoji"], "role": m["role"]} for m in storage.MEMBERS],
    }
