from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class TranslationRequest(BaseModel):
    text: str = Field(..., min_length=1)
    source_language: Optional[str] = None
    # True when the text was dictated (speech-to-text preview), so it is cleaned like a spoken transcript.
    from_speech: bool = False


class TranscriptionResponse(BaseModel):
    text: str


class TranslationResponse(BaseModel):
    detected_language: str
    original_text: str
    english_translation: str
    summary: str


class ChatOut(BaseModel):
    id: str
    title: str
    is_pinned: bool
    is_archived: bool
    is_shared: bool = False
    created_at: str
    updated_at: str


class ChatCreateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)


class ToggleRequest(BaseModel):
    value: Optional[bool] = None


class TitleRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


class MessageIn(BaseModel):
    role: Literal["user", "assistant"]
    content: Optional[str] = Field(default=None, max_length=20000)
    audio_name: Optional[str] = Field(default=None, max_length=255)
    result: Optional[dict[str, Any]] = None


class SaveMessagesRequest(BaseModel):
    messages: list[MessageIn] = Field(..., min_length=1, max_length=20)


class DeleteMessagesRequest(BaseModel):
    message_ids: list[UUID] = Field(..., min_length=1, max_length=200)


class MessageOut(BaseModel):
    id: str
    chat_id: str
    role: str
    content: Optional[str] = None
    audio_name: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    created_at: str


class SharedChatView(BaseModel):
    """Public, login-free response for a chat its owner has explicitly marked is_shared = true."""

    chat: ChatOut
    messages: list[MessageOut]


class MeetingChatOut(BaseModel):
    """A Meeting Chat: the persistent container a "Start Meeting" recording is saved into (see
    supabase/meeting_chats.sql). Shaped exactly like ChatOut (minus is_shared, which meetings don't support) so
    the frontend can reuse the same sidebar list item/pin/archive/delete UI for both."""

    id: str
    title: str
    is_pinned: bool
    is_archived: bool
    is_shared: bool = False  # default keeps working on a database that has not run the sharing migration yet
    created_at: str
    updated_at: str


class SharedMeetingResult(BaseModel):
    """One result inside a shared Meeting Chat: translation + summary only (no transcript, no owner ids)."""

    id: str
    translation: str = ""
    summary: str = ""
    created_at: str


class SharedMeetingChatView(BaseModel):
    chat: MeetingChatOut
    results: list[SharedMeetingResult]


class MeetingCreateResponse(BaseModel):
    id: str
    status: str
    # The Meeting Chat this recording was (or was just, if none was given) saved into - the frontend always needs
    # this, even for a brand-new chat it didn't create itself first (see meeting_routes.start_meeting).
    meeting_chat_id: str


class MeetingStatusResponse(BaseModel):
    """The live/in-progress job. transcript is deliberately NOT a field here: it's generated and stored (in the
    in-memory job and, once completed, in Supabase) but is never sent to the frontend at all - response_model
    filtering drops it even though the underlying job dict still carries it internally."""

    id: str
    status: str
    duration_seconds: Optional[int] = None
    translation: Optional[str] = None
    summary: Optional[str] = None
    error_message: Optional[str] = None


class MeetingListItem(BaseModel):
    """One row in Meeting History - deliberately excludes translation/transcript (only a summary preview is
    needed for the list; the full translation is fetched only when a specific meeting is opened). No updated_at:
    nothing reads it and not every deployed meetings table has that column."""

    id: str
    status: str
    duration_seconds: Optional[int] = None
    summary: Optional[str] = None
    created_at: str


class MeetingDetail(BaseModel):
    """A single saved meeting, opened from history. No transcript field, same as MeetingStatusResponse - stored
    in Supabase, never returned here. No updated_at, same reason as MeetingListItem above."""

    id: str
    status: str
    duration_seconds: Optional[int] = None
    translation: Optional[str] = None
    summary: Optional[str] = None
    created_at: str
