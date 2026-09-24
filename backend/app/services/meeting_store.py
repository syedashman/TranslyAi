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


class MeetingStoreError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


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
    async def upsert(cls, job: dict) -> bool:
        """Mirrors one job's current state - full transcript included, so the database keeps the complete
        original record even though it is never sent back to the frontend (see schemas.py). Never raises -
        callers must not have the actual meeting pipeline aborted over what is only a durability nice-to-have.

        Returns True only if the row was actually written. False covers two different, clearly logged cases:
        SUPABASE_SERVICE_ROLE_KEY isn't configured at all (expected/silent - the live in-memory result still
        works), or the write was attempted and failed (a real problem - logged loudly so it's visible in Render
        logs instead of looking identical to "not configured").
        """
        job_id = job.get("id")
        if not cls.is_configured():
            print(f"MEETING STORE UPSERT SKIPPED (no SUPABASE_SERVICE_ROLE_KEY configured): id={job_id}")
            return False
        try:
            body = {
                "id": job_id,
                "user_id": job.get("user_id"),
                "meeting_chat_id": job.get("meeting_chat_id"),
                "status": job.get("status"),
                "duration_seconds": job.get("duration_seconds"),
                "transcript": job.get("transcript"),
                "translation": job.get("translation"),
                "summary": job.get("summary"),
                "error_message": job.get("error_message"),
            }
            result = await cls._request("POST", "/meetings", params={"on_conflict": "id"}, body=body)
        except Exception as error:
            print(f"MEETING STORE UPSERT FAILED (non-fatal, exception): id={job_id} error={error!r}")
            return False
        if result is None:
            # _request already printed "MEETING STORE ERROR <status>: ..." above with the actual Supabase reason.
            print(f"MEETING STORE UPSERT FAILED (non-fatal, see MEETING STORE ERROR above): id={job_id}")
            return False
        print(f"MEETING STORE UPSERT OK: id={job_id} status={job.get('status')}")
        return True

    # ---------- reads: the caller's OWN token, never the service-role key ----------
    # A read is always a short-lived request (no token-expiry risk like the background job's writes have), so
    # these go through the normal Supabase REST path with the user's access token - row-level security in
    # supabase/meetings.sql (not this code) is what actually guarantees a user only ever sees their own rows.
    # An explicit user_id filter is added too, the same defensive-not-RLS-alone pattern ChatStore.list_chats uses.

    @classmethod
    async def _request_as_user(cls, method: str, path: str, token: str, *, params: Optional[dict] = None) -> Any:
        anon_key = settings.supabase_anon_key.strip()
        if not settings.supabase_url.strip().startswith("http") or len(anon_key) < 20:
            raise MeetingStoreError(503, "Meeting history is not configured on the server.")

        headers = {"apikey": anon_key, "Authorization": f"Bearer {token}"}
        try:
            response = await cls._http().request(method, path, params=params, headers=headers)
        except httpx.HTTPError as error:
            print(f"MEETING STORE READ ERROR: {error!r}")
            raise MeetingStoreError(502, "Could not reach the meeting database. Please try again.") from error

        if response.status_code < 400:
            return response.json() if response.content else None

        print(f"MEETING STORE READ ERROR {response.status_code}: {response.text[:300]}")
        if response.status_code == 401:
            raise MeetingStoreError(401, "Your session has expired. Please log in again.")
        if response.status_code == 404 or "PGRST205" in response.text or "does not exist" in response.text.lower():
            raise MeetingStoreError(503, "Meeting history isn't set up yet. Run supabase/meetings.sql in the Supabase SQL Editor.")
        raise MeetingStoreError(502, "The meeting database had a problem. Please try again.")

    @classmethod
    async def list_for_user(cls, token: str, user_id: Optional[str]) -> list[dict]:
        """Completed meetings only, newest first - a failed or still-processing job is never listed as history
        (see supabase/meetings.sql's status values). Soft-fails to an empty list (logged) rather than erroring the
        whole sidebar - e.g. before supabase/meetings.sql has ever been run, "no history yet" and "not set up
        yet" look the same to the user and neither should break the page.

        Deliberately does not select updated_at: nothing reads it (the list only ever shows created_at), and
        selecting a column some already-deployed tables don't have would 42703 the whole query for no benefit.
        """
        params = {
            "select": "id,status,duration_seconds,summary,created_at",
            "status": "eq.completed", "order": "created_at.desc",
        }
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        try:
            return await cls._request_as_user("GET", "/meetings", token, params=params) or []
        except MeetingStoreError as error:
            print(f"MEETING LIST SOFT-FAILED (showing empty history instead): {error.message}")
            return []

    @classmethod
    async def get_for_user(cls, token: str, user_id: Optional[str], meeting_id: str) -> Optional[dict]:
        """One completed meeting's full translation/summary (still never transcript - see schemas.MeetingDetail).
        Only ever returns a status='completed' row: a failed/in-progress job's id can't be opened as if it were a
        finished result, even if someone guesses or reuses an id from elsewhere.

        Deliberately does not select updated_at - see list_for_user above."""
        params = {
            "select": "id,status,duration_seconds,translation,summary,created_at",
            "id": f"eq.{meeting_id}", "status": "eq.completed",
        }
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        rows = await cls._request_as_user("GET", "/meetings", token, params=params)
        return rows[0] if rows else None
