"""百炼 DeepSeek：流式聊天 + function calling 工具循环。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def api_key() -> str:
    key = _env("DASHSCOPE_API_KEY")
    if not key:
        raise RuntimeError("缺少 DASHSCOPE_API_KEY")
    return key


def base_url() -> str:
    raw = _env("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com").rstrip("/")
    if raw.endswith("/compatible-mode/v1"):
        return raw
    if raw.endswith("/compatible-mode"):
        return raw + "/v1"
    return raw + "/compatible-mode/v1"


def default_model() -> str:
    return _env("DEEPSEEK_MODEL", "deepseek-v4-flash")


def hard_model() -> str:
    return _env("DEEPSEEK_MODEL_HARD", "deepseek-v4-pro")


def _post_json(body: dict[str, Any], *, timeout: float = 180) -> dict[str, Any]:
    url = f"{base_url()}/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"DeepSeek HTTP {exc.code}: {raw[:800]}") from exc


def _stream_completion(
    body: dict[str, Any],
    *,
    on_delta: Callable[[str], None] | None = None,
    timeout: float = 180,
) -> tuple[str, dict[str, Any] | None]:
    """流式请求，返回 (content, tool_calls聚合或None)。若出现 tool_calls 则 content 可能为空。"""
    stream_body = {**body, "stream": True}
    url = f"{base_url()}/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(stream_body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    chunks: list[str] = []
    tool_acc: dict[int, dict[str, Any]] = {}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                choices = obj.get("choices") or []
                if not choices or not isinstance(choices[0], dict):
                    continue
                delta = choices[0].get("delta") or {}
                text = delta.get("content")
                if isinstance(text, str) and text:
                    chunks.append(text)
                    if on_delta:
                        on_delta(text)
                for tc in delta.get("tool_calls") or []:
                    if not isinstance(tc, dict):
                        continue
                    idx = int(tc.get("index") or 0)
                    slot = tool_acc.setdefault(
                        idx,
                        {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                    )
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["function"]["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["function"]["arguments"] += fn["arguments"]
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"DeepSeek HTTP {exc.code}: {raw[:800]}") from exc

    content = "".join(chunks).strip()
    if tool_acc:
        tool_calls = [tool_acc[i] for i in sorted(tool_acc.keys())]
        return content, {"role": "assistant", "content": content or None, "tool_calls": tool_calls}
    return content, None


def chat_stream(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    on_delta: Callable[[str], None] | None = None,
    enable_thinking: bool = False,
    tools: list[dict[str, Any]] | None = None,
    tool_executor: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
    max_tool_rounds: int = 6,
    on_status: Callable[[str], None] | None = None,
) -> str:
    """支持工具循环；最终对用户可见文本会通过 on_delta 流出。"""
    use_model = model or default_model()
    msgs: list[dict[str, Any]] = list(messages)

    for round_i in range(max_tool_rounds + 1):
        body: dict[str, Any] = {
            "model": use_model,
            "messages": msgs,
            "enable_thinking": enable_thinking,
        }
        if tools and tool_executor and round_i < max_tool_rounds:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        # 有工具时先用非流式拿稳定 tool_calls，最后一轮或无工具再流式
        if tools and tool_executor and round_i < max_tool_rounds:
            if on_status:
                on_status("正在核对并更新日程…" if round_i else "思考中…")
            data = _post_json({**body, "stream": False}, timeout=180)
            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError(f"DeepSeek 无返回: {json.dumps(data, ensure_ascii=False)[:400]}")
            msg = (choices[0].get("message") or {}) if isinstance(choices[0], dict) else {}
            tool_calls = msg.get("tool_calls") or []
            content = (msg.get("content") or "").strip()
            if tool_calls:
                msgs.append(
                    {
                        "role": "assistant",
                        "content": msg.get("content"),
                        "tool_calls": tool_calls,
                    }
                )
                for tc in tool_calls:
                    fn = (tc.get("function") or {}) if isinstance(tc, dict) else {}
                    name = fn.get("name") or ""
                    raw_args = fn.get("arguments") or "{}"
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                    except json.JSONDecodeError:
                        args = {}
                    if on_status and name:
                        on_status(f"已写入日程工具：{name}")
                    result = tool_executor(name, args if isinstance(args, dict) else {})
                    msgs.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id") or name,
                            "content": json.dumps(result, ensure_ascii=False),
                        }
                    )
                continue

            # 无 tool_calls：把最终回复流式播给前端（若已有全文则模拟流）
            if content:
                if on_delta:
                    step = 8
                    for i in range(0, len(content), step):
                        on_delta(content[i : i + step])
                return content
            # 空内容则再走一轮流式兜底
            text, _ = _stream_completion(
                {"model": use_model, "messages": msgs, "enable_thinking": enable_thinking},
                on_delta=on_delta,
            )
            return text

        text, _ = _stream_completion(body, on_delta=on_delta)
        return text

    return "（工具调用轮次过多，请把日程拆成几条再说一次）"
