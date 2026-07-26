"""模型分工：用户对话一律 DeepSeek；内部逻辑默认 Grok。"""

from __future__ import annotations

import json
from typing import Any, Callable

from backend import deepseek_client, logic_grok, schedule_tools
from backend.schedule_context import build_schedule_context


def build_system_prompt(member: dict[str, Any], schedule_ctx: str) -> str:
    role = member.get("role") or "child"
    name = member.get("name") or "用户"
    if role == "child":
        persona = (
            "你是「小葡萄的日程小助手」，专门陪伴小朋友小葡萄。\n"
            "用简短、温暖、好懂的中文说话。\n"
            "只能根据已持久化的真实日程回答；没有的信息不要编造。\n"
            "说到提醒时，用「会提醒小葡萄/妈妈」这类自然语言。"
        )
    else:
        persona = (
            "你是「小葡萄家庭日程管家」，面向家长（爸爸/妈妈/奶奶）。\n"
            "你只负责用自然语言和家长对话；日程写入与地点检索由内部逻辑（Grok）处理。\n"
            "【硬性规则】\n"
            "1. 只根据下方快照与「本轮逻辑结果」说话；不要编造行程。\n"
            "2. 禁止说「没有联网 / 无法搜索 / 不能查地址」——地点检索已由内部逻辑处理。"
            "若结果里地址已补上，直接告知并请家长确认；仍缺时用一句话请家长补充。\n"
            "3. 不要要求家长在对话里写 @；用自然语言说明会提醒谁即可。\n"
            "4. 不要假装自己还在改库；若逻辑结果已写入，直接确认并复述要点。"
        )
    return (
        f"{persona}\n"
        f"当前用户：{name}\n\n"
        f"以下是最新日程快照：\n"
        f"{schedule_ctx}\n"
    )


def build_messages(
    member: dict[str, Any],
    history: list[dict[str, str]],
    user_message: str,
    *,
    logic_note: str | None = None,
) -> list[dict[str, Any]]:
    schedule_ctx = build_schedule_context(member)
    system = build_system_prompt(member, schedule_ctx)
    if logic_note:
        system += f"\n\n【本轮内部逻辑结果（Grok）】\n{logic_note}\n"
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    trimmed = history[-12:] if history else []
    for m in trimmed:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_message.strip()})
    return messages


def _deepseek_reply(
    member: dict[str, Any],
    history: list[dict[str, str]],
    user_message: str,
    *,
    logic_note: str | None = None,
    allow_write_tools: bool = False,
    on_delta: Callable[[str], None] | None = None,
    on_status: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    model = deepseek_client.default_model()
    if on_status:
        on_status(f"DeepSeek（{model}）回复中…")
    role = str(member.get("role") or "child")
    user_id = str(member.get("id") or "unknown")
    messages = build_messages(member, history, user_message, logic_note=logic_note)

    if allow_write_tools:
        tools = schedule_tools.tools_for_role(role)

        def _exec(name: str, args: dict[str, Any]) -> dict[str, Any]:
            if role != "parent" and name != "get_schedule":
                return {"ok": False, "error": "小朋友不能修改日程，请让家长在家长端更新"}
            return schedule_tools.execute_tool(name, args, by=user_id)

        text = deepseek_client.chat_stream(
            messages,
            model=model,
            on_delta=on_delta,
            tools=tools,
            tool_executor=_exec,
            on_status=on_status,
        )
    else:
        # 对话模型只读：孩子可 get_schedule；家长在 Grok 写完后通常不再调写工具
        tools = schedule_tools.TOOLS_CHILD

        def _exec(name: str, args: dict[str, Any]) -> dict[str, Any]:
            if name != "get_schedule":
                return {"ok": False, "error": "对话阶段只读日程"}
            return schedule_tools.execute_tool(name, args, by=user_id)

        text = deepseek_client.chat_stream(
            messages,
            model=model,
            on_delta=on_delta,
            tools=tools,
            tool_executor=_exec,
            on_status=on_status,
        )

    return {
        "text": text,
        "provider": "deepseek",
        "model": model,
        "chat_model": model,
        "logic_model": logic_grok.logic_model() if logic_note else None,
        "agent_id": None,
    }


def run_chat(
    member: dict[str, Any],
    history: list[dict[str, str]],
    user_message: str,
    *,
    force_difficulty: str | None = None,  # 保留兼容，已忽略
    session_agent_id: str | None = None,  # 保留兼容，对话不再挂 Cursor agent
    on_delta: Callable[[str], None] | None = None,
    on_status: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    _ = force_difficulty, session_agent_id
    role = str(member.get("role") or "child")
    user_id = str(member.get("id") or "unknown")

    # —— 家长：内部逻辑默认 Grok → 落库 → DeepSeek 对用户说话 ——
    if role == "parent" and logic_grok.logic_enabled():
        logic_note = ""
        try:
            plan = logic_grok.plan_schedule_actions(
                member, history, user_message, on_status=on_status
            )
            results = logic_grok.execute_plan(plan, by=user_id, on_status=on_status)
            logic_note = (
                f"summary: {plan.get('summary') or '（无）'}\n"
                f"actions: {json.dumps(plan.get('actions') or [], ensure_ascii=False)}\n"
                f"results: {json.dumps(results, ensure_ascii=False)[:4000]}"
            )
        except Exception as exc:  # noqa: BLE001
            if on_status:
                on_status(f"Grok 逻辑暂不可用，改由 DeepSeek 处理写入：{exc}")
            return _deepseek_reply(
                member,
                history,
                user_message,
                logic_note=f"Grok 失败，已回退：{exc}",
                allow_write_tools=True,
                on_delta=on_delta,
                on_status=on_status,
            )

        result = _deepseek_reply(
            member,
            history,
            user_message,
            logic_note=logic_note,
            allow_write_tools=False,
            on_delta=on_delta,
            on_status=on_status,
        )
        result["logic_provider"] = "grok"
        result["logic_model"] = logic_grok.logic_model()
        return result

    # —— 孩子 / 未配置 Grok：对话 DeepSeek；家长无 Grok 时 DeepSeek 兼写库 ——
    allow_write = role == "parent"
    if role == "parent" and on_status:
        on_status("未配置 Grok，日程逻辑暂由 DeepSeek 处理")
    return _deepseek_reply(
        member,
        history,
        user_message,
        allow_write_tools=allow_write,
        on_delta=on_delta,
        on_status=on_status,
    )
