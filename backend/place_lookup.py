"""地点公开地址检索（供日程逻辑补全空地址）。"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def lookup_place_address(name: str, *, city_hint: str = "上海") -> dict[str, Any]:
    """用公开地理检索补全地点地址。失败时返回 ok=False，不编造。"""
    query = str(name or "").strip()
    if not query:
        return {"ok": False, "error": "地点名称为空"}

    q = f"{query} {city_hint}".strip()
    params = urllib.parse.urlencode(
        {
            "q": q,
            "format": "json",
            "limit": 5,
            "addressdetails": 1,
            "accept-language": "zh-CN",
        }
    )
    url = f"https://nominatim.openstreetmap.org/search?{params}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "grape-schedule/1.0 (family schedule assistant)",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        items = json.loads(raw) if raw else []
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        return {"ok": False, "error": f"检索失败：{e}", "query": q}

    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "未检索到公开地址", "query": q}

    best = items[0] if isinstance(items[0], dict) else {}
    display = str(best.get("display_name") or "").strip()
    addr = best.get("address") if isinstance(best.get("address"), dict) else {}
    bits = [
        addr.get("state"),
        addr.get("city") or addr.get("town") or addr.get("county"),
        addr.get("suburb") or addr.get("district"),
        addr.get("road"),
        addr.get("house_number"),
    ]
    compact = "".join(str(x) for x in bits if x)
    address = compact or display
    if not address:
        return {"ok": False, "error": "检索结果无可用地址", "query": q}

    return {
        "ok": True,
        "name": query,
        "address": address,
        "display_name": display,
        "lat": float(best["lat"]) if best.get("lat") else None,
        "lng": float(best["lon"]) if best.get("lon") else None,
        "source": "nominatim",
        "note": "公开检索结果，请家长确认",
    }
