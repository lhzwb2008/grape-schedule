"""按任务难度路由模型：默认 DeepSeek（带日程工具），困难任务可选 Cursor。"""

from __future__ import annotations

import re
from typing import Any, Callable, Literal

from backend import cursor_client, deepseek_client, schedule_tools
from backend.schedule_context import build_schedule_context

Provider = Literal["deepseek", "cursor"]
Difficulty = Literal["easy", "hard"]

HARD_HINTS = re.compile(
    r"(复杂规划|深度分析|架构设计|大规模重构)",
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
    if len(text) > 1200:
        return "hard"
    return "easy"


def provider_for(difficulty: Difficulty) -> Provider:
    if difficulty == "hard":
        return "cursor"
    return "deepseek"


def build_system_prompt(member: dict[str, Any], schedule_ctx: str) -> str:
    role = member.get("role") or "child"
    name = member.get("name") or "用户"
    if role == "child":
        persona = (
            "你是「小葡萄的日程小助手」，专门陪伴小朋友小葡萄。\n"
            "用简短、温暖、好懂的中文说话。\n"
            "只能根据已持久化的真实日程回答；没有的信息不要编造。\n"
            "说到提醒时，用「会提醒小葡萄/妈妈」这类自然语言，不要让小朋友去写@"
        )
    else:
        persona = (
            "你是「小葡萄家庭日程管家」，面向家长（爸爸/妈妈/奶奶）。\n"
            "【硬性规则】\n"
            "1. 禁止编造与「示例」地址/行程；只使用工具读写后的真实数据。"
            "数据只存在本机本地文件，不要提云盘/外部数据库。\n"
            "2. 家长用自然语言说行程即可；不要要求家长在对话里写 @。\n"
            "3. 写入 reminders 时，由你根据角色与场景自动选择需要知情的人：\n"
            "   - 孩子本人行程（课/活动）→ 必选小葡萄；\n"
            "   - 需要接送/出发 → 再选实际接送的家长（对话里提到谁就选谁；未提则选当前对话家长）；\n"
            "   - 全家事项可多人；不要只写笼统「家长」「孩子」。\n"
            "4. 回复用自然语言说明「会提醒谁、提前多久」，可用 @姓名 标记，但不要教用户去输入@。\n"
            "5. 信息不全时先落库已确认部分，再追问缺的地址/时间/接送人。"
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
        }

    model = cursor_client.model_id()
    schedule_ctx = build_schedule_context(member)
    system = build_system_prompt(member, schedule_ctx)
    prompt = (
        f"{system}\n\n"
        f"【历史摘要】共 {len(history)} 条消息\n"
        f"【用户问题】\n{user_message.strip()}\n\n"
        "请直接给出对用户的中文回复。用自然语言说明会提醒谁即可，不要要求用户在对话里输入@。"
    )
    if on_status:
        on_status(f"使用 Cursor {model}…")

    agent_id = session_agent_id
    if agent_id:
        run_id = cursor_client.create_run(agent_id, prompt)
    else:
        agent_id, run_id = cursor_client.create_agent(prompt)

    text, status = cursor_client.run_with_stream(agent_id, run_id, on_assistant=on_delta)
    if not (text or "").strip():
        text = f"（未返回有效内容，状态：{status}）"
    return {
        "text": text.strip(),
        "provider": "cursor",
        "model": model,
        "difficulty": difficulty,
        "agent_id": agent_id,
        "status": status,
    }
