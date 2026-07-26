"""地点公开地址检索：优先 Exa Search（配置同 asknbawithhermes）。"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

from backend import exa_client


_ADDR_RE = re.compile(
    r"(?:[\u4e00-\u9fff]{2,12}(?:市|区|县|镇))?"
    r"[\u4e00-\u9fff0-9A-Za-z\-·]{2,40}"
    r"(?:路|街|道|巷|弄|大道|环路|高速)"
    r"[\u4e00-\u9fff0-9A-Za-z\-号栋座层楼院村屯区县市]{0,24}"
)


def _extract_address_from_text(blob: str, place_name: str) -> str:
    text = str(blob or "")
    if not text.strip():
        return ""
    # 优先含地点名的地址样片段
    candidates: list[str] = []
    for m in _ADDR_RE.finditer(text):
        seg = m.group(0).strip(" ，,。；;、\n\t")
        if len(seg) < 6:
            continue
        if "http" in seg.lower():
            continue
        candidates.append(seg)
    if place_name:
        named = [c for c in candidates if place_name[:2] in c or place_name in c]
        if named:
            return named[0]
    return candidates[0] if candidates else ""


def _llm_pick_address(place_name: str, city_hint: str, evidence: str) -> str:
    """用百炼模型从检索摘要里抽出一行地址；失败返回空。"""
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not key or not evidence.strip():
        return ""
    base = os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com").rstrip("/")
    if not base.endswith("/compatible-mode/v1"):
        if base.endswith("/compatible-mode"):
            base = base + "/v1"
        else:
            base = base + "/compatible-mode/v1"
    model = os.environ.get("PLACE_LOOKUP_MODEL", "").strip() or os.environ.get(
        "DEEPSEEK_MODEL", "deepseek-v4-flash"
    )
    prompt = (
        f"从下列联网检索摘要中，提取「{place_name}」（城市提示：{city_hint}）的公开地址。\n"
        "只输出一行中文地址（含区/路/号更好），不要解释。找不到就输出空。\n\n"
        f"{evidence[:3500]}"
    )
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你只输出一行地址或空字符串。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": 80,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = (
            ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        ).strip()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, KeyError):
        return ""
    if not content or content in ("空", "无", "未知", "找不到", "N/A", "null"):
        return ""
    # 去掉引号/前缀
    content = content.strip("「」\"'").splitlines()[0].strip()
    if len(content) > 80:
        content = content[:80]
    return content


def lookup_place_address(name: str, *, city_hint: str = "上海") -> dict[str, Any]:
    """用 Exa 联网检索补全地点地址。失败时返回 ok=False，不编造。"""
    query = str(name or "").strip()
    if not query:
        return {"ok": False, "error": "地点名称为空"}

    city = str(city_hint or "上海").strip() or "上海"
    search_q = f"{query} {city} 地址 位置"
    raw = exa_client.search(search_q, num_results=6, include_text=True)
    if not raw.get("success"):
        return {
            "ok": False,
            "error": raw.get("error") or "Exa 检索失败",
            "query": search_q,
        }

    content = str(raw.get("content") or "")
    results = raw.get("results") or []
    address = _extract_address_from_text(content, query)
    if not address:
        address = _llm_pick_address(query, city, content)

    if not address:
        # 兜底：用第一条标题+摘要前 80 字给家长确认（仍标检索来源）
        if results and isinstance(results[0], dict):
            title = str(results[0].get("title") or "").strip()
            snippet = str(results[0].get("text") or "").strip().replace("\n", " ")[:60]
            hint = "；".join(x for x in (title, snippet) if x)
            if hint:
                return {
                    "ok": True,
                    "name": query,
                    "address": f"{city} · {query}（检索摘要：{hint}）",
                    "display_name": hint,
                    "lat": None,
                    "lng": None,
                    "source": "exa",
                    "note": "Exa 未抽出标准门牌，请家长确认/改正",
                    "results_count": raw.get("results_count") or 0,
                }
        return {
            "ok": False,
            "error": "Exa 有结果但未抽出可用地址",
            "query": search_q,
            "results_count": raw.get("results_count") or 0,
        }

    return {
        "ok": True,
        "name": query,
        "address": address,
        "display_name": address,
        "lat": None,
        "lng": None,
        "source": "exa",
        "note": "地址来自 Exa 联网检索，请家长确认",
        "results_count": raw.get("results_count") or 0,
    }
