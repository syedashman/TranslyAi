"""Live Meeting sessions: browser tab audio -> realtime STT -> Roman Urdu -> Gemini translation, broadcast to the
host and any number of read-only viewers.

A session lives on the server independently of any browser WebSocket: sockets only carry audio in (host) and events
out (host + viewers). That is what makes reconnects safe (same session, same segments, no duplicate meeting), makes
"the user closed/reloaded the page" safe (a grace timer finalizes and saves what was captured - no zombie
connection to ElevenLabs, no orphaned tasks), and lets Stop Meeting hand off to the existing status-polling flow.

ONE pipeline per meeting, however many people watch:

  host audio -> LiveSTT (one ElevenLabs Scribe v2 Realtime stream)
             -> finalized segment (stable segment_id, order)
             -> stage 1: existing Romanizer (app.services.romanizer.to_roman_script) on the ACTUAL STT text
             -> stage 2: Gemini translation of that Roman text (existing retry/backoff)
             -> broadcast() to the host and every viewer

Reused unmodified from the existing meeting pipeline: the Romanizer, TranslationService + its retry wrapper, the job
registry and Supabase persistence (so a finished live meeting is an ordinary saved result in the host's Meeting Chat).
Nothing here is imported by Record Meeting or Upload Recording.
"""

import asyncio
import logging
import re
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import httpx
from fastapi import WebSocket

from app.config import settings
from app.services.live_share import mint_claim_token, new_share_token
from app.services.live_stt import LiveSTT, SAMPLE_RATE
from app.services.meeting_jobs import cancel_job, create_job, get_job, mark_committing, update_job
from app.services.meeting_processor import (
    MEETING_GEMINI_RETRY_ATTEMPTS, MEETING_GEMINI_RETRY_DELAY_SECONDS, SUMMARY_TWO_PASS_THRESHOLD_CHARS,
    TRANSLATION_CHUNK_CHARS, _translate_chunk_with_retry,
)
from app.services.meeting_store import MeetingStore
from app.services.romanizer import has_non_latin_letters, to_roman_script
from app.services.summarizer import SummarizerService
from app.services.text_chunking import chunk_text
from app.services.translation import TranslationService

logger = logging.getLogger("ai-translator")

# Upper bound on waiting for the romanize/translate backlog after Stop Meeting; anything still unfinished then is kept
# as its original text instead of being dropped.
DRAIN_TIMEOUT_SECONDS = 10 * 60.0
ROMANIZE_ATTEMPTS = 3
# Back-off between attempts for ONE sentence (progressive: an instant retry is pointless while the provider is throttling
# or overloaded, but the batch pipeline's flat 5 s is too slow for a live sentence). Other sentences are unaffected.
ROMANIZE_RETRY_DELAYS = (0.5, 4.0)
LIVE_TRANSLATE_RETRY_DELAYS = (1.0, 6.0)
# One Gemini call is abandoned (its sentence retried/failed) after this long, so a hung request can't hold a worker.
LIVE_GEMINI_CALL_TIMEOUT_SECONDS = 30.0
# Dedicated threads for live Gemini calls (blocking SDK): never starved by, and never starving, other server work.
_LIVE_POOL = ThreadPoolExecutor(max_workers=48, thread_name_prefix="live-gemini")


async def _hedged_call(fn, *args):
    """Runs a blocking Gemini call in the live pool. If it is slower than settings.live_gemini_hedge_seconds ONE duplicate
    is started and whichever finishes successfully first wins (Gemini latency is bimodal: ~1 s normally, 5-30 s when the
    model is overloaded, so a duplicate usually beats the slow one). Raises if every attempt fails or the time limit passes."""
    loop = asyncio.get_running_loop()
    tasks = [asyncio.ensure_future(loop.run_in_executor(_LIVE_POOL, fn, *args))]
    try:
        hedge = settings.live_gemini_hedge_seconds
        if hedge > 0:
            done, _ = await asyncio.wait(tasks, timeout=hedge)
            if not done:
                tasks.append(asyncio.ensure_future(loop.run_in_executor(_LIVE_POOL, fn, *args)))
        deadline = time.monotonic() + LIVE_GEMINI_CALL_TIMEOUT_SECONDS
        pending = set(tasks)
        last_error: Optional[BaseException] = None
        while pending:
            done, pending = await asyncio.wait(pending, timeout=max(0.01, deadline - time.monotonic()), return_when=asyncio.FIRST_COMPLETED)
            if not done:
                raise asyncio.TimeoutError("Gemini call timed out")
            for task in done:
                if task.exception() is None:
                    return task.result()
                last_error = task.exception()
        raise last_error if last_error else RuntimeError("Gemini call failed")
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
            elif not task.cancelled():
                task.exception()  # mark retrieved: a losing duplicate's error is not an 'unhandled task exception'


def _translate_once(text: str) -> str:
    translated, ok = TranslationService.translate_with_status(text, True)
    if not ok:
        raise RuntimeError(translated)
    return translated


async def _translate_live(text: str) -> str:
    """The same TranslationService call as the batch pipeline, for ONE sentence only (no other context is ever sent), with
    the live retry policy."""
    last_error: Optional[BaseException] = None
    for attempt in range(1, MEETING_GEMINI_RETRY_ATTEMPTS + 1):
        try:
            return await _hedged_call(_translate_once, text)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            last_error = error
            if attempt < MEETING_GEMINI_RETRY_ATTEMPTS:
                await asyncio.sleep(LIVE_TRANSLATE_RETRY_DELAYS[min(attempt - 1, len(LIVE_TRANSLATE_RETRY_DELAYS) - 1)])
    raise RuntimeError(f"Live translation failed after {MEETING_GEMINI_RETRY_ATTEMPTS} attempts: {last_error!r}")
SEND_TIMEOUT_SECONDS = 5.0
# A finished session's share entry is evicted oldest-first beyond this many (memory bound; text only).
MAX_FINISHED_SHARES = 200
SUMMARY_UNAVAILABLE = (
    "A summary could not be generated for this meeting because the summary service was temporarily unavailable. "
    "The full translation has been saved."
)
# A cancelled meeting stays resolvable for viewers this long (so a late click on the share link says "cancelled"
# instead of "unavailable"); its content is dropped immediately.
CANCELLED_SHARE_TTL_SECONDS = 300
PUBLIC_FAILURE_MESSAGE = "This live meeting ended unexpectedly."
UNTRANSLATED_PLACEHOLDER = "[This sentence could not be translated.]"

# Live-specific summary prompt (the shared SummarizerService prompt/cleaner are not touched). Headings are invented
# from the actual meeting, never a fixed template.
LIVE_SUMMARY_INSTRUCTION = (
    "You analyze the English translation of a spoken meeting (one sentence per line) and write a concise, structured "
    "meeting summary. This is analysis, not a retelling: never copy or restate the transcript sentence by sentence and "
    "never write long paragraphs.\n"
    "Group the content into sections that fit THIS meeting. Invent short, specific headings from the actual topics "
    "(for example 'App Launch Schedule'); do not use a fixed template, and do not create a section the meeting gave no "
    "content for.\n"
    "Where the meeting contains them, capture: key topics, decisions, action items and who owns them, deadlines and "
    "dates, problems or risks, requirements, approvals, responsibilities and next steps. Put action items in their own "
    "clearly labelled section.\n"
    "Use only what was actually said. Never invent people, dates, numbers, owners or decisions.\n"
    "OUTPUT FORMAT, exactly: each section is one line starting with '### ' followed by its heading, then one bullet per "
    "line, each starting with '• ' (short; an optional bold lead-in like **Deadline:** is allowed). Leave a blank line "
    "between sections. No introduction, no closing remark, no tables and no other markdown."
)
LIVE_SUMMARY_MERGE_NOTE = (
    "\n\nThe input below is a set of partial summaries of consecutive parts of ONE meeting. Merge them into a single "
    "structured summary in the same format, combining sections that cover the same topic."
)

_SESSIONS: dict[str, "LiveSession"] = {}  # active, by private job id (host access)
_SHARES: dict[str, "LiveSession"] = {}  # by public share token (viewer access) - kept after the meeting ends, until expiry


class LiveSessionBusy(Exception):
    pass


async def verify_supabase_user(token: str) -> Optional[str]:
    """The user id Supabase itself vouches for. Unlike the REST endpoints (where every Supabase call re-verifies the
    token), a WebSocket makes no such call, so the token is checked explicitly once per connection."""
    url = settings.supabase_url.strip().rstrip("/")
    anon = settings.supabase_anon_key.strip()
    if not url.startswith("http") or len(anon) < 20 or not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{url}/auth/v1/user", headers={"apikey": anon, "Authorization": f"Bearer {token}"})
    except httpx.HTTPError as error:
        logger.warning("LIVE AUTH: could not reach Supabase: %r", error)
        return None
    if response.status_code != 200:
        return None
    try:
        return str(response.json().get("id") or "") or None
    except ValueError:
        return None


def get_session(meeting_id: str) -> Optional["LiveSession"]:
    return _SESSIONS.get(meeting_id)


def get_share(share_token: str) -> Optional["LiveSession"]:
    """The session behind a public share token, or None if unknown or its (configurable) viewing window has passed."""
    session = _SHARES.get(share_token)
    if session is None:
        return None
    if session.share_expires_at is not None and time.time() > session.share_expires_at:
        _SHARES.pop(share_token, None)
        return None
    return session


def find_share_by_meeting_id(meeting_id: str) -> Optional["LiveSession"]:
    for session in _SHARES.values():
        if session.job_id == meeting_id:
            return session
    return None


def find_finished_by_meeting_id(meeting_id: str) -> Optional["LiveSession"]:
    for session in _SHARES.values():
        if session.job_id == meeting_id and session.state == "done":
            return session
    return None


def _evict_finished_shares() -> None:
    finished = [s for s in _SHARES.values() if s.share_expires_at is not None]
    for session in finished:
        if time.time() > session.share_expires_at:
            _SHARES.pop(session.share_token, None)
    finished = sorted((s for s in _SHARES.values() if s.share_expires_at is not None), key=lambda s: s.share_expires_at)
    for session in finished[: max(0, len(finished) - MAX_FINISHED_SHARES)]:
        _SHARES.pop(session.share_token, None)


def ensure_can_start(user_id: Optional[str]) -> None:
    """One live meeting per user at a time - also what stops a double-click or a retry from creating duplicates."""
    for session in list(_SESSIONS.values()):
        if session.user_id != user_id:
            continue
        if session.state == "created":
            session.discard("Replaced by a newer live meeting.")  # never connected - safe to drop
        else:
            raise LiveSessionBusy()


def create_session(user_id: Optional[str], meeting_chat_id: str) -> "LiveSession":
    job = create_job(user_id, None, meeting_chat_id=meeting_chat_id)
    update_job(job["id"], status="live", source_type="live")
    session = LiveSession(job["id"], user_id, meeting_chat_id)
    _SESSIONS[session.job_id] = session
    _SHARES[session.share_token] = session
    session.schedule_expiry(settings.live_reconnect_grace_seconds)
    return session


async def _persist_live(job: dict) -> None:
    """Same durable mirror every meeting uses, plus source_type='live'. If the (additive) source_type column hasn't
    been added to the deployed table yet, the write is retried without it so the meeting is never lost over it."""
    if await MeetingStore.upsert(job):
        return
    if MeetingStore.is_configured() and "source_type" in job:
        await MeetingStore.upsert({k: v for k, v in job.items() if k != "source_type"})


# ---------- structured summary (live-only; SummarizerService itself is unchanged) ----------


def clean_structured_summary(text: str) -> str:
    """Keeps '### Heading' lines and '• ' bullets (plus paired **bold** lead-ins); strips every other markdown."""
    if not text:
        return ""
    cleaned = text.replace("\r\n", "\n")
    cleaned = re.sub(r"```[a-zA-Z0-9_+-]*\n?", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]{0,3}#{1,6}[ \t]*", "### ", cleaned)
    # A line that is only a bold phrase ("**Action Items**" / "**Action Items:**") is a heading the model formatted wrongly.
    cleaned = re.sub(r"(?m)^[ \t]*\*\*([^*\n]+?)\*\*[ \t]*:?[ \t]*$", r"### \1", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]*[-*+•‣◦▪][ \t]+", "• ", cleaned)
    cleaned = re.sub(r"(?m)^(### .*?)[ \t]*:[ \t]*$", r"\1", cleaned)
    parts = re.split(r"(\*\*[^*\n]+?\*\*)", cleaned)
    cleaned = "".join(p if p.startswith("**") and p.endswith("**") and len(p) > 4 else p.replace("*", "") for p in parts)
    cleaned = cleaned.replace("`", "").replace("~~", "")
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"[ \t]*\n[ \t]*", "\n", cleaned)
    cleaned = re.sub(r"(?m)^(### .*)\n(?=•)", r"\1\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


async def _summary_call(text: str, instruction: str) -> str:
    """One structured-summary Gemini call with the same retry/backoff the meeting pipeline uses."""
    for attempt in range(1, MEETING_GEMINI_RETRY_ATTEMPTS + 1):
        try:
            raw = await asyncio.to_thread(SummarizerService.generate_with_retry, text, system_instruction=instruction, temperature=0.3)
            cleaned = clean_structured_summary(raw)
            if cleaned:
                return cleaned
        except Exception as error:  # noqa: BLE001
            logger.warning("LIVE SUMMARY RETRY %d/%d: %r", attempt, MEETING_GEMINI_RETRY_ATTEMPTS, error)
        if attempt < MEETING_GEMINI_RETRY_ATTEMPTS:
            await asyncio.sleep(MEETING_GEMINI_RETRY_DELAY_SECONDS)
    raise RuntimeError("Gemini summarization is temporarily unavailable.")


async def summarize_structured(translated_lines: list[str]) -> str:
    """Dynamic, structured meeting analysis from the translated sentences. Long meetings are summarized in parts and
    merged (the same two-pass idea the existing pipeline uses) rather than sent to Gemini as one giant call."""
    text = "\n".join(line for line in translated_lines if line.strip())
    if len(text) <= SUMMARY_TWO_PASS_THRESHOLD_CHARS:
        return await _summary_call(text, LIVE_SUMMARY_INSTRUCTION)
    logger.info("LIVE SUMMARY: %d chars, summarizing in parts", len(text))
    partials = [await _summary_call(chunk, LIVE_SUMMARY_INSTRUCTION) for chunk in chunk_text(text, max_chars=TRANSLATION_CHUNK_CHARS * 4)]
    return await _summary_call("\n\n".join(partials), LIVE_SUMMARY_INSTRUCTION + LIVE_SUMMARY_MERGE_NOTE)


# ---------- the session ----------


class LiveSession:
    def __init__(self, job_id: str, user_id: Optional[str], chat_id: str):
        self.job_id = job_id  # PRIVATE: host-only, never sent to viewers
        self.user_id = user_id
        self.chat_id = chat_id  # PRIVATE: the host's Meeting Chat, never sent to viewers
        self.share_token = new_share_token()  # PUBLIC read-only credential for this one meeting
        self.share_expires_at: Optional[float] = None  # set when the meeting ends
        self.state = "created"  # created -> active -> finalizing -> done
        self.stage = "waiting"  # public: waiting | live | paused | host_disconnected | finalizing | translating | summarizing | completed | failed | cancelled
        self.outcome: Optional[str] = None  # None | completed | failed | cancelled
        # {"segment_id", "original" (raw STT text: INTERNAL ONLY - used to romanize/translate, never sent to any client
        # and never saved), "text" (the Roman Urdu shown as "Speaker"), "romanized", "translation", "failed"}
        self.segments: list[dict] = []
        self.partial = ""
        self.summary: Optional[str] = None
        self.translation_text = ""
        self.transcript_text = ""
        self.claim_token: Optional[str] = None
        self.duration_seconds: Optional[int] = None
        self.ws: Optional[WebSocket] = None  # the HOST's socket (at most one)
        self.viewers: dict[WebSocket, asyncio.Lock] = {}  # read-only viewer sockets
        self.audio_bytes = 0
        self.started_at: Optional[float] = None
        self.paused = False  # host paused: the same session stays alive, audio is simply not accepted
        self._paused_at: Optional[float] = None
        self._paused_total = 0.0
        self._speech_since_final = False  # STT heard speech that has not been finalized yet
        self._host_lock = asyncio.Lock()
        self._stt: Optional[LiveSTT] = None
        self._roman_queue: asyncio.Queue = asyncio.Queue()
        self._emit_index = 0  # segments before this index have been announced to clients, in spoken order
        self._emit_lock = asyncio.Lock()
        self._first_partial_at: Optional[float] = None
        self._last_partial_at: Optional[float] = None
        self._partial_payload: Optional[dict] = None  # newest partial not yet delivered (older ones are superseded)
        self._partial_task: Optional[asyncio.Task] = None
        self._final_seq = 0
        self._queue: asyncio.Queue = asyncio.Queue()  # stage 2 (translation)
        self._deferred: deque[dict] = deque()
        self._inflight = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self._workers: list[asyncio.Task] = []
        self._expiry: Optional[asyncio.Task] = None
        self._limit: Optional[asyncio.Task] = None
        self._final_task: Optional[asyncio.Task] = None
        self._viewer_tasks: set[asyncio.Task] = set()

    # ---------- snapshots (what a newly attached client is told) ----------

    def _segment_views(self) -> list[dict]:
        # Only segments already romanized are "finalized" for display; stage 1 is FIFO so these are always a prefix.
        # "text" is the Roman Urdu Speaker line ("" if romanization failed) - the raw STT text is never included.
        return [
            {"segment_id": s["segment_id"], "text": s["text"], "translation": s["translation"]}
            for s in self.segments if s["romanized"]
        ]

    def _final_public(self) -> dict:
        return {
            # The finished meeting is Translation (sentence by sentence) + Summary only: no speaker/original text at all.
            "segments": [{"segment_id": s["segment_id"], "translation": s["translation"]} for s in self.segments],
            "summary": self.summary, "duration_seconds": self.duration_seconds,
            "claim_token": self.claim_token,
        }

    def snapshot(self, role: str) -> dict:
        event = {
            "type": "ready", "role": role, "state": self.state, "stage": self.stage, "outcome": self.outcome,
            "segments": [] if (role == "viewer" and self.outcome == "completed") else self._segment_views(),
            "partial": "" if self.outcome else self.partial,
            "elapsed_seconds": self._elapsed(), "paused": self.paused,
            "viewer_count": len(self.viewers),
        }
        if role == "viewer" and self.outcome == "completed":
            event["final"] = self._final_public()
        return event

    def _elapsed(self) -> int:
        """Meeting time, not counting paused time."""
        if not self.started_at:
            return 0
        now = time.time()
        paused = self._paused_total + ((now - self._paused_at) if self._paused_at else 0.0)
        return max(0, int(now - self.started_at - paused))

    def saved_content(self) -> dict:
        return {"translation": self.translation_text, "summary": self.summary, "duration_seconds": self.duration_seconds}

    # ---------- delivery ----------

    async def _deliver(self, ws: WebSocket, lock: asyncio.Lock, event: dict) -> bool:
        try:
            async with lock:
                await asyncio.wait_for(ws.send_json(event), timeout=SEND_TIMEOUT_SECONDS)
            return True
        except Exception:  # noqa: BLE001 - client went away or is too slow to keep up
            return False

    async def send(self, event: dict) -> None:
        """Host only."""
        ws = self.ws
        if ws is not None and not await self._deliver(ws, self._host_lock, event):
            if self.ws is ws:
                self.ws = None

    async def broadcast(self, event: dict, *, host: bool = True) -> None:
        """The same event, in the same order, to the host and every viewer. Viewer deliveries run as their own tasks
        (each viewer's lock keeps that viewer's events in order), so a slow or dead viewer can never delay the host
        or the pipeline: it is dropped after one bounded timeout and its queued deliveries become no-ops."""
        for ws, lock in list(self.viewers.items()):
            task = asyncio.create_task(self._deliver_viewer(ws, lock, event))
            self._viewer_tasks.add(task)
            task.add_done_callback(self._viewer_tasks.discard)
        if host:
            await self.send(event)

    async def _deliver_viewer(self, ws: WebSocket, lock: asyncio.Lock, event: dict) -> None:
        if ws not in self.viewers:
            return  # already dropped or left
        if await self._deliver(ws, lock, event):
            return
        if self.viewers.pop(ws, None) is not None:
            await self._announce_viewer_count()

    async def _announce_viewer_count(self) -> None:
        await self.broadcast({"type": "viewer_count", "count": len(self.viewers)})

    async def _set_stage(self, stage: str) -> None:
        self.stage = stage
        await self.broadcast({"type": "status", "stage": stage})

    # ---------- host connection ----------

    async def attach(self, ws: WebSocket) -> None:
        previous = self.ws
        self.ws = ws
        if previous is not None and previous is not ws:
            try:
                await previous.close(code=4000)
            except Exception:  # noqa: BLE001 - already gone
                pass
        self._cancel(self._expiry)
        self._expiry = None
        if self.state == "created":
            self._start()
            await self.broadcast({"type": "status", "stage": "live"}, host=False)  # viewers who joined early
        elif self.state == "active" and self.stage == "host_disconnected":
            await self._set_stage("paused" if self.paused else "live")
        await self.send(self.snapshot("host"))

    async def detach(self, ws: WebSocket) -> None:
        if self.ws is not ws:
            return
        self.ws = None
        if self.state == "active":
            # Reload/network drop: viewers are told, and the session waits for the host to reconnect, then finalizes
            # with what was captured (never a zombie). Viewers disconnecting NEVER reaches here.
            self.schedule_expiry(settings.live_reconnect_grace_seconds)
            await self._set_stage("host_disconnected")

    # ---------- viewer connections (read-only) ----------

    async def attach_viewer(self, ws: WebSocket) -> bool:
        if len(self.viewers) >= settings.live_max_viewers:
            return False
        lock = asyncio.Lock()
        try:
            # Registered and snapshotted while holding this viewer's lock: any event broadcast from here on queues
            # behind the snapshot (so it is never delivered ahead of it) and anything earlier is already inside it.
            async with lock:
                self.viewers[ws] = lock
                await asyncio.wait_for(ws.send_json(self.snapshot("viewer")), timeout=SEND_TIMEOUT_SECONDS)
        except Exception:  # noqa: BLE001 - the viewer vanished during the handshake
            self.viewers.pop(ws, None)
            return True
        await self._announce_viewer_count()
        return True

    async def detach_viewer(self, ws: WebSocket) -> None:
        if self.viewers.pop(ws, None) is not None:
            await self._announce_viewer_count()

    async def send_to_viewer(self, ws: WebSocket, event: dict) -> None:
        lock = self.viewers.get(ws)
        if lock is not None:
            await self._deliver(ws, lock, event)

    def feed_audio(self, data: bytes) -> None:
        if self.state != "active" or self._stt is None or self.paused:
            return  # paused: nothing is accepted, counted or sent to the STT stream
        self.audio_bytes += len(data)
        self._stt.feed(data)

    # ---------- lifecycle ----------

    def _start(self) -> None:
        self.state = "active"
        self.stage = "live"
        self.started_at = time.time()
        self._stt = LiveSTT(self._on_partial, self._on_final, self._on_stt_error)
        self._stt.start()
        workers = max(1, settings.live_pipeline_workers)
        self._workers = [asyncio.create_task(self._romanize_worker(), name=f"live-romanize-{i}") for i in range(workers)]
        self._workers += [asyncio.create_task(self._translate_worker(), name=f"live-translate-{i}") for i in range(workers)]
        if settings.live_meeting_max_duration_seconds > 0:
            self._limit = asyncio.create_task(self._enforce_max_duration())
        update_job(self.job_id, status="live")

    def schedule_expiry(self, seconds: float) -> None:
        self._cancel(self._expiry)
        self._expiry = asyncio.create_task(self._expire_after(seconds))

    async def _expire_after(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
        if self.state == "created":
            self.discard("The live meeting was never started.")
        elif self.state == "active":
            logger.info("LIVE MEETING %s: host did not reconnect - finalizing what was captured", self.job_id)
            await self.stop()

    async def _enforce_max_duration(self) -> None:
        await asyncio.sleep(settings.live_meeting_max_duration_seconds)
        await self.broadcast({"type": "error", "code": "max_duration", "fatal": True,
                              "message": "This live meeting reached the maximum length and was stopped. Everything captured so far is being saved."})
        await self.stop()

    def discard(self, reason: str) -> None:
        self.state = "done"
        self.outcome = "failed"
        self.stage = "failed"
        self._cancel(self._expiry)
        _SESSIONS.pop(self.job_id, None)
        _SHARES.pop(self.share_token, None)
        update_job(self.job_id, status="failed", error_message=reason)
        if self.viewers:
            asyncio.create_task(self.broadcast({"type": "failed", "message": PUBLIC_FAILURE_MESSAGE}, host=False))

    @staticmethod
    def _cancel(task: Optional[asyncio.Task]) -> None:
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()

    # ---------- STT callbacks ----------

    async def _on_partial(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        self._speech_since_final = True
        now = time.monotonic()
        if self._first_partial_at is None:
            self._first_partial_at = now
        self._last_partial_at = now
        if has_non_latin_letters(text):
            # Never show raw Devanagari/Arabic script: the Roman Urdu version is produced when the sentence is
            # finalized (romanizing every interim partial would mean a Gemini call several times a second).
            self.partial = ""
            self._queue_partial({"type": "transcript_partial", "text": "", "pending": True})
            return
        self.partial = text
        self._queue_partial({"type": "transcript_partial", "text": text})

    def _queue_partial(self, payload: dict) -> None:
        """Partials are cosmetic and superseded by the next one, so they are delivered by their own task with only the newest
        kept. A slow host/viewer socket can therefore never hold up the STT receive loop (which also carries the finals)."""
        self._partial_payload = payload
        if self._partial_task is None or self._partial_task.done():
            self._partial_task = asyncio.create_task(self._flush_partials(), name="live-partials")

    async def _flush_partials(self) -> None:
        while self._partial_payload is not None:
            payload, self._partial_payload = self._partial_payload, None
            try:
                await self.broadcast(payload)
            except Exception:  # noqa: BLE001 - cosmetic
                pass

    async def _on_final(self, text: str) -> None:
        if not any(ch.isalnum() for ch in text):
            return  # garbled/empty STT output ("", "...", zero-width characters): nothing to romanize or translate
        self._speech_since_final = False
        now = time.monotonic()
        self._final_seq += 1
        stt = self._stt
        # Timing only - never any text. speech = first partial -> final; vad_wait = last partial -> final (the provider waits
        # for a pause before it finalizes); stt_buf/send_lag = how far behind real time the audio going upstream is.
        timing = {
            "seq": self._final_seq, "final": now,
            "speech": (now - self._first_partial_at) if self._first_partial_at else 0.0,
            "vad_wait": (now - self._last_partial_at) if self._last_partial_at else 0.0,
            "stt_buf": stt.buffered_chunks if stt else 0, "send_lag": stt.send_lag if stt else 0.0,
        }
        self._first_partial_at = self._last_partial_at = None
        segment = {"segment_id": uuid.uuid4().hex, "original": text, "text": "", "romanized": False, "translation": None,
                   "failed": False, "roman_done": False, "announced": False, "t": timing}
        self.segments.append(segment)
        self.partial = ""
        self._partial_payload = None
        # Bounded backlog across BOTH stages: when Gemini is behind, the segment is parked (text only) instead of
        # growing the queues, and is released as earlier segments complete. STT is never blocked either way.
        if self._inflight >= settings.live_translation_queue_size:
            self._deferred.append(segment)
        else:
            self._inflight += 1
            self._roman_queue.put_nowait(segment)
        self._idle.clear()

    async def _on_stt_error(self, message: str, fatal: bool) -> None:
        await self.broadcast({"type": "error", "code": "stt", "fatal": fatal, "message": message})
        if fatal and self.state == "active":
            asyncio.create_task(self.stop())

    # ---------- stage 1: Roman Urdu ----------

    async def _romanize(self, original: str) -> str:
        """The existing Romanizer, applied to the actual STT transcript. Latin text (already Roman, or English) passes
        straight through; a rejected/failed conversion is retried. If it still isn't Roman text the Speaker line is
        left empty - the raw non-Latin transcript is never shown or stored (translation still uses it internally)."""
        if not has_non_latin_letters(original):
            if settings.live_stt_debug:
                logger.info("LIVE DEBUG romanizer: input is already Latin, passed through: %r", original)
            return original
        for attempt in range(1, ROMANIZE_ATTEMPTS + 1):
            try:
                roman = await _hedged_call(to_roman_script, original)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - timed out / provider error: counts as a failed attempt
                logger.warning("LIVE ROMANIZE: attempt %d/%d failed (%s)", attempt, ROMANIZE_ATTEMPTS, error.__class__.__name__)
                roman = original
            if settings.live_stt_debug:
                logger.info("LIVE DEBUG romanizer (attempt %d): input=%r output=%r", attempt, original, roman)
            if not has_non_latin_letters(roman):
                return roman
            logger.warning("LIVE ROMANIZE: attempt %d/%d did not produce Roman text", attempt, ROMANIZE_ATTEMPTS)
            if attempt < ROMANIZE_ATTEMPTS:
                await asyncio.sleep(ROMANIZE_RETRY_DELAYS[min(attempt - 1, len(ROMANIZE_RETRY_DELAYS) - 1)])
        return ""

    async def _romanize_worker(self) -> None:
        # Self-healing: one bad/garbled segment (any error) must never kill this task - a dead worker would leave every
        # later sentence queued forever and stall finalization. The segment just gets an empty Speaker line.
        # Several of these run at once (settings.live_pipeline_workers): each finalized sentence is romanized on its own,
        # immediately, and its translation starts the moment its Roman text exists - independent of earlier sentences.
        while True:
            segment = await self._roman_queue.get()
            segment["t"]["roman_start"] = time.monotonic()
            try:
                segment["text"] = await self._romanize(segment["original"])
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                logger.warning("LIVE ROMANIZE FAILED (meeting %s, segment %s): %r", self.job_id, segment["segment_id"], error)
                segment["text"] = ""
            segment["t"]["roman_end"] = time.monotonic()
            segment["roman_done"] = True
            self._queue.put_nowait(segment)
            await self._emit_ready()

    async def _emit_ready(self) -> None:
        """Announces sentences to the host and viewers strictly in SPOKEN order, however the concurrent workers finish: the
        next sentence is only released once every earlier one has been. A translation that finished early is sent right
        after its own sentence appears (the clients ignore a translation for a sentence they have not been shown yet)."""
        async with self._emit_lock:
            while self._emit_index < len(self.segments):
                segment = self.segments[self._emit_index]
                if not segment["roman_done"]:
                    break
                self._emit_index += 1
                segment["romanized"] = True
                segment["t"]["emitted"] = time.monotonic()
                try:
                    await self.broadcast({"type": "transcript_final", "segment_id": segment["segment_id"], "text": segment["text"]})
                except Exception:  # noqa: BLE001 - delivery problems never stop the pipeline
                    pass
                segment["announced"] = True
                await self._announce_translation(segment)
        self._maybe_idle()

    async def _announce_translation(self, segment: dict) -> None:
        if segment["translation"] is not None:
            segment["t"]["shown"] = time.monotonic()
            self._log_timing(segment)
            await self.broadcast({"type": "translation", "segment_id": segment["segment_id"], "text": segment["translation"]})
        elif segment["failed"]:
            await self.broadcast({"type": "translation_error", "segment_id": segment["segment_id"],
                                  "message": "This sentence could not be translated right now."})

    def _log_timing(self, segment: dict) -> None:
        if not settings.live_timing_log:
            return
        t = segment["t"]
        first = t["final"]
        logger.info(
            "LIVE TIMING segment=%d id=%s speech=%.1fs vad_wait=%.1fs | roman_queue=%.1fs romanizer=%.1fs translate_queue=%.1fs "
            "translation=%.1fs emit_wait=%.1fs | after_final: text=%.1fs translation=%.1fs | inflight=%d stt_buf=%d send_lag=%.2fs",
            t["seq"], segment["segment_id"][:8], t["speech"], t["vad_wait"],
            t.get("roman_start", first) - first, t.get("roman_end", first) - t.get("roman_start", first),
            t.get("tr_start", first) - t.get("roman_end", first), t.get("tr_end", first) - t.get("tr_start", first),
            max(0.0, t.get("shown", first) - t.get("tr_end", first)),
            t.get("emitted", first) - first, t.get("shown", first) - first, self._inflight, t["stt_buf"], t["send_lag"],
        )

    def _maybe_idle(self) -> None:
        if self._inflight == 0 and not self._deferred and self._emit_index >= len(self.segments):
            self._idle.set()

    # ---------- stage 2: English translation ----------

    async def _translate_segment(self, segment: dict) -> None:
        segment["t"]["tr_start"] = time.monotonic()
        try:
            text = await _translate_live(segment["text"] or segment["original"])
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - one bad segment must not stop the meeting
            segment["failed"] = True
            segment["t"]["tr_end"] = time.monotonic()
            logger.warning("LIVE TRANSLATE FAILED (meeting %s, segment %s): %r", self.job_id, segment["segment_id"], error)
            if segment["announced"]:
                await self._announce_translation(segment)
            return
        segment["translation"] = text
        segment["t"]["tr_end"] = time.monotonic()
        if segment["announced"]:  # otherwise _emit_ready sends it right after the sentence itself, in order
            await self._announce_translation(segment)

    async def _translate_worker(self) -> None:
        while True:
            segment = await self._queue.get()
            try:
                await self._translate_segment(segment)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - see _romanize_worker: this task must never die
                segment["failed"] = True
                logger.warning("LIVE TRANSLATE WORKER ERROR (meeting %s): %r", self.job_id, error)
            self._inflight -= 1
            while self._deferred and self._inflight < settings.live_translation_queue_size:
                self._inflight += 1
                self._roman_queue.put_nowait(self._deferred.popleft())
            self._maybe_idle()

    # ---------- pause / resume (same session, same STT stream, same pipeline) ----------

    async def pause(self) -> None:
        """Host paused: audio stops being accepted, but the meeting stays active - nothing is finalized, saved or reset,
        viewers stay connected and are told. A half-spoken sentence is committed so it is not left dangling."""
        if self.state != "active" or self.paused:
            return
        self.paused = True
        self._paused_at = time.time()
        if self._stt is not None and self._speech_since_final:
            self._stt.commit()
        self.partial = ""
        self._partial_payload = None
        await self.broadcast({"type": "transcript_partial", "text": ""})
        await self._set_stage("paused")

    async def resume(self) -> None:
        if self.state != "active" or not self.paused:
            return
        self.paused = False
        if self._paused_at is not None:
            self._paused_total += time.time() - self._paused_at
        self._paused_at = None
        await self._set_stage("live")

    # ---------- cancel (DISCARD) ----------

    async def cancel(self) -> str:
        """Cancel = discard, never finalize. Works in every state (never connected, live, finalizing). Returns
        "cancelled", "already_cancelled" or "too_late" (the result is already saved / being saved right now, so
        cancelling would race the write - that meeting is kept exactly as it is). Nothing is saved, nothing is
        appended to the Meeting Chat, no summary is generated, and no task or upstream connection is left running."""
        if self.state == "done":
            return "already_cancelled" if self.outcome == "cancelled" else "too_late"
        if cancel_job(self.job_id) == "too_late":
            return "too_late"
        job_id = self.job_id
        self.outcome, self.stage, self.state = "cancelled", "cancelled", "done"
        _SESSIONS.pop(job_id, None)
        self._cancel(self._expiry)
        self._cancel(self._limit)
        for worker in self._workers:
            worker.cancel()
        if self._final_task is not None and not self._final_task.done():
            self._final_task.cancel()  # a finalization in flight stops; its late result can never be saved
        # Drop everything the meeting captured: memory freed now, and a late viewer can't read a discarded meeting.
        self.segments.clear()
        self._deferred.clear()
        self.partial = ""
        self.summary = None
        self.translation_text = ""
        self.transcript_text = ""
        self.claim_token = None
        while not self._roman_queue.empty():
            self._roman_queue.get_nowait()
        while not self._queue.empty():
            self._queue.get_nowait()
        self._idle.set()
        self.share_expires_at = time.time() + CANCELLED_SHARE_TTL_SECONDS
        if self._stt is not None:
            await self._stt.close()  # no final commit: the half-spoken sentence is discarded, not flushed
        await self.broadcast({"type": "cancelled"})  # the host and every viewer are told; viewers stay read-only
        ws, self.ws = self.ws, None
        if ws is not None:
            try:
                await ws.close(code=1000)
            except Exception:  # noqa: BLE001 - already gone
                pass
        _evict_finished_shares()
        return "cancelled"

    # ---------- stop / finalize ----------

    async def stop(self) -> None:
        """Idempotent. Finalization runs as its own task, so a dropped browser connection can't cancel it."""
        if self._final_task is None:
            self._final_task = asyncio.create_task(self._finalize(), name="live-finalize")

    async def _finalize(self) -> None:
        self.state = "finalizing"
        self.paused = False  # Stop while paused finalizes normally
        self._cancel(self._expiry)
        self._cancel(self._limit)
        job_id = self.job_id
        try:
            await self.broadcast({"type": "stopping"})
            await self._set_stage("finalizing")
            update_job(job_id, status="transcribing")
            if self._stt is not None:
                await self._stt.finish()  # flushes the half-finished sentence; it arrives through _on_final as usual

            await self._set_stage("translating")
            update_job(job_id, status="translating")
            drained = True
            try:
                await asyncio.wait_for(self._idle.wait(), timeout=DRAIN_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                drained = False
                logger.warning("LIVE MEETING %s: romanize/translate backlog not drained in time", job_id)
            for worker in self._workers:
                worker.cancel()

            if not any(s["original"].strip() for s in self.segments):
                raise RuntimeError("No speech was detected in the meeting audio.")

            translation, transcript = await self._assemble(retry_missing=drained)
            self.translation_text, self.transcript_text = translation, transcript
            update_job(job_id, transcript=transcript, translation=translation, status="summarizing")
            await self._set_stage("summarizing")
            try:
                summary = await summarize_structured([s["translation"] for s in self.segments])
            except Exception as error:  # noqa: BLE001 - keep the meeting even if only the summary is unavailable
                logger.warning("LIVE MEETING %s: summary failed: %r", job_id, error)
                summary = SUMMARY_UNAVAILABLE
            self.summary = summary
            self.duration_seconds = int(self.audio_bytes / (SAMPLE_RATE * 2))
            update_job(job_id, summary=summary, duration_seconds=self.duration_seconds)

            final_job = get_job(job_id)
            if final_job is None:
                return
            final_job["status"] = "completed"
            if self.outcome == "cancelled":
                return
            mark_committing(job_id)  # from here on a cancel is too late (it would race the save)
            # Persist BEFORE flipping the in-memory status, same ordering (and reason) as process_meeting().
            await _persist_live(final_job)
            update_job(job_id, status="completed")

            self.claim_token = mint_claim_token(job_id)
            self.outcome = "completed"
            self.state = "done"
            self.share_expires_at = time.time() + settings.live_share_ttl_seconds
            await self._set_stage("completed")
            # The host keeps the existing completed event (it then reads its saved result through the normal status
            # endpoint); viewers get the public final result and NEVER the host's private ids.
            await self.send({"type": "completed", "meeting_id": job_id, "meeting_chat_id": self.chat_id})
            await self.broadcast({"type": "completed", "final": self._final_public()}, host=False)
        except Exception as error:  # noqa: BLE001
            logger.error("LIVE MEETING FAILED (job %s): %r", job_id, error)
            message = str(error) if isinstance(error, RuntimeError) else "The live meeting could not be saved."
            job = update_job(job_id, status="failed", error_message=message)
            if job:
                await _persist_live(job)
            self.outcome, self.stage = "failed", "failed"
            self.share_expires_at = time.time() + min(settings.live_share_ttl_seconds, 3600)
            await self.send({"type": "failed", "message": message})
            await self.broadcast({"type": "failed", "message": PUBLIC_FAILURE_MESSAGE}, host=False)
        finally:
            self.state = "done"
            _SESSIONS.pop(job_id, None)
            _evict_finished_shares()
            for worker in self._workers:
                worker.cancel()
            if self._stt is not None:
                await self._stt.close()
            ws, self.ws = self.ws, None
            if ws is not None:
                try:
                    await ws.close(code=1000)
                except Exception:  # noqa: BLE001
                    pass
            # Viewers stay connected to see the final result; they close themselves (or idle out).

    async def _assemble(self, retry_missing: bool) -> tuple[str, str]:
        """(translation, transcript). One paragraph per segment, in the original order - the sentence-by-sentence
        structure shown live is exactly what is saved. A segment whose translation failed live gets one more full
        retry here; if that also fails a placeholder keeps its slot - a finalized segment is never dropped or reordered."""
        for segment in self.segments:
            segment["romanized"] = True  # anything still pending (drain timeout) simply has no Speaker line
            if segment["translation"] is not None:
                continue
            if retry_missing:
                try:
                    segment["translation"] = await _translate_chunk_with_retry(segment["text"] or segment["original"], 0, 1)
                    continue
                except Exception:  # noqa: BLE001
                    pass
            segment["translation"] = UNTRANSLATED_PLACEHOLDER
        # The saved "transcript" is the Roman Urdu Speaker text (private column, never returned by any API) - never the raw STT text.
        return "\n\n".join(s["translation"] for s in self.segments), "\n".join(s["text"] for s in self.segments if s["text"])
