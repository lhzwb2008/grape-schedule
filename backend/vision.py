"""截图/图片理解：用百炼视觉模型转成文字，再交给 DeepSeek 写库/回答。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def vision_model() -> str:
    return _env("VISION_MODEL", "qwen-vl-plus")


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


def describe_images(images: list[dict[str, str]], *, hint: str = "") -> str:
    """images: [{mime, data_b64}]，返回中文描述。"""
    if not images:
        return ""
    content: list[dict[str, Any]] = []
    prompt = (
        "请用中文详细描述这些截图/图片里的文字与关键信息。"
        "若是日程、课表、聊天记录、通知，请完整提取时间、地点、事项。"
        "不要编造图中没有的内容。"
    )
    if hint.strip():
        prompt += f"\n用户附言：{hint.strip()}"
    content.append({"type": "text", "text": prompt})
    for img in images[:5]:
        mime = (img.get("mime") or "image/jpeg").split(";")[0]
        b64 = (img.get("data_b64") or "").strip()
        if not b64:
            continue
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"},
            }
        )
    if len(content) <= 1:
        return ""

    body = {
        "model": vision_model(),
        "messages": [{"role": "user", "content": content}],
        "stream": False,
    }
    req = urllib.request.Request(
        f"{base_url()}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"视觉模型失败 HTTP {exc.code}: {raw[:500]}") from exc

    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("视觉模型无返回")
    msg = choices[0].get("message") or {}
    text = (msg.get("content") or "").strip()
    return text
