"""内部逻辑：默认 Cursor Grok（非用户对话）。输出结构化动作供工具执行。"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Any, Callable

from backend import cursor_client, schedule_tools, storage
from backend.schedule_context import build_schedule_context

_lock = threading.Lock()
_logic_agent_id: str | None = None

LOGIC_SYSTEM = """你是小葡萄家庭日程的「内部逻辑引擎」（Grok），不对用户直接说话。
根据家长自然语言与当前日程快照，决定要调用哪些日程工具。
用户不会写 @；由你按角色选择 reminders：
- 孩子本人行程 → 必含 xiaoputao
- 需要接送 → 再含实际接送家长（对话提到谁选谁；未提则选当前对话家长）
- 不要用笼统「家长/孩子」

只输出一个 JSON 对象，不要 Markdown，不要解释：
{
  "actions": [{"name": "工具名", "args": {...}}],
  "summary": "一句话说明你做了什么（给对话模型看）"
}
无写入需求时：{"actions":[],"summary":"无需改日程"}
可用工具名：get_schedule, set_home, upsert_place, remove_place, upsert_travel_buffer,
upsert_weekly_event, remove_weekly_event, upsert_one_off_event, remove_one_off_event, clear_all_events
家地址用 set_home，不要往 places 再写一条「家」。
"""


def logic_enabled() -> bool:
    return bool(os.environ.get("CURSOR_API_KEY", "").strip())


def logic_model() -> str:
    return os.environ.get("CURSOR_MODEL_ID", "grok-4.5").strip() or "grok-4.5"


def _extract_json(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {"actions": [], "summary": "（空响应）"}
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        try:
            obj = json.loads(fence.group(1).strip())
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(raw[start : end + 1])
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    return {"actions": [], "summary": "未能解析逻辑输出", "raw": raw[:500]}


def complete_logic(prompt: str, *, on_status: Callable[[str], None] | None = None) -> str:
    """调用 Grok（Cursor Agent）做内部推理，返回文本。"""
    global _logic_agent_id
    if not logic_enabled():
        raise RuntimeError("未配置 CURSOR_API_KEY，无法使用 Grok 内部逻辑")

    full = f"{LOGIC_SYSTEM}\n\n{prompt}"
    if on_status:
        on_status(f"Grok（{logic_model()}）整理日程逻辑…")

    with _lock:
        agent_id = _logic_agent_id
        if agent_id:
            try:
                run_id = cursor_client.create_run(agent_id, full)
            except Exception:  # noqa: BLE001
                agent_id = None
                _logic_agent_id = None
        if not agent_id:
            agent_id, run_id = cursor_client.create_agent(full)
            _logic_agent_id = agent_id

    text, status = cursor_client.run_with_stream(agent_id, run_id, on_assistant=None)
    if status == "ERROR":
        raise RuntimeError(f"Grok 逻辑失败：{status}")
    return (text or "").strip()


def plan_schedule_actions(
    member: dict[str, Any],
    history: list[dict[str, str]],
    user_message: str,
    *,
    on_status: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """家长侧：Grok 产出工具动作计划。"""
    schedule_ctx = build_schedule_context(member)
    recent = history[-6:] if history else []
    hist_lines = []
    for m in recent:
        role = "用户" if m.get("role") == "user" else "助手"
        hist_lines.append(f"{role}：{(m.get('content') or '')[:400]}")
    tools_hint = json.dumps(
        [
            {"name": t["function"]["name"], "desc": t["function"].get("description", "")}
            for t in schedule_tools.TOOLS_PARENT
        ],
        ensure_ascii=False,
    )
    prompt = (
        f"当前对话家长：{member.get('name')}（id={member.get('id')}）\n\n"
        f"【日程快照】\n{schedule_ctx}\n\n"
        f"【最近对话】\n" + ("\n".join(hist_lines) or "（无）") + "\n\n"
        f"【本轮用户说】\n{user_message.strip()}\n\n"
        f"【工具一览】\n{tools_hint}\n"
    )
    text = complete_logic(prompt, on_status=on_status)
    plan = _extract_json(text)
    actions = plan.get("actions")
    if not isinstance(actions, list):
        actions = []
    cleaned = []
    for a in actions:
        if not isinstance(a, dict):
            continue
        name = str(a.get("name") or "").strip()
        args = a.get("args") if isinstance(a.get("args"), dict) else {}
        if name:
            cleaned.append({"name": name, "args": args})
    plan["actions"] = cleaned
    if not isinstance(plan.get("summary"), str):
        plan["summary"] = ""
    return plan


def execute_plan(
    plan: dict[str, Any],
    *,
    by: str,
    on_status: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    results = []
    for action in plan.get("actions") or []:
        name = action.get("name") or ""
        args = action.get("args") or {}
        if on_status and name:
            on_status(f"执行：{name}")
        member = storage.get_member(by)
        if member and member.get("role") != "parent" and name != "get_schedule":
            results.append({"name": name, "ok": False, "error": "无权限"})
            continue
        out = schedule_tools.execute_tool(name, args, by=by)
        results.append({"name": name, **out})
    return results
