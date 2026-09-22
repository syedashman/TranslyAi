import asyncio
import gc
from typing import Awaitable, Literal, Optional, TypeVar
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse

from app.schemas import (
    ChatCreateRequest,
    ChatOut,
    DeleteMessagesRequest,
    MessageOut,
    SaveMessagesRequest,
    SharedChatView,
    TitleRequest,
    ToggleRequest,
    TranscriptionResponse,
    TranslationRequest,
    TranslationResponse,
)
from app.services.chat_store import ChatStore, ChatStoreError
from app.services.language import LanguageService
from app.services.moderation import ModerationService, ProhibitedContentError
from app.services.speech import SpeechService
from app.services.summarizer import SummarizerService
from app.services.titler import TitleService
from app.services.translation import TranslationService
from app.services.translator import translate_and_summarize

router = APIRouter(prefix="/api", tags=["translator"])

PROHIBITED_CONTENT_BODY = {"error": "prohibited_content", "message": "This content cannot be translated."}


@router.post("/translate", response_model=TranslationResponse)
async def translate_endpoint(request: TranslationRequest):
    source_language = getattr(request, "source_lang", request.source_language)
    try:
        # Moderate the user's original input before it ever reaches Gemini translation. A moderation-call
        # failure or timeout is never treated as "blocked" - it falls straight through to translation as usual.
        await asyncio.wait_for(asyncio.to_thread(ModerationService.check, request.text), timeout=15.0)
    except ProhibitedContentError:
        return JSONResponse(status_code=422, content=PROHIBITED_CONTENT_BODY)
    except Exception as exc:
        print(f"MODERATION ENDPOINT ERROR (allowing through): {exc}")

    try:
        detected_language = LanguageService.normalize_code(source_language)
        if detected_language is None:
            detected_language = await asyncio.wait_for(
                asyncio.to_thread(LanguageService.detect, request.text),
                timeout=15.0,
            )

        translated_text, translated = await asyncio.wait_for(
            asyncio.to_thread(TranslationService.translate_with_status, request.text, request.from_speech),
            timeout=70.0,  # long dictated messages need more than a few seconds
        )
    except Exception as exc:
        print(f"TRANSLATE ENDPOINT ERROR: {exc}")
        translated_text, translated = TranslationService._fallback_message, False

    if not translated:
        summary = SummarizerService._fallback_message
    else:
        try:
            summary = await asyncio.wait_for(
                asyncio.to_thread(SummarizerService.summarize, translated_text),
                timeout=45.0,
            )
        except Exception as exc:
            print(f"SUMMARY ENDPOINT ERROR: {exc}")
            summary = SummarizerService._fallback_message

    fallback_language = LanguageService.normalize_code(source_language) or "en"
    return {
        "detected_language": LanguageService.display_name(fallback_language),
        "original_text": request.text.strip(),
        "english_translation": translated_text.strip(),
        "summary": summary.strip(),
    }


@router.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_only(
    file: UploadFile = File(...),
    source_language: str | None = Form(default=None),
):
    """Speech-to-text only: returns the raw transcript so the client can show it for review before translating."""
    gc.collect()
    audio_path = None
    try:
        if not file.filename:
            raise ValueError("No audio file uploaded.")

        audio_path = await SpeechService.save_upload(file)
        # roman=True: Whisper may answer in Urdu/Devanagari script, but the preview must be Roman Urdu / English.
        text = await SpeechService.transcribe_file(audio_path, language=LanguageService.normalize_code(source_language), roman=True)
        return {"text": text.strip()}
    except ValueError as exc:
        print(f"TRANSCRIBE ENDPOINT VALUE ERROR: {exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        print(f"TRANSCRIBE ENDPOINT RUNTIME ERROR: {exc}")
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        print(f"TRANSCRIBE ENDPOINT ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            SpeechService.discard(audio_path)
            await file.close()
        except Exception as cleanup_error:
            print(f"TRANSCRIBE ENDPOINT CLEANUP ERROR: {cleanup_error}")
        gc.collect()


@router.post("/audio", response_model=TranslationResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    source_language: str | None = Form(default=None),
):
    gc.collect()
    audio_path = None
    try:
        if not file.filename:
            raise ValueError("No audio file uploaded.")

        audio_path = await SpeechService.save_upload(file)
        result = await translate_and_summarize(
            text="",
            source_language=source_language,
            audio_path=audio_path,
        )
        return result
    except ProhibitedContentError:
        return JSONResponse(status_code=422, content=PROHIBITED_CONTENT_BODY)
    except ValueError as exc:
        print(f"AUDIO ENDPOINT VALUE ERROR: {exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        print(f"AUDIO ENDPOINT RUNTIME ERROR: {exc}")
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        print(f"AUDIO ENDPOINT ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            SpeechService.discard(audio_path)
            await file.close()
        except Exception as cleanup_error:
            print(f"AUDIO ENDPOINT CLEANUP ERROR: {cleanup_error}")
        gc.collect()


# ---------------------------------------------------------------------------
# Saved chats (ChatGPT-style). Every route needs the user's Supabase access token:
#   Authorization: Bearer <token>
# The token is forwarded to Supabase, whose row-level security limits each user to their own rows.
# ---------------------------------------------------------------------------

T = TypeVar("T")


def bearer_token(authorization: Optional[str] = Header(default=None)) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Please log in to use saved chats.")
    return token.strip()


async def store_call(call: Awaitable[T]) -> T:
    try:
        return await call
    except ChatStoreError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


def require_found(row: Optional[T], message: str = "Chat not found.") -> T:
    if row is None:
        raise HTTPException(status_code=404, detail=message)
    return row


@router.get("/chats", response_model=list[ChatOut])
async def list_chats(archived: Literal["true", "false", "all"] = "false", token: str = Depends(bearer_token)):
    """Pinned chats first, then most recently updated. Use archived=all to get both active and archived."""
    return await store_call(ChatStore.list_chats(token, archived))


@router.post("/chats", response_model=ChatOut, status_code=201)
async def create_chat(body: Optional[ChatCreateRequest] = None, token: str = Depends(bearer_token)):
    title = body.title.strip() if body and body.title else None
    return await store_call(ChatStore.create_chat(token, title))


@router.patch("/chats/{chat_id}/pin", response_model=ChatOut)
async def toggle_pin(chat_id: UUID, body: Optional[ToggleRequest] = None, token: str = Depends(bearer_token)):
    """Flips is_pinned, or sets it explicitly when {"value": true|false} is sent."""
    chat = require_found(await store_call(ChatStore.get_chat(token, chat_id)))
    pinned = body.value if body and body.value is not None else not chat["is_pinned"]
    return require_found(await store_call(ChatStore.update_chat(token, chat_id, {"is_pinned": pinned})))


@router.patch("/chats/{chat_id}/archive", response_model=ChatOut)
async def toggle_archive(chat_id: UUID, body: Optional[ToggleRequest] = None, token: str = Depends(bearer_token)):
    """Flips is_archived (archiving also unpins), or sets it explicitly when {"value": true|false} is sent."""
    chat = require_found(await store_call(ChatStore.get_chat(token, chat_id)))
    archived = body.value if body and body.value is not None else not chat["is_archived"]
    fields = {"is_archived": archived, **({"is_pinned": False} if archived else {})}
    return require_found(await store_call(ChatStore.update_chat(token, chat_id, fields)))


@router.patch("/chats/{chat_id}/share", response_model=ChatOut)
async def toggle_share(chat_id: UUID, body: Optional[ToggleRequest] = None, token: str = Depends(bearer_token)):
    """Flips is_shared, or sets it explicitly when {"value": true|false} is sent.

    Only the chat's owner can reach this row at all (ChatStore.get_chat/update_chat still go through the caller's
    own token, and only the owner-only row-level security policy grants insert/update), so nobody but the owner can
    ever turn sharing on or off for a chat. Once is_shared is true, a separate read-only policy
    (supabase/chats.sql) lets other signed-in users open that one chat by its id.
    """
    chat = require_found(await store_call(ChatStore.get_chat(token, chat_id)))
    shared = body.value if body and body.value is not None else not chat["is_shared"]
    return require_found(await store_call(ChatStore.update_chat(token, chat_id, {"is_shared": shared})))


@router.delete("/chats/{chat_id}", status_code=204)
async def delete_chat(chat_id: UUID, token: str = Depends(bearer_token)):
    if not await store_call(ChatStore.delete_chat(token, chat_id)):
        raise HTTPException(status_code=404, detail="Chat not found.")
    return Response(status_code=204)


@router.get("/chats/{chat_id}/messages", response_model=list[MessageOut])
async def get_messages(chat_id: UUID, token: str = Depends(bearer_token)):
    require_found(await store_call(ChatStore.get_chat(token, chat_id)))
    return await store_call(ChatStore.list_messages(token, chat_id))


@router.get("/chats/{chat_id}/shared", response_model=SharedChatView)
async def get_shared_chat(chat_id: UUID):
    """Public, login-free view of a chat its owner explicitly marked shared - for a share link opened by someone
    with no account/session at all (e.g. an incognito visitor). No Authorization header is required or used.

    Only ever returns a chat that is_shared = true (see ChatStore.get_shared_chat); anything else 404s exactly
    like a private chat does for get_messages above, so this can't be used to probe which chat ids exist.
    """
    chat = require_found(await store_call(ChatStore.get_shared_chat(chat_id)))
    messages = await store_call(ChatStore.list_shared_messages(chat_id))
    return {"chat": chat, "messages": messages}


@router.post("/chats/{chat_id}/messages", response_model=list[MessageOut], status_code=201)
async def save_messages(chat_id: UUID, body: SaveMessagesRequest, token: str = Depends(bearer_token)):
    messages = [message.model_dump() for message in body.messages]
    return await store_call(ChatStore.add_messages(token, chat_id, messages))


@router.post("/chats/{chat_id}/messages/delete")
async def delete_messages(chat_id: UUID, body: DeleteMessagesRequest, token: str = Depends(bearer_token)):
    """Removes messages from a chat; used when an edited prompt replaces the exchange that followed it."""
    require_found(await store_call(ChatStore.get_chat(token, chat_id)))
    deleted = await store_call(ChatStore.delete_messages(token, chat_id, body.message_ids))
    if deleted == 0:
        raise HTTPException(
            status_code=403,
            detail="The database did not remove those messages. Run supabase/chats.sql in the Supabase SQL Editor to fix the table rules.",
        )
    return {"deleted": deleted}


@router.post("/chats/{chat_id}/title", response_model=ChatOut)
async def generate_chat_title(chat_id: UUID, body: TitleRequest, token: str = Depends(bearer_token)):
    """Names a new chat with a 3-5 word Gemini title. A chat that already has a title is returned unchanged."""
    chat = require_found(await store_call(ChatStore.get_chat(token, chat_id)))
    if not TitleService.is_untitled(chat["title"]):
        return chat
    title = await asyncio.to_thread(TitleService.generate, body.text)
    return require_found(await store_call(ChatStore.update_chat(token, chat_id, {"title": title})))
