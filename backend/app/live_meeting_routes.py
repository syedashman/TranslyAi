"""Live Meeting endpoints - additive; meeting_routes.py (Record Meeting / Upload Recording / Meeting Chats) is not
modified.

HOST (authenticated, the only role that can capture audio or stop the meeting):
  POST /api/live-meetings            (bearer token) validates/creates the Meeting Chat, returns
                                     { id, status, meeting_chat_id, share_token, share_path }
  WS   /ws/live-meeting/{meeting_id} first message must be {"type":"auth","token":<access token>}; then binary
                                     frames of PCM16 mono 16 kHz audio in, JSON events out
Once stopped, the finished result is read through the EXISTING GET /api/meetings/{id}/status, exactly like a
recording, and lands in the same Meeting Chat.

VIEWERS (no account needed; strictly read-only - see live_meeting.LiveSession.attach_viewer):
  WS   /ws/live-view/{share_token}   nothing to send; events out. Anything a viewer sends other than a heartbeat is ignored.
  GET  /api/live-share/{share_token} the same snapshot over plain HTTP (404 for an unknown/expired link)
  POST /api/live-share/claim         (bearer token) a signed-in viewer saves a COPY of the meeting they watched
"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel

from app.config import settings
from app.meeting_routes import _chat_store_call, _require_chat
from app.routes import bearer_token
from app.schemas import MeetingCreateResponse
from app.services import live_meeting, live_share, live_stt
from app.services.chat_store import user_id_from_token
from app.services.meeting_chat_store import MeetingChatStore

logger = logging.getLogger("ai-translator")

router = APIRouter(tags=["live-meeting"])

AUTH_TIMEOUT_SECONDS = 10.0
# One generic close for "no such meeting" and "not yours": never confirms whether someone else's id exists.
CLOSE_UNAUTHORIZED = 4401


class LiveMeetingCreate(BaseModel):
    meeting_chat_id: Optional[str] = None


class LiveMeetingCreated(MeetingCreateResponse):
    # Public, unguessable, read-only viewing credential for THIS meeting only (see live_share.py).
    share_token: str
    share_path: str


class ClaimRequest(BaseModel):
    claim_token: str


@router.post("/api/live-meetings", response_model=LiveMeetingCreated, status_code=201)
async def create_live_meeting(body: Optional[LiveMeetingCreate] = None, token: str = Depends(bearer_token)):
    if not settings.live_meeting_enabled:
        raise HTTPException(status_code=404, detail="Live Meeting is not enabled.")
    if not live_stt.is_configured():
        raise HTTPException(status_code=503, detail="Live Meeting isn't available: the speech service isn't configured on the server.")

    user_id = user_id_from_token(token)
    try:
        live_meeting.ensure_can_start(user_id)
    except live_meeting.LiveSessionBusy:
        raise HTTPException(status_code=409, detail="A live meeting is already running for your account.") from None

    meeting_chat_id = body.meeting_chat_id if body else None
    if meeting_chat_id:
        # Same ownership rule as recordings: loaded with the caller's own token, so someone else's chat 404s.
        chat = _require_chat(await _chat_store_call(MeetingChatStore.get_chat(token, meeting_chat_id)))
    else:
        chat = await _chat_store_call(MeetingChatStore.create_chat(token, user_id))
    session = live_meeting.create_session(user_id, chat["id"])
    return {"id": session.job_id, "status": "live", "meeting_chat_id": chat["id"],
            "share_token": session.share_token, "share_path": f"/?live={session.share_token}"}


@router.post("/api/live-meetings/{meeting_id}/cancel")
async def cancel_live_meeting(meeting_id: str, token: str = Depends(bearer_token)):
    """Cancel = DISCARD (never finalize/save). Host only: same ownership rule as the WebSocket - someone else's id
    and an unknown id both 404, never confirming that it exists. 409 only if the result is already saved."""
    user_id = await live_meeting.verify_supabase_user(token)
    session = live_meeting.get_session(meeting_id)
    if session is None or user_id is None or user_id != session.user_id:
        finished = live_meeting.find_share_by_meeting_id(meeting_id)
        if finished is not None and user_id is not None and user_id == finished.user_id:
            if finished.outcome == "completed":
                raise HTTPException(status_code=409, detail="This meeting has already been saved, so it can no longer be cancelled.")
            return {"id": meeting_id, "status": "cancelled"}  # idempotent: a retried cancel of a cancelled/failed meeting succeeds
        raise HTTPException(status_code=404, detail="Live meeting not found.")
    outcome = await session.cancel()
    if outcome == "too_late":
        raise HTTPException(status_code=409, detail="This meeting has already been saved, so it can no longer be cancelled.")
    return {"id": meeting_id, "status": "cancelled"}


@router.websocket("/ws/live-meeting/{meeting_id}")
async def live_meeting_socket(ws: WebSocket, meeting_id: str):
    await ws.accept()
    session = live_meeting.get_session(meeting_id)
    try:
        first = await asyncio.wait_for(ws.receive_text(), timeout=AUTH_TIMEOUT_SECONDS)
        message = json.loads(first)
        token = message.get("token") if isinstance(message, dict) and message.get("type") == "auth" else None
    except Exception:  # noqa: BLE001 - timeout, disconnect, or malformed first frame
        await _close(ws, CLOSE_UNAUTHORIZED)
        return

    user_id = await live_meeting.verify_supabase_user(token) if isinstance(token, str) else None
    if session is None or user_id is None or user_id != session.user_id:
        await _close(ws, CLOSE_UNAUTHORIZED)
        return

    await session.attach(ws)
    try:
        while True:
            message = await asyncio.wait_for(ws.receive(), timeout=settings.live_ws_idle_timeout_seconds)
            if message["type"] == "websocket.disconnect":
                break
            data, text = message.get("bytes"), message.get("text")
            if len(data or text or "") > settings.live_ws_max_message_size:
                await _close(ws, 1009)
                break
            if data:
                session.feed_audio(data)
            elif text:
                try:
                    event = json.loads(text)
                except ValueError:
                    continue
                kind = event.get("type") if isinstance(event, dict) else None
                if kind == "stop":
                    await session.stop()
                elif kind == "cancel":
                    await session.cancel()
                elif kind == "pause":
                    await session.pause()
                elif kind == "resume":
                    await session.resume()
                elif kind == "ping":
                    await session.send({"type": "pong"})
    except asyncio.TimeoutError:
        logger.info("LIVE MEETING %s: browser connection idle for %ss", meeting_id, settings.live_ws_idle_timeout_seconds)
    except Exception as error:  # noqa: BLE001 - includes starlette's WebSocketDisconnect
        logger.info("LIVE MEETING %s: socket ended (%s)", meeting_id, error.__class__.__name__)
    finally:
        await session.detach(ws)


# ---------- read-only viewers ----------

CLOSE_UNAVAILABLE = 4404
CLOSE_FULL = 4429
VIEWER_MAX_MESSAGE_SIZE = 1024  # a viewer only ever sends tiny heartbeats


@router.websocket("/ws/live-view/{share_token}")
async def live_view_socket(ws: WebSocket, share_token: str):
    """Guests and signed-in participants alike. The share token is the only credential and it grants exactly one
    thing: watching this meeting. This handler never calls attach() (host), never feeds audio and never stops the
    meeting, whatever the client sends - read-only is structural, not a permission flag a client could flip."""
    await ws.accept()
    session = live_meeting.get_share(share_token)
    if session is None:
        await _close(ws, CLOSE_UNAVAILABLE)
        return
    if not await session.attach_viewer(ws):
        await _close(ws, CLOSE_FULL)
        return
    try:
        while True:
            message = await asyncio.wait_for(ws.receive(), timeout=settings.live_ws_idle_timeout_seconds)
            if message["type"] == "websocket.disconnect":
                break
            if len(message.get("bytes") or message.get("text") or "") > VIEWER_MAX_MESSAGE_SIZE:
                await _close(ws, 1009)
                break
            text = message.get("text")
            if text:
                try:
                    event = json.loads(text)
                except ValueError:
                    continue
                if isinstance(event, dict) and event.get("type") == "ping":
                    await session.send_to_viewer(ws, {"type": "pong"})
            # Binary frames (audio), "stop", "auth", "role": ... - all deliberately ignored for a viewer.
    except asyncio.TimeoutError:
        pass
    except Exception as error:  # noqa: BLE001 - includes starlette's WebSocketDisconnect
        logger.info("LIVE VIEW: socket ended (%s)", error.__class__.__name__)
    finally:
        await session.detach_viewer(ws)  # a viewer leaving never touches the host's meeting


@router.get("/api/live-share/{share_token}")
async def live_share_snapshot(share_token: str):
    session = live_meeting.get_share(share_token)
    if session is None:
        raise HTTPException(status_code=404, detail="This live meeting is no longer available.")
    return session.snapshot("viewer")


@router.post("/api/live-share/claim")
async def claim_live_meeting(body: ClaimRequest, token: str = Depends(bearer_token)):
    """A signed-in person (typically a guest who just signed up) saves a COPY of the one meeting their claim token
    was issued for, into a new Meeting Chat in their OWN account. The host's chats/meetings are never exposed."""
    user_id = await live_meeting.verify_supabase_user(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Your session has expired. Please log in again.")
    try:
        return await live_share.claim_copy(token, user_id, body.claim_token)
    except live_share.ClaimError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    except Exception as error:  # noqa: BLE001 - includes MeetingChatStoreError; never leak internals
        logger.error("LIVE CLAIM FAILED: %r", error)
        status = getattr(error, "status_code", 502)
        raise HTTPException(status_code=status if isinstance(status, int) else 502, detail="Could not save the meeting right now. Please try again.") from None


async def _close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:  # noqa: BLE001 - already closed
        pass
