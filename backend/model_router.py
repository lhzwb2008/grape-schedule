"""按任务难度路由模型：默认 DeepSeek（带日程工具），困难/自迭代走 Cursor Grok。"""

from __future__ import annotations

import re
from typing import Any, Callable, Literal

from backend import cursor_client, deepseek_client, schedule_tools
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
            "只能根据已持久化的真实日程回答；库里没有的信息不要编造，可以说「还没记进日历，让爸爸妈妈告诉我」。\n"
            "需要时先调用 get_schedule 再回答。"
        )
    else:
        persona = (
            "你是「小葡萄家庭日程管家」，面向家长（爸爸/妈妈/奶奶）。\n"
            "【硬性规则】\n"
            "1. 禁止编造、禁止使用「示例/假设」地址或行程；只使用工具读写后的真实数据。\n"
            "2. 家长告知任何新的/变更的地点、路程、周程、单次安排时，必须立刻调用对应工具写入统一存储，"
            "不能只口头确认。\n"
            "3. 信息不全时：先把已确认部分落库，再明确追问缺的地址/时间/路程分钟数。\n"
            "4. 回答前若不确定库内状态，先 get_schedule。\n"
            "5. 写库成功后，用简洁中文复述已保存内容（时间、地点、提醒）。"
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
) -> list[dict[str, Any]]:
    schedule_ctx = build_schedule_context(member)
    system = build_system_prompt(member, schedule_ctx)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
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
    difficulty = classify_difficulty(user_message, force=force_difficulty)
    provider = provider_for(difficulty)
    user_id = str(member.get("id") or "unknown")
    role = str(member.get("role") or "child")

    if provider == "deepseek":
        model = deepseek_client.default_model()
        if on_status:
            on_status(f"使用 DeepSeek（{model}）…")
        messages = build_messages(member, history, user_message)
        tools = schedule_tools.tools_for_role(role)

        def _exec(name: str, args: dict[str, Any]) -> dict[str, Any]:
            # 孩子只读
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
        return {
            "text": text,
            "provider": "deepseek",
            "model": model,
            "difficulty": difficulty,
            "agent_id": None,
            "schedule_updated": True,
        }

    model = cursor_client.model_id()
    schedule_ctx = build_schedule_context(member)
    system = build_system_prompt(member, schedule_ctx)
    prompt = (
        f"{system}\n\n"
        f"【历史摘要】共 {len(history)} 条消息\n"
        f"【用户问题】\n{user_message.strip()}\n\n"
        "请直接给出对用户的中文回复。日程写入请提示用户在家长端用对话落库（本路径不直接写库）。"
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
