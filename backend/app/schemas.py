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


class MeetingCreateResponse(BaseModel):
    id: str
    status: str


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
    needed for the list; the full translation is fetched only when a specific meeting is opened)."""

    id: str
    status: str
    duration_seconds: Optional[int] = None
    summary: Optional[str] = None
    created_at: str
    updated_at: str


class MeetingDetail(BaseModel):
    """A single saved meeting, opened from history. No transcript field, same as MeetingStatusResponse - stored
    in Supabase, never returned here."""

    id: str
    status: str
    duration_seconds: Optional[int] = None
    translation: Optional[str] = None
    summary: Optional[str] = None
    created_at: str
    updated_at: str
