"""Best-effort durable mirror of meeting jobs into Supabase.

meeting_jobs.py (in-memory) is the source of truth the API actually serves from - it works immediately, needs no
extra secret, and has no token-expiry risk for a 30-100 minute job. This module additionally writes the same data
into a `meetings` table (see supabase/meetings.sql) whenever SUPABASE_SERVICE_ROLE_KEY is configured, so results
also survive a server restart and are visible outside the single process's memory. Every call here is wrapped by
its caller in a try/except that only logs on failure - a Supabase hiccup must never fail or slow the actual
meeting pipeline.

The service-role key (not the caller's own access token) is required specifically because a background job can
outlive a normal Supabase access token's ~1 hour lifetime; the frontend never sends a refresh token to this
backend, so there is no way to keep the caller's own credentials valid for the job's full duration. This key is
never sent to or exposed in the frontend.
"""

from typing import Any, Optional

import httpx

from app.config import settings


class MeetingStore:
    _client: Optional[httpx.AsyncClient] = None

    @classmethod
    def is_configured(cls) -> bool:
        url = settings.supabase_url.strip()
        key = settings.supabase_service_role_key.strip()
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
    async def _request(cls, method: str, path: str, *, params: Optional[dict] = None, body: Any = None) -> Any:
        if not cls.is_configured():
            return None
        key = settings.supabase_service_role_key.strip()
        # resolution=merge-duplicates makes the upsert's "on_conflict=id" actually update the existing row
        # instead of erroring on the duplicate primary key.
        headers = {
            "apikey": key, "Authorization": f"Bearer {key}",
            "Prefer": "return=representation,resolution=merge-duplicates",
        }
        response = await cls._http().request(method, path, params=params, json=body, headers=headers)
        if response.status_code >= 400:
            print(f"MEETING STORE ERROR {response.status_code}: {response.text[:300]}")
            return None
        return response.json() if response.content else None

    @classmethod
    async def upsert(cls, job: dict) -> None:
        """Mirrors one job's current state. Silent no-op if the service role key isn't configured or the write
        fails - callers must never let this raise, since it would abort the actual meeting pipeline over what is
        only a durability nice-to-have."""
        try:
            body = {
                "id": job["id"],
                "user_id": job.get("user_id"),
                "status": job.get("status"),
                "duration_seconds": job.get("duration_seconds"),
                "transcript": job.get("transcript"),
                "translation": job.get("translation"),
                "summary": job.get("summary"),
                "error_message": job.get("error_message"),
            }
            await cls._request("POST", "/meetings", params={"on_conflict": "id"}, body=body)
        except Exception as error:
            print(f"MEETING STORE UPSERT FAILED (non-fatal): {error!r}")
