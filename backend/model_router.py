"""按任务难度路由模型：默认 DeepSeek，困难/自迭代走 Cursor Grok。"""

from __future__ import annotations

import re
from typing import Any, Callable, Literal

from backend import cursor_client, deepseek_client
from backend.schedule_context import build_schedule_context

Provider = Literal["deepseek", "cursor"]
Difficulty = Literal["easy", "hard", "self_iterate"]

HARD_HINTS = re.compile(
    r"(改代码|修改代码|自迭代|自动迭代|发布上线|部署|重构|写脚本|实现功能|"
    r"复杂规划|深度分析|架构|pull request|PR\b|git\b|修复 bug|修 bug)",
    re.IGNORECASE,
)


def classify_difficulty(message: str, *, force: Difficulty | None = None) -> Difficulty:
    if force:
        return force
    text = (message or "").strip()
    if not text:
        return "easy"
    if HARD_HINTS.search(text):
        return "hard"
    if len(text) > 800:
        return "hard"
    return "easy"


def provider_for(difficulty: Difficulty) -> Provider:
    if difficulty in ("hard", "self_iterate"):
        return "cursor"
    return "deepseek"


def build_system_prompt(member: dict[str, Any], schedule_ctx: str) -> str:
    role = member.get("role") or "child"
    name = member.get("name") or "用户"
    if role == "child":
        persona = (
            "你是「小葡萄的日程小助手」，专门陪伴小朋友小葡萄。\n"
            "用简短、温暖、好懂的中文说话，可以适当鼓励。\n"
            "帮助她记住今天要做什么、什么时候出发、在哪里。\n"
            "不要说吓人的话；涉及安全时提醒找爸爸妈妈或奶奶。"
        )
    else:
        persona = (
            "你是「小葡萄家庭日程管家」，面向家长（爸爸/妈妈/奶奶）做监管与提醒。\n"
            "回复要清晰可执行：时间、地点、路程、谁接送、提前多久出发。\n"
            "钢琴课等关键事项要同时考虑孩子提醒与家长出行缓冲。"
        )
    return (
        f"{persona}\n"
        f"当前用户：{name}\n\n"
        f"以下是最新日程上下文（每次对话都会刷新，请以此为准）：\n"
        f"{schedule_ctx}\n\n"
        "回答时优先依据上述日程；若信息不足，明确说明并建议在家长端补充地点/路程。"
    )


def build_messages(
    member: dict[str, Any],
    history: list[dict[str, str]],
    user_message: str,
) -> list[dict[str, str]]:
    schedule_ctx = build_schedule_context(member)
    system = build_system_prompt(member, schedule_ctx)
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    # 只带最近若干轮，避免过长
    trimmed = history[-12:] if history else []
    for m in trimmed:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_message.strip()})
    return messages


def run_chat(
    member: dict[str, Any],
    history: list[dict[str, str]],
    user_message: str,
    *,
    force_difficulty: Difficulty | None = None,
    session_agent_id: str | None = None,
    on_delta: Callable[[str], None] | None = None,
    on_status: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """执行一轮对话，返回 {text, provider, model, difficulty, agent_id?}。"""
    difficulty = classify_difficulty(user_message, force=force_difficulty)
    provider = provider_for(difficulty)

    if provider == "deepseek":
        model = (
            deepseek_client.hard_model()
            if difficulty == "hard"
            else deepseek_client.default_model()
        )
        # 默认 easy 走 flash；若被标 hard 但仍选 deepseek 不会发生——hard 走 cursor
        # 这里 easy 用 flash
        model = deepseek_client.default_model()
        if on_status:
            on_status(f"使用 DeepSeek（{model}）思考中…")
        messages = build_messages(member, history, user_message)
        text = deepseek_client.chat_stream(messages, model=model, on_delta=on_delta)
        return {
            "text": text,
            "provider": "deepseek",
            "model": model,
            "difficulty": difficulty,
            "agent_id": None,
        }

    # Cursor Grok：困难任务 / 自迭代
    model = cursor_client.model_id()
    schedule_ctx = build_schedule_context(member)
    system = build_system_prompt(member, schedule_ctx)
    prompt = (
        f"{system}\n\n"
        f"【历史摘要】共 {len(history)} 条消息\n"
        f"【用户问题】\n{user_message.strip()}\n\n"
        "请直接给出对用户的中文回复（不要只写改代码计划，除非用户明确要求改仓库）。"
    )
    if difficulty == "self_iterate":
        prompt = (
            f"{system}\n\n"
            "【自迭代模式已激活】用户希望你修改 grape-schedule 仓库代码并说明如何验证与部署。\n"
            f"【用户需求】\n{user_message.strip()}\n"
        )
    if on_status:
        on_status(f"使用 Cursor {model} 处理较难任务…")

    agent_id = session_agent_id
    if agent_id:
        run_id = cursor_client.create_run(agent_id, prompt)
    else:
        agent_id, run_id = cursor_client.create_agent(prompt)

    text, status = cursor_client.run_with_stream(agent_id, run_id, on_assistant=on_delta)
    if not (text or "").strip():
        text = f"（Cursor Agent 未返回有效内容，状态：{status}）"
    return {
        "text": text.strip(),
        "provider": "cursor",
        "model": model,
        "difficulty": difficulty,
        "agent_id": agent_id,
        "status": status,
    }
