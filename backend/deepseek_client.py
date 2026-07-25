"""百炼 DeepSeek V4（OpenAI 兼容接口）流式聊天。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Iterator


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


def chat_stream(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    on_delta: Callable[[str], None] | None = None,
    enable_thinking: bool = False,
) -> str:
    """同步流式调用，返回完整助手文本。"""
    use_model = model or default_model()
    url = f"{base_url()}/chat/completions"
    body: dict[str, Any] = {
        "model": use_model,
        "messages": messages,
        "stream": True,
        "enable_thinking": enable_thinking,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    chunks: list[str] = []
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
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
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {}) if isinstance(choices[0], dict) else {}
                # 跳过 reasoning_content，只取可见回复
                text = delta.get("content")
                if isinstance(text, str) and text:
                    chunks.append(text)
                    if on_delta:
                        on_delta(text)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"DeepSeek HTTP {exc.code}: {raw[:600]}") from exc

    return "".join(chunks).strip()


def iter_sse_lines(messages: list[dict[str, str]], *, model: str | None = None) -> Iterator[str]:
    """供测试/调试：逐行产出 delta 文本。"""
    buf: list[str] = []

    def _on(t: str) -> None:
        buf.append(t)

    chat_stream(messages, model=model, on_delta=_on)
    yield from buf
