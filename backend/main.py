"""小葡萄日程提醒智能体 — FastAPI 后端。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import self_iterate, storage
from backend.dashscope_voice import recognize as asr_recognize
from backend.dashscope_voice import synthesize as tts_synthesize
from backend.model_router import classify_difficulty, run_chat
from backend.schedule_context import format_schedule_for_api

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="小葡萄日程提醒智能体")
storage.ensure_dirs()

FRONTEND = ROOT / "frontend"
TOKEN_TTL = 60 * 60 * 24 * 30


def _secret() -> bytes:
    return os.environ.get("SECRET_KEY", "grape-schedule").encode()


def _make_token(user_id: str) -> str:
    exp = str(int(time.time()) + TOKEN_TTL)
    nonce = secrets.token_urlsafe(16)
    payload = f"{user_id}.{exp}.{nonce}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def _auth_token(token: str | None) -> str:
    if not token:
        raise HTTPException(401, "未登录")
    parts = token.split(".")
    if len(parts) != 4:
        raise HTTPException(401, "登录无效，请重新登录")
    user_id, exp_s, nonce, sig = parts
    payload = f"{user_id}.{exp_s}.{nonce}"
    expect = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        raise HTTPException(401, "登录无效，请重新登录")
    try:
        exp = int(exp_s)
    except ValueError as e:
        raise HTTPException(401, "登录无效，请重新登录") from e
    if exp < time.time():
        raise HTTPException(401, "登录已过期，请重新登录")
    if not storage.get_member(user_id):
        raise HTTPException(401, "未知账户")
    return user_id


def _auth_user(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "未登录")
    return _auth_token(authorization[7:].strip())


def _require_parent(user_id: str) -> dict[str, Any]:
    member = storage.get_member(user_id)
    if not member or member.get("role") != "parent":
        raise HTTPException(403, "仅家长可访问")
    return member


def _strip_b64(data: str) -> str:
    if "," in data and data.strip().lower().startswith("data:"):
        return data.split(",", 1)[1]
    return data


class LoginBody(BaseModel):
    user_id: str
    password: str = Field(min_length=4, max_length=64)


class ChatBody(BaseModel):
    message: str = Field(default="", max_length=8000)
    force_model: str | None = Field(default=None, description="easy|hard|self_iterate")


class SessionCreateBody(BaseModel):
    title: str = "新对话"


class AsrBody(BaseModel):
    audio: str = Field(min_length=1)
    mime: str = Field(default="audio/webm", max_length=100)


class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ActivateBody(BaseModel):
    code: str = Field(min_length=1, max_length=128)


class ScheduleUpdateBody(BaseModel):
    schedule: dict[str, Any]


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "name": "小葡萄日程提醒智能体",
        "default_model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "hard_model": os.environ.get("CURSOR_MODEL_ID", "grok-4.5"),
        "self_iterate": self_iterate.status(),
    }


@app.get("/api/members")
def members(role: str | None = None):
    if role and role not in ("child", "parent"):
        raise HTTPException(400, "role 只能是 child 或 parent")
    return {"members": storage.list_members(role=role)}


@app.post("/api/login")
def login(body: LoginBody):
    try:
        member = storage.login(body.user_id, body.password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    token = _make_token(body.user_id)
    return {"token": token, "member": member}


@app.get("/api/me")
def me(authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    return {"member": storage.get_member(user_id)}


@app.get("/api/schedule")
def get_schedule(authorization: str | None = Header(default=None)):
    _auth_user(authorization)
    return format_schedule_for_api()


@app.put("/api/schedule")
def put_schedule(body: ScheduleUpdateBody, authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    _require_parent(user_id)
    if not isinstance(body.schedule, dict):
        raise HTTPException(400, "schedule 必须是对象")
    saved = storage.save_schedule(body.schedule)
    return format_schedule_for_api(saved)


@app.get("/api/sessions")
def sessions(authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    return {"sessions": storage.list_sessions(user_id)}


@app.post("/api/sessions")
def create_session(body: SessionCreateBody, authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    session = storage.create_session(user_id, body.title)
    return {"session": session}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    try:
        session = storage.get_session(user_id, session_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return {"session": session}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str, authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    try:
        storage.delete_session(user_id, session_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return {"ok": True}


@app.post("/api/asr")
def asr(body: AsrBody, authorization: str | None = Header(default=None)):
    _auth_user(authorization)
    raw_b64 = _strip_b64(body.audio).strip()
    try:
        raw = base64.b64decode(raw_b64, validate=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, "音频解码失败") from e
    mime = (body.mime or "audio/webm").split(";")[0].strip() or "audio/webm"
    try:
        text = asr_recognize(raw, mime)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"语音识别失败：{e}") from e
    return {"text": text}


@app.post("/api/tts")
def tts(body: TtsBody, authorization: str | None = Header(default=None)):
    _auth_user(authorization)
    try:
        audio, mime, timing = tts_synthesize(body.text)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"语音合成失败：{e}") from e
    return Response(
        content=audio,
        media_type=mime,
        headers={
            "Cache-Control": "no-store",
            "X-TTS-Chars": str(timing.get("chars", 0)),
            "X-TTS-Synth-Ms": str(timing.get("synth_ms", 0)),
            "X-TTS-Download-Ms": str(timing.get("download_ms", 0)),
            "X-TTS-Total-Ms": str(timing.get("total_ms", 0)),
        },
    )


@app.get("/api/self-iterate/status")
def self_iterate_status(authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    _require_parent(user_id)
    return self_iterate.status()


@app.post("/api/self-iterate/activate")
def self_iterate_activate(body: ActivateBody, authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    _require_parent(user_id)
    try:
        return self_iterate.activate(body.code, by_user=user_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/self-iterate/deactivate")
def self_iterate_deactivate(authorization: str | None = Header(default=None)):
    user_id = _auth_user(authorization)
    _require_parent(user_id)
    return self_iterate.deactivate(by_user=user_id)


@app.post("/api/sessions/{session_id}/chat")
async def chat(
    session_id: str,
    body: ChatBody,
    authorization: str | None = Header(default=None),
):
    user_id = _auth_user(authorization)
    member = storage.get_member(user_id)
    if not member:
        raise HTTPException(400, "未知账户")

    try:
        session = storage.get_session(user_id, session_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e

    message = (body.message or "").strip()
    if not message:
        raise HTTPException(400, "请输入消息")

    force = body.force_model if body.force_model in ("easy", "hard", "self_iterate") else None
    if force == "self_iterate" or classify_difficulty(message) == "self_iterate":
        try:
            self_iterate.require_activated()
        except PermissionError as e:
            raise HTTPException(403, str(e)) from e
        force = "self_iterate"

    # 简单关键词也可触发自迭代意图检测
    if "自迭代" in message or "自动改代码" in message:
        try:
            self_iterate.require_activated()
            force = force or "self_iterate"
        except PermissionError as e:
            raise HTTPException(403, str(e)) from e

    storage.append_message(user_id, session_id, "user", message)
    history = [
        {"role": m["role"], "content": m["content"]}
        for m in (session.get("messages") or [])
        if m.get("role") in ("user", "assistant")
    ]

    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _emit(obj: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, json.dumps(obj, ensure_ascii=False))

    def _worker() -> None:
        agent_id = session.get("agent_id")
        try:
            _emit({"type": "status", "message": "已收到，正在准备…"})

            def on_delta(t: str) -> None:
                _emit({"type": "delta", "text": t})

            def on_status(msg: str) -> None:
                _emit({"type": "status", "message": msg})

            result = run_chat(
                member,
                history,
                message,
                force_difficulty=force,  # type: ignore[arg-type]
                session_agent_id=agent_id if force in ("hard", "self_iterate") else None,
                on_delta=on_delta,
                on_status=on_status,
            )
            final = (result.get("text") or "").strip() or "（没有生成内容）"
            storage.append_message(
                user_id,
                session_id,
                "assistant",
                final,
                agent_id=result.get("agent_id"),
                model=result.get("model"),
            )
            if force == "self_iterate":
                self_iterate.record_request(
                    user_id,
                    message,
                    {
                        "provider": result.get("provider"),
                        "model": result.get("model"),
                        "agent_id": result.get("agent_id"),
                    },
                )
            _emit(
                {
                    "type": "done",
                    "text": final,
                    "provider": result.get("provider"),
                    "model": result.get("model"),
                    "difficulty": result.get("difficulty"),
                }
            )
        except Exception as e:  # noqa: BLE001
            err = str(e)
            storage.append_message(
                user_id,
                session_id,
                "assistant",
                f"抱歉，暂时无法完成回复：{err}",
            )
            _emit({"type": "error", "message": err})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    async def event_gen():
        yield ": ok\n\n"
        task = asyncio.create_task(asyncio.to_thread(_worker))
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield f"data: {item}\n\n"
        finally:
            await task

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/parent")
def parent_page():
    return FileResponse(FRONTEND / "parent.html")


app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8766"))
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
