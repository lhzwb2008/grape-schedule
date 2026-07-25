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
    """按住说话：开启输入转写；与通话模式一致用 text+audio 会话更稳。"""
    return {
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "voice": os.environ.get("DASHSCOPE_OMNI_VOICE", "Tina").strip() or "Tina",
            "instructions": (
                "你是语音转写助手。用户说话后，只需把内容转成简洁中文，"
                "不要扩展回答、不要寒暄。"
            ),
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "input_audio_transcription": {
                "model": os.environ.get(
                    "DASHSCOPE_OMNI_ASR_MODEL",
                    "qwen3-asr-flash-realtime",
                ).strip(),
            },
            # 手动松手提交，不用服务端 VAD 打断
            "turn_detection": None,
        },
    }
