"""The "Start Meeting" endpoints - entirely separate from routes.py's /api/audio and /api/transcribe, which are
untouched. Requires login (same bearer-token pattern as saved chats) since a meeting is a longer-lived, owned
record rather than a one-off translation.
"""

import asyncio
from typing import Awaitable, Literal, Optional, TypeVar
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Response, UploadFile

from app.routes import bearer_token
from app.schemas import (
    MeetingChatOut,
    MeetingCreateResponse,
    MeetingDetail,
    MeetingListItem,
    MeetingStatusResponse,
    TitleRequest,
    ToggleRequest,
)
from app.services.chat_store import user_id_from_token
from app.services.meeting_chat_store import MeetingChatStore, MeetingChatStoreError
from app.services.meeting_jobs import create_job, get_job
from app.services.meeting_processor import process_meeting
from app.services.meeting_store import MeetingStore, MeetingStoreError
from app.services.speech import SpeechService
from app.services.titler import TitleService

T = TypeVar("T")

router = APIRouter(prefix="/api/meetings", tags=["meetings"])
# Separate router/prefix for the Meeting Chat CONTAINER (create/list/pin/archive/delete/title/results) - kept in
# this same file since it's still all "meetings", but under /api/meeting-chats so its routes don't collide with
# router's /api/meetings/{meeting_id} paths above.
chats_router = APIRouter(prefix="/api/meeting-chats", tags=["meeting-chats"])

# A 30-100 minute recording is naturally much bigger than a short voice clip; this is separate from (and does not
# change) the existing 25 MB limit used by /api/audio and /api/transcribe. 300 MB comfortably covers 100 minutes
# even at a generous bitrate (100 min of opus/webm at 128kbps is roughly 96 MB).
MAX_MEETING_AUDIO_BYTES = 300 * 1024 * 1024


async def _chat_store_call(call: Awaitable[T]) -> T:
    try:
        return await call
    except MeetingChatStoreError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


def _require_chat(row: Optional[dict]) -> dict:
    if row is None:
        raise HTTPException(status_code=404, detail="Meeting chat not found.")
    return row


@router.post("", response_model=MeetingCreateResponse, status_code=202)
async def start_meeting(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    duration_seconds: int | None = Form(default=None),
    meeting_chat_id: str | None = Form(default=None),
    token: str = Depends(bearer_token),
):
    """Saves the finalized recording, creates a job, and returns immediately - the actual transcribe/translate/
    summarize pipeline runs as a background task after this response is sent, so the request is never held open
    for the minutes it can take to process a long meeting.

    Every recording belongs to exactly one Meeting Chat (the persistent container shown in the Meetings sidebar
    tab - see supabase/meeting_chats.sql): pass an existing one's id to add another result to it, or omit it to
    have a brand-new Meeting Chat created on the fly (the very first recording of a new conversation) - either
    way the response's meeting_chat_id tells the caller which chat this result landed in.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No audio file uploaded.")

    user_id = user_id_from_token(token)
    if meeting_chat_id:
        chat = _require_chat(await _chat_store_call(MeetingChatStore.get_chat(token, meeting_chat_id)))
    else:
        chat = await _chat_store_call(MeetingChatStore.create_chat(token, user_id))
    chat_id = chat["id"]

    try:
        audio_path = await SpeechService.save_upload(file, max_bytes=MAX_MEETING_AUDIO_BYTES)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        await file.close()

    job = create_job(user_id, duration_seconds, meeting_chat_id=chat_id)
    background_tasks.add_task(process_meeting, job["id"], audio_path)
    await MeetingStore.upsert(job)
    return {"id": job["id"], "status": job["status"], "meeting_chat_id": chat_id}


@router.get("/{meeting_id}/status", response_model=MeetingStatusResponse)
async def meeting_status(meeting_id: str, token: str = Depends(bearer_token)):
    """Current stage while processing, or the translation/summary once status is "completed" (or error_message
    if status is "failed"). Only the meeting's own owner can read it. This is the LIVE, in-memory job - it works
    regardless of whether Supabase persistence (see the routes below) is configured or has caught up yet."""
    job = get_job(meeting_id)
    if job is None or job.get("user_id") is None or job["user_id"] != user_id_from_token(token):
        raise HTTPException(status_code=404, detail="Meeting not found.")
    return job


async def _store_call(call: Awaitable[T]) -> T:
    try:
        return await call
    except MeetingStoreError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


@router.get("", response_model=list[MeetingListItem])
async def list_meetings(token: str = Depends(bearer_token)):
    """Meeting History: this user's completed, saved meetings, newest first - reads Supabase directly (not the
    in-memory job registry, which only holds whatever is still live in this process)."""
    return await _store_call(MeetingStore.list_for_user(token, user_id_from_token(token)))


@router.get("/{meeting_id}", response_model=MeetingDetail)
async def get_meeting(meeting_id: str, token: str = Depends(bearer_token)):
    """Opens one saved meeting from history - the already-stored translation/summary, never re-transcribed or
    re-translated. Ownership is enforced both by row-level security and an explicit user_id filter (see
    MeetingStore.get_for_user); anything else - someone else's meeting, or one that isn't status=completed - 404s
    exactly like a private chat does, never a 403 that would confirm the id exists."""
    meeting = await _store_call(MeetingStore.get_for_user(token, user_id_from_token(token), meeting_id))
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found.")
    return meeting


# ---------- Meeting Chats: the persistent container shown in the Meetings sidebar tab ----------
# Full pin/archive/delete/title parity with normal chats (see routes.py's /chats endpoints, which these
# deliberately mirror) - a Meeting Chat is a first-class conversation, just one whose "messages" are meeting
# results instead of translated text.


@chats_router.post("", response_model=MeetingChatOut, status_code=201)
async def create_meeting_chat(token: str = Depends(bearer_token)):
    """An empty Meeting Chat - "New chat" while the Meetings tab is selected. Recording is what actually fills
    it; POST /api/meetings also creates one on the fly if none is passed, so this endpoint exists purely so the
    sidebar can show the new, empty conversation immediately, before the user has recorded anything into it."""
    return await _chat_store_call(MeetingChatStore.create_chat(token, user_id_from_token(token)))


@chats_router.get("", response_model=list[MeetingChatOut])
async def list_meeting_chats(archived: Literal["true", "false", "all"] = "false", token: str = Depends(bearer_token)):
    """Pinned first, then most recently updated - same ordering as GET /api/chats. Use archived=all to get both."""
    return await _chat_store_call(MeetingChatStore.list_chats(token, user_id_from_token(token), archived))


@chats_router.patch("/{chat_id}/pin", response_model=MeetingChatOut)
async def toggle_meeting_chat_pin(chat_id: UUID, body: Optional[ToggleRequest] = None, token: str = Depends(bearer_token)):
    chat = _require_chat(await _chat_store_call(MeetingChatStore.get_chat(token, chat_id)))
    pinned = body.value if body and body.value is not None else not chat["is_pinned"]
    return _require_chat(await _chat_store_call(MeetingChatStore.update_chat(token, chat_id, {"is_pinned": pinned})))


@chats_router.patch("/{chat_id}/archive", response_model=MeetingChatOut)
async def toggle_meeting_chat_archive(chat_id: UUID, body: Optional[ToggleRequest] = None, token: str = Depends(bearer_token)):
    """Flips is_archived (archiving also unpins), same behavior as toggle_archive for normal chats."""
    chat = _require_chat(await _chat_store_call(MeetingChatStore.get_chat(token, chat_id)))
    archived = body.value if body and body.value is not None else not chat["is_archived"]
    fields = {"is_archived": archived, **({"is_pinned": False} if archived else {})}
    return _require_chat(await _chat_store_call(MeetingChatStore.update_chat(token, chat_id, fields)))


@chats_router.delete("/{chat_id}", status_code=204)
async def delete_meeting_chat(chat_id: UUID, token: str = Depends(bearer_token)):
    """Deletes the Meeting Chat AND every meeting result saved inside it - not just this one row. The cascade
    comes from the foreign key in supabase/meeting_chats.sql (meetings.meeting_chat_id references meeting_chats.id
    on delete cascade); this endpoint only has to remove the parent."""
    if not await _chat_store_call(MeetingChatStore.delete_chat(token, chat_id)):
        raise HTTPException(status_code=404, detail="Meeting chat not found.")
    return Response(status_code=204)


@chats_router.post("/{chat_id}/title", response_model=MeetingChatOut)
async def generate_meeting_chat_title(chat_id: UUID, body: TitleRequest, token: str = Depends(bearer_token)):
    """Names a Meeting Chat with a 3-5 word Gemini title, generated from its first result's summary - reuses the
    exact same TitleService/model rotation as normal chats (see routes.generate_chat_title), nothing duplicated.
    A chat that already has a title (TitleService.is_untitled treats "New meeting" as not-yet-named) is returned
    unchanged, so this is safe to call after every result without ever renaming a chat twice."""
    chat = _require_chat(await _chat_store_call(MeetingChatStore.get_chat(token, chat_id)))
    if not TitleService.is_untitled(chat["title"]):
        return chat
    title = await asyncio.to_thread(TitleService.generate, body.text)
    return _require_chat(await _chat_store_call(MeetingChatStore.update_chat(token, chat_id, {"title": title})))


@chats_router.get("/{chat_id}/meetings", response_model=list[MeetingDetail])
async def list_meeting_chat_results(chat_id: UUID, token: str = Depends(bearer_token)):
    """All completed results inside one Meeting Chat, oldest first - the conversation-like timeline MeetingChat.jsx
    renders (Translation + Summary per result; transcript is never returned, same as MeetingDetail everywhere
    else). Ownership is checked by loading the chat itself first, exactly like GET /chats/{id}/messages does for
    normal chats, so someone else's chat id 404s instead of silently returning an empty list."""
    _require_chat(await _chat_store_call(MeetingChatStore.get_chat(token, chat_id)))
    return await _chat_store_call(MeetingChatStore.list_results(token, user_id_from_token(token), chat_id))
