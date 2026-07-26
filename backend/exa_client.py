"""Exa Search 客户端（参考 asknbawithhermes/app/clients/exa.py，同步版）。

文档: https://exa.ai/docs/reference/search
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


BASE_URL = "https://api.exa.ai"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def api_key() -> str:
    return _env("EXA_API_KEY")


def timeout_s() -> float:
    try:
        return float(_env("EXA_TIMEOUT", "60") or "60")
    except ValueError:
        return 60.0


def is_configured() -> bool:
    return bool(api_key())


def search(
    query: str,
    *,
    num_results: int = 8,
    search_type: str = "auto",
    include_text: bool = True,
    category: str | None = None,
) -> dict[str, Any]:
    """调用 Exa Search API，返回与 asknba 相近的结构。"""
    q = str(query or "").strip()
    if not q:
        return {"success": False, "error": "query 为空", "content": None, "results": []}
    if not is_configured():
        return {
            "success": False,
            "error": "Exa API 未配置，请设置 EXA_API_KEY",
            "content": None,
            "results": [],
        }

    payload: dict[str, Any] = {
        "query": q,
        "numResults": max(1, min(int(num_results), 20)),
        "type": search_type or "auto",
        "contents": {"text": bool(include_text)},
    }
    if category:
        payload["category"] = category

    req = urllib.request.Request(
        f"{BASE_URL}/search",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "x-api-key": api_key(),
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")[:500] if e.fp else ""
        return {
            "success": False,
            "error": f"HTTP 错误: {e.code} - {raw}",
            "content": None,
            "results": [],
        }
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e), "content": None, "results": []}

    results_raw = data.get("results") if isinstance(data, dict) else []
    if not isinstance(results_raw, list):
        results_raw = []

    formatted: list[dict[str, Any]] = []
    content_parts: list[str] = []
    for i, result in enumerate(results_raw, 1):
        if not isinstance(result, dict):
            continue
        title = result.get("title") or "无标题"
        url = result.get("url") or ""
        text = result.get("text") or ""
        published_date = result.get("publishedDate") or ""
        formatted.append(
            {
                "title": title,
                "url": url,
                "text": text[:2000] if text else "",
                "published_date": published_date,
            }
        )
        content_parts.append(f"【{i}. {title}】")
        if published_date:
            content_parts.append(f"发布日期: {str(published_date)[:10]}")
        if text:
            summary = text[:1500].strip()
            if len(text) > 1500:
                summary += "..."
            content_parts.append(summary)
        if url:
            content_parts.append(f"来源: {url}")
        content_parts.append("")

    return {
        "success": True,
        "error": None,
        "content": "\n".join(content_parts) if content_parts else "未找到相关结果",
        "results": formatted,
        "results_count": len(formatted),
        "search_type": (data.get("searchType") if isinstance(data, dict) else None) or search_type,
    }
