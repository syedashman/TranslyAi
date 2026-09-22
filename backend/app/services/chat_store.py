import base64
import json
from typing import Any, Optional
from uuid import UUID

import httpx

from app.config import settings


def user_id_from_token(token: str) -> Optional[str]:
    """Reads the user id (the 'sub' claim) from a Supabase access token. Supabase itself verifies the token on every request."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return str(claims["sub"])
    except (IndexError, KeyError, ValueError, TypeError):
        return None


def message_text(message: dict) -> str:
    """The messages table may require non-empty text, so audio-only and assistant rows still get readable text."""
    if message.get("content"):
        return message["content"]
    return (message.get("result") or {}).get("english_translation") or ""


class ChatStoreError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class ChatStore:
    """Talks to Supabase's REST API with the caller's own login token, so row-level security decides access."""

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
            raise ChatStoreError(503, "Chat storage is not configured on the server.")

        headers = {
            "apikey": settings.supabase_anon_key.strip(),
            "Authorization": f"Bearer {token}",
            "Prefer": "return=representation",
        }
        try:
            response = await cls._http().request(method, path, params=params, json=body, headers=headers)
        except httpx.HTTPError as error:
            print(f"SUPABASE REQUEST ERROR: {error!r}")
            raise ChatStoreError(502, "Could not reach the chat database. Please try again.") from error

        if response.status_code < 400:
            return response.json() if response.content else None

        try:
            code = response.json().get("code", "")
        except (ValueError, AttributeError):
            code = ""
        print(f"SUPABASE ERROR {response.status_code} {code}: {response.text[:300]}")

        try:
            reason = response.json().get("message", "")
        except (ValueError, AttributeError):
            reason = ""

        if response.status_code == 401:
            raise ChatStoreError(401, "Your session has expired. Please log in again.")
        if code in ("PGRST204", "42703"):
            raise ChatStoreError(503, f"The chat tables are out of date ({reason}). Run supabase/chats.sql in the Supabase SQL Editor.")
        if code in ("PGRST205", "42P01") or (response.status_code == 404 and "relation" in response.text):
            raise ChatStoreError(503, "Chat tables are missing. Run supabase/chats.sql in the Supabase SQL Editor.")
        if response.status_code == 403:
            raise ChatStoreError(403, f"The database refused this request ({reason or 'row-level security'}). Run supabase/chats.sql in the Supabase SQL Editor to fix the table rules.")
        if response.status_code == 409 and code == "23503":
            raise ChatStoreError(404, "Chat not found.")
        if response.status_code >= 500:
            raise ChatStoreError(502, "The chat database had a problem. Please try again.")
        raise ChatStoreError(400, f"The chat request was not valid ({reason}).")

    @classmethod
    async def list_chats(cls, token: str, archived: str = "false") -> list[dict]:
        """Only this caller's own chats - explicit, not left to RLS alone.

        Row-level security also allows reading chats someone else marked is_shared=true (see supabase/chats.sql),
        so a chat other people shared with the world is only ever opened by its direct link, never mixed into
        anyone else's own chat list here.
        """
        params = {"select": "*", "order": "is_pinned.desc,updated_at.desc"}
        if archived in ("true", "false"):
            params["is_archived"] = f"eq.{archived}"
        if user_id := user_id_from_token(token):
            params["user_id"] = f"eq.{user_id}"
        return await cls._request("GET", "/chats", token, params=params) or []

    @classmethod
    async def get_chat(cls, token: str, chat_id: UUID) -> Optional[dict]:
        rows = await cls._request("GET", "/chats", token, params={"select": "*", "id": f"eq.{chat_id}"})
        return rows[0] if rows else None

    @classmethod
    async def create_chat(cls, token: str, title: Optional[str]) -> dict:
        body: dict = {"title": title or "New chat"}
        if user_id := user_id_from_token(token):
            body["user_id"] = user_id
        rows = await cls._request("POST", "/chats", token, body=body)
        return rows[0]

    @classmethod
    async def update_chat(cls, token: str, chat_id: UUID, fields: dict) -> Optional[dict]:
        rows = await cls._request("PATCH", "/chats", token, params={"id": f"eq.{chat_id}"}, body=fields)
        return rows[0] if rows else None

    @classmethod
    async def delete_chat(cls, token: str, chat_id: UUID) -> bool:
        rows = await cls._request("DELETE", "/chats", token, params={"id": f"eq.{chat_id}"})
        return bool(rows)

    @classmethod
    async def list_messages(cls, token: str, chat_id: UUID) -> list[dict]:
        params = {"select": "id,chat_id,role,content,audio_name,result,created_at", "chat_id": f"eq.{chat_id}", "order": "created_at.asc,seq.asc"}
        return await cls._request("GET", "/messages", token, params=params) or []

    @classmethod
    async def add_messages(cls, token: str, chat_id: UUID, messages: list[dict]) -> list[dict]:
        user_id = user_id_from_token(token)
        rows = [
            {"chat_id": str(chat_id), **({"user_id": user_id} if user_id else {}), **message, "content": message_text(message)}
            for message in messages
        ]
        created = await cls._request("POST", "/messages", token, body=rows) or []
        return sorted(created, key=lambda row: row.get("seq", 0))

    @classmethod
    async def delete_messages(cls, token: str, chat_id: UUID, message_ids: list[UUID]) -> int:
        """Removes the given messages from one chat and returns how many rows were actually deleted."""
        id_list = ",".join(str(message_id) for message_id in message_ids)
        rows = await cls._request(
            "DELETE", "/messages", token, params={"chat_id": f"eq.{chat_id}", "id": f"in.({id_list})"}
        )
        return len(rows or [])
