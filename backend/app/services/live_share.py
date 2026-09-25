"""Live Meeting sharing: share tokens, guest "claim" tokens, and the claim itself.

Three separate credentials, never interchangeable:
  * host access   - the host's Supabase login + the private job id (live_meeting_routes, unchanged)
  * share token   - random 256-bit URL token; lets ANYONE with the link watch ONE live meeting, read-only
  * claim token   - HMAC-signed, expiring; lets one signed-in user save a COPY of ONE finished meeting

None of them can reach the host's private Meeting Chats: the share/claim paths never touch meeting_chats or the
meetings table beyond that single meeting, and the copy goes into a NEW Meeting Chat in the claimer's own account.
"""

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
import uuid
from typing import Optional

from app.config import settings
from app.services.meeting_chat_store import MeetingChatStore
from app.services.meeting_store import MeetingStore

logger = logging.getLogger("ai-translator")

_PROCESS_SECRET = secrets.token_bytes(32)
_CLAIM_NAMESPACE = uuid.UUID("6f0c5d1e-3b7a-4f7e-9a55-7c1d2f1a0b11")


def new_share_token() -> str:
    return secrets.token_urlsafe(32)


def _secret() -> bytes:
    explicit = settings.live_claim_secret.strip()
    if explicit:
        return explicit.encode()
    service_key = settings.supabase_service_role_key.strip()
    if service_key:
        return hmac.new(service_key.encode(), b"translyai-live-claim-v1", hashlib.sha256).digest()
    return _PROCESS_SECRET


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def mint_claim_token(meeting_id: str) -> str:
    payload = _b64(json.dumps({"m": meeting_id, "e": int(time.time()) + settings.live_claim_ttl_seconds}, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def verify_claim_token(token: str) -> Optional[str]:
    """The meeting id the token was minted for, or None if it is forged, tampered with, malformed or expired."""
    try:
        payload, signature = token.split(".", 1)
        expected = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        claims = json.loads(_unb64(payload))
        if int(claims["e"]) < time.time():
            return None
        return str(claims["m"])
    except (ValueError, KeyError, TypeError, IndexError):
        return None


class ClaimError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


async def claim_copy(user_token: str, user_id: str, claim_token: str) -> dict:
    """Saves a copy of the ONE meeting the claim token was minted for into a new Meeting Chat owned by user_id.
    Idempotent: claiming the same meeting again as the same user returns the copy that already exists."""
    from app.services import live_meeting  # local import: live_meeting imports this module at load time

    meeting_id = verify_claim_token(claim_token)
    if meeting_id is None:
        raise ClaimError(400, "This save link is invalid or has expired.")

    session = live_meeting.find_finished_by_meeting_id(meeting_id)
    if session is not None and session.outcome == "completed":
        content = session.saved_content()
    else:
        row = await MeetingStore.fetch_by_id(meeting_id)
        if row is None:
            raise ClaimError(404, "This meeting is no longer available to save.")
        content = {"translation": row.get("translation"), "summary": row.get("summary"), "duration_seconds": row.get("duration_seconds")}
    if not content.get("translation"):
        raise ClaimError(404, "This meeting is no longer available to save.")
    if not MeetingStore.is_configured():
        raise ClaimError(503, "Saving meetings isn't available right now. Please try again later.")

    copy_id = str(uuid.uuid5(_CLAIM_NAMESPACE, f"{meeting_id}:{user_id}"))
    existing = await MeetingStore.fetch_by_id(copy_id)
    if existing is not None:
        return {"meeting_id": copy_id, "meeting_chat_id": None, "already_saved": True, "summary": existing.get("summary")}

    chat = await MeetingChatStore.create_chat(user_token, user_id)
    job = {
        "id": copy_id, "user_id": user_id, "meeting_chat_id": chat["id"], "status": "completed",
        "duration_seconds": content.get("duration_seconds"), "transcript": None,  # a saved copy is Translation + Summary only
        "translation": content["translation"], "summary": content.get("summary"), "error_message": None,
        "source_type": "live",
    }
    if not await MeetingStore.upsert(job) and not await MeetingStore.upsert({k: v for k, v in job.items() if k != "source_type"}):
        raise ClaimError(502, "Could not save the meeting right now. Please try again.")
    return {"meeting_id": copy_id, "meeting_chat_id": chat["id"], "already_saved": False, "summary": content.get("summary")}
