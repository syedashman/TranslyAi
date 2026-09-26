"""Supabase-backed store for Meeting Chats (the parent/container a "Start Meeting" recording is saved into - see
supabase/meeting_chats.sql) and for listing the completed meeting RESULTS inside one.

Mirrors app.services.chat_store.ChatStore's pattern exactly: the caller's own access token (+ anon key), so
row-level security decides access, with an explicit user_id filter added too as defense-in-depth. This is
deliberately NOT the service-role-credentialed pattern meeting_store.py uses for the background job's writes -
every method here is a short, foreground, interactive request (create a chat, list them, rename one, delete one),
with none of the token-expiry risk a 30-100 minute background job has.
"""

from typing import Any, Optional
from uuid import UUID

import httpx

from app.config import settings
from app.services.chat_store import user_id_from_token


class MeetingChatStoreError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class MeetingChatStore:
    _client: Optional[httpx.AsyncClient] = None

    @classmethod
    def is_configured(cls) -> bool:
        url = settings.supabase_url.strip()
        key = settings.supabase_anon_key.strip()
        return url.startswith("http") and len(key) > 20 and "your" not in f"{url}{key}".lower()

    @classmethod
    def _http(cls) -> httpx.AsyncClient:
        if cls._client is None:
            cls._client = httpx.AsyncClient(
                base_url=f"{settings.supabase_url.strip().rstrip('/')}/rest/v1",
                timeout=httpx.Timeout(15.0),
            )
        return cls._client

    @classmethod
    async def close(cls) -> None:
        if cls._client is not None:
            await cls._client.aclose()
            cls._client = None

    @classmethod
    async def _request(cls, method: str, path: str, token: str, *, params: Optional[dict] = None, body: Any = None) -> Any:
        if not cls.is_configured():
            raise MeetingChatStoreError(503, "Meeting chats are not configured on the server.")

        headers = {
            "apikey": settings.supabase_anon_key.strip(),
            "Authorization": f"Bearer {token}",
            "Prefer": "return=representation",
        }
        try:
            response = await cls._http().request(method, path, params=params, json=body, headers=headers)
        except httpx.HTTPError as error:
            print(f"MEETING CHAT STORE REQUEST ERROR: {error!r}")
            raise MeetingChatStoreError(502, "Could not reach the meeting database. Please try again.") from error

        if response.status_code < 400:
            return response.json() if response.content else None

        try:
            code = response.json().get("code", "")
        except (ValueError, AttributeError):
            code = ""
        print(f"MEETING CHAT STORE ERROR {response.status_code} {code}: {response.text[:300]}")

        try:
            reason = response.json().get("message", "")
        except (ValueError, AttributeError):
            reason = ""

        if response.status_code == 401:
            raise MeetingChatStoreError(401, "Your session has expired. Please log in again.")
        if code in ("PGRST204", "42703"):
            raise MeetingChatStoreError(503, f"The meeting chat tables are out of date ({reason}). Run supabase/meeting_chats.sql in the Supabase SQL Editor.")
        if code in ("PGRST205", "42P01") or (response.status_code == 404 and "relation" in response.text):
            raise MeetingChatStoreError(503, "Meeting chat tables are missing. Run supabase/meeting_chats.sql in the Supabase SQL Editor.")
        if response.status_code == 403:
            raise MeetingChatStoreError(403, f"The database refused this request ({reason or 'row-level security'}). Run supabase/meeting_chats.sql in the Supabase SQL Editor to fix the table rules.")
        if response.status_code == 409 and code == "23503":
            raise MeetingChatStoreError(404, "Meeting chat not found.")
        if response.status_code >= 500:
            raise MeetingChatStoreError(502, "The meeting database had a problem. Please try again.")
        raise MeetingChatStoreError(400, f"The meeting chat request was not valid ({reason}).")

    @classmethod
    async def list_chats(cls, token: str, user_id: Optional[str], archived: str = "false") -> list[dict]:
        params = {"select": "*", "order": "is_pinned.desc,updated_at.desc"}
        if archived in ("true", "false"):
            params["is_archived"] = f"eq.{archived}"
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        return await cls._request("GET", "/meeting_chats", token, params=params) or []

    @classmethod
    async def get_chat(cls, token: str, chat_id: UUID | str) -> Optional[dict]:
        """The caller's OWN Meeting Chat. Row-level security also lets anyone READ a chat its owner shared (that is what a share
        link needs), so ownership is filtered explicitly here: every route that adds to or changes a chat goes through this
        method, and someone else's shared chat must look exactly like a chat that does not exist. (The public read-only view
        uses get_shared_chat instead.)"""
        params = {"select": "*", "id": f"eq.{chat_id}"}
        owner = user_id_from_token(token)
        if owner:
            params["user_id"] = f"eq.{owner}"
        rows = await cls._request("GET", "/meeting_chats", token, params=params)
        return rows[0] if rows else None

    @classmethod
    async def create_chat(cls, token: str, user_id: Optional[str]) -> dict:
        body: dict = {"title": "New meeting"}
        if user_id:
            body["user_id"] = user_id
        rows = await cls._request("POST", "/meeting_chats", token, body=body)
        return rows[0]

    @classmethod
    async def update_chat(cls, token: str, chat_id: UUID | str, fields: dict) -> Optional[dict]:
        rows = await cls._request("PATCH", "/meeting_chats", token, params={"id": f"eq.{chat_id}"}, body=fields)
        return rows[0] if rows else None

    @classmethod
    async def delete_chat(cls, token: str, chat_id: UUID | str) -> bool:
        """Deletes the Meeting Chat row only - every meeting result inside it goes with it via the
        "on delete cascade" foreign key on meetings.meeting_chat_id (see supabase/meeting_chats.sql), not any
        extra query here."""
        rows = await cls._request("DELETE", "/meeting_chats", token, params={"id": f"eq.{chat_id}"})
        return bool(rows)

    @classmethod
    async def get_shared_chat(cls, chat_id: UUID | str) -> Optional[dict]:
        """Public, login-free read of ONE Meeting Chat - only when its owner flagged it is_shared = true. Same pattern as
        ChatStore.get_shared_chat: the project's anon key is the credential (what an unauthenticated browser would send);
        the is_shared filter is explicit and redundant with the RLS policy on purpose. Owner ids are never selected."""
        rows = await cls._request(
            "GET", "/meeting_chats", settings.supabase_anon_key.strip(),
            params={"select": "id,title,is_pinned,is_archived,is_shared,created_at,updated_at", "id": f"eq.{chat_id}", "is_shared": "eq.true"},
        )
        return rows[0] if rows else None

    @classmethod
    async def list_shared_results(cls, chat_id: UUID | str) -> list[dict]:
        """Results of a chat already confirmed shared, via the get_shared_meeting_results SQL function (public fields only)."""
        return await cls._request(
            "POST", "/rpc/get_shared_meeting_results", settings.supabase_anon_key.strip(), body={"p_chat_id": str(chat_id)},
        ) or []

    @classmethod
    async def list_results(cls, token: str, user_id: Optional[str], chat_id: UUID | str) -> list[dict]:
        """Completed meeting results inside one Meeting Chat, oldest first - the conversation-like timeline
        MeetingChat.jsx renders. Same completed-only, no-transcript shape as MeetingStore.get_for_user; reads the
        `meetings` table directly (its own row-level security already limits this to the caller's own rows)."""
        params = {
            "select": "id,status,duration_seconds,translation,summary,created_at",
            "meeting_chat_id": f"eq.{chat_id}", "status": "eq.completed", "order": "created_at.asc",
        }
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        return await cls._request("GET", "/meetings", token, params=params) or []
