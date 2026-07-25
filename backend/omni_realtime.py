"""百炼 Qwen-Omni Realtime：语音消息加速（流式 ASR）。"""

from __future__ import annotations

import os


def realtime_model() -> str:
    return os.environ.get("DASHSCOPE_OMNI_MODEL", "qwen3.5-omni-flash-realtime").strip()


def realtime_ws_url() -> str:
    base = os.environ.get(
        "DASHSCOPE_REALTIME_URL",
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    ).strip().rstrip("?")
    if "model=" in base:
        return base
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}model={realtime_model()}"


def asr_session_update_payload() -> dict:
    """仅转写、不闲聊，供按住说话加速识别。"""
    return {
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "instructions": (
                "你是语音转写器。把用户说的话转成简洁中文文字。"
                "不要回答问题，不要寒暄，不要加标点以外的解释。"
            ),
            "input_audio_format": "pcm",
            "input_audio_transcription": {
                "model": os.environ.get(
                    "DASHSCOPE_OMNI_ASR_MODEL",
                    "qwen3-asr-flash-realtime",
                ).strip(),
            },
            "turn_detection": None,
        },
    }
