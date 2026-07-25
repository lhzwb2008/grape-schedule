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
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import storage
from backend.dashscope_voice import recognize as asr_recognize
from backend.dashscope_voice import synthesize as tts_synthesize
from backend.model_router import run_chat
from backend.omni_realtime import asr_session_update_payload, realtime_ws_url
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


class AttachmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    mime: str = Field(min_length=1, max_length=100)
    data: str = Field(min_length=1)


class ChatBody(BaseModel):
    message: str = Field(default="", max_length=8000)
    force_model: str | None = Field(default=None, description="已忽略：对话固定 DeepSeek")
    attachments: list[AttachmentIn] = Field(default_factory=list)


IMAGE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
MAX_ATTACHMENTS = 5
MAX_FILE_BYTES = 12 * 1024 * 1024


def _prepare_images(attachments: list[AttachmentIn]) -> tuple[list[dict[str, str]], list[str]]:
    if len(attachments) > MAX_ATTACHMENTS:
        raise HTTPException(400, f"一次最多 {MAX_ATTACHMENTS} 张图")
    images: list[dict[str, str]] = []
    names: list[str] = []
    for att in attachments:
        mime = (att.mime or "").split(";")[0].strip().lower()
        name = att.name.strip() or "image"
        raw_b64 = _strip_b64(att.data).strip()
        try:
            raw = base64.b64decode(raw_b64, validate=False)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"附件 {name} 解码失败") from e
        if len(raw) > MAX_FILE_BYTES:
            raise HTTPException(400, f"附件 {name} 超过 12MB")
        if mime not in IMAGE_MIMES and not mime.startswith("image/"):
            raise HTTPException(400, f"仅支持图片：png/jpeg/gif/webp（收到 {mime}）")
        if mime not in IMAGE_MIMES:
            mime = "image/jpeg"
        images.append({"mime": mime, "data_b64": raw_b64})
        names.append(name)
    return images, names


class SessionCreateBody(BaseModel):
    title: str = "新对话"


class AsrBody(BaseModel):
    audio: str = Field(min_length=1)
    mime: str = Field(default="audio/webm", max_length=100)


class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ScheduleUpdateBody(BaseModel):
    schedule: dict[str, Any]


def _public_https_host() -> str:
    host = os.environ.get("PUBLIC_HTTPS_HOST", "").strip()
    if host:
        return host
    # 回退：独立子域，避免与 grape-doctor 的 <ip>.sslip.io 冲突
    return "grape-schedule.101.201.237.149.sslip.io"


@app.get("/api/health")
def health():
    https_host = _public_https_host()
    return {
        "ok": True,
        "name": "小葡萄日程提醒智能体",
        "chat_model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "logic_model": os.environ.get("CURSOR_MODEL_ID", "grok-4.5"),
        "omni_model": os.environ.get("DASHSCOPE_OMNI_MODEL", "qwen3.5-omni-flash-realtime"),
        "default_model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "hard_model": os.environ.get("CURSOR_MODEL_ID", "grok-4.5"),
        "https_host": https_host,
        "https_url": f"https://{https_host}/",
    }


@app.get("/api/members")
def members(role: str | None = None):
    if role and role not in ("child", "parent"):
        raise HTTPException(400, "role 只能是 child 或 parent")
    return {"members": storage.list_members(role=role)}


@app.post("/api/login")
def login(body: LoginBody):
    try:
        member = storage.login(body.user_id)
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
    saved = storage.save_schedule(body.schedule, by=user_id)
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
    print(f"[asr] mime={mime} bytes={len(raw)} text={text!r}", flush=True)
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
    try:
        images, attach_names = _prepare_images(body.attachments or [])
    except HTTPException:
        raise
    if not message and not attach_names:
        raise HTTPException(400, "请输入消息或上传截图")

    stored_user = message or "（发送了截图）"
    if attach_names:
        stored_user += "\n📎 " + "、".join(attach_names) + "（仅本轮使用）"

    storage.append_message(user_id, session_id, "user", stored_user)
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
        chat_text = message
        try:
            _emit({"type": "status", "message": "已收到，正在准备…"})

            if images:
                from backend.vision import describe_images

                _emit({"type": "status", "message": "正在看截图…"})
                desc = describe_images(images, hint=message)
                chat_text = (
                    (message + "\n\n" if message else "")
                    + "【用户上传截图识别结果】\n"
                    + (desc or "（未能识别图中文字）")
                )

            def on_delta(t: str) -> None:
                _emit({"type": "delta", "text": t})

            def on_status(msg: str) -> None:
                _emit({"type": "status", "message": msg})

            result = run_chat(
                member,
                history,
                chat_text,
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
            _emit(
                {
                    "type": "done",
                    "text": final,
                    "provider": result.get("provider"),
                    "model": result.get("model"),
                    "chat_model": result.get("chat_model") or result.get("model"),
                    "logic_model": result.get("logic_model"),
                    "schedule_updated": True,
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


@app.websocket("/api/voice/ws")
async def voice_asr_ws(websocket: WebSocket, token: str = Query(default="")):
    """浏览器 ↔ 本服务 ↔ 百炼 Omni Realtime（按住说话加速转写）。"""
    try:
        _auth_token(token)
    except HTTPException:
        await websocket.close(code=4401)
        return

    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        await websocket.close(code=4502, reason="未配置 DASHSCOPE_API_KEY")
        return

    await websocket.accept()
    await websocket.send_json({"type": "client.status", "status": "connecting"})

    import websockets
    from websockets.exceptions import ConnectionClosed

    upstream = None
    try:
        upstream = await websockets.connect(
            realtime_ws_url(),
            additional_headers={"Authorization": f"Bearer {api_key}"},
            open_timeout=20,
            max_size=8 * 1024 * 1024,
        )
    except Exception as e:  # noqa: BLE001
        await websocket.send_json({"type": "client.error", "message": f"连接语音服务失败：{e}"})
        await websocket.close(code=4502)
        return

    async def client_to_upstream() -> None:
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    evt = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(evt, dict):
                    continue
                et = evt.get("type")
                if et == "session.update":
                    continue
                if et == "client.ping":
                    await websocket.send_json({"type": "client.pong"})
                    continue
                await upstream.send(raw)
        except WebSocketDisconnect:
            pass
        except ConnectionClosed:
            pass

    async def upstream_to_client() -> None:
        configured = False
        try:
            async for message in upstream:
                text = message if isinstance(message, str) else message.decode("utf-8", "ignore")
                await websocket.send_text(text)
                if not configured:
                    try:
                        evt = json.loads(text)
                    except json.JSONDecodeError:
                        evt = {}
                    if isinstance(evt, dict) and evt.get("type") == "session.created":
                        configured = True
                        await upstream.send(json.dumps(asr_session_update_payload(), ensure_ascii=False))
                        await websocket.send_json({"type": "client.status", "status": "ready"})
        except ConnectionClosed:
            pass
        except WebSocketDisconnect:
            pass

    try:
        done, pending = await asyncio.wait(
            [
                asyncio.create_task(client_to_upstream()),
                asyncio.create_task(upstream_to_client()),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc:
                try:
                    await websocket.send_json({"type": "client.error", "message": str(exc)})
                except Exception:  # noqa: BLE001
                    pass
    finally:
        try:
            await upstream.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8766"))
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
