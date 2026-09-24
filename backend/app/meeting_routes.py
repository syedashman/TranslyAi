"""The "Start Meeting" endpoints - entirely separate from routes.py's /api/audio and /api/transcribe, which are
untouched. Requires login (same bearer-token pattern as saved chats) since a meeting is a longer-lived, owned
record rather than a one-off translation.
"""

from typing import Awaitable, TypeVar

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile

from app.routes import bearer_token
from app.schemas import MeetingCreateResponse, MeetingDetail, MeetingListItem, MeetingStatusResponse
from app.services.chat_store import user_id_from_token
from app.services.meeting_jobs import create_job, get_job
from app.services.meeting_processor import process_meeting
from app.services.meeting_store import MeetingStore, MeetingStoreError
from app.services.speech import SpeechService

T = TypeVar("T")

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

# A 30-100 minute recording is naturally much bigger than a short voice clip; this is separate from (and does not
# change) the existing 25 MB limit used by /api/audio and /api/transcribe. 300 MB comfortably covers 100 minutes
# even at a generous bitrate (100 min of opus/webm at 128kbps is roughly 96 MB).
MAX_MEETING_AUDIO_BYTES = 300 * 1024 * 1024


@router.post("", response_model=MeetingCreateResponse, status_code=202)
async def start_meeting(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    duration_seconds: int | None = Form(default=None),
    token: str = Depends(bearer_token),
):
    """Saves the finalized recording, creates a job, and returns immediately - the actual transcribe/translate/
    summarize pipeline runs as a background task after this response is sent, so the request is never held open
    for the minutes it can take to process a long meeting."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No audio file uploaded.")

    try:
        audio_path = await SpeechService.save_upload(file, max_bytes=MAX_MEETING_AUDIO_BYTES)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        await file.close()

    job = create_job(user_id_from_token(token), duration_seconds)
    background_tasks.add_task(process_meeting, job["id"], audio_path)
    await MeetingStore.upsert(job)
    return {"id": job["id"], "status": job["status"]}


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
