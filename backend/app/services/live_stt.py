"""Realtime speech-to-text for Live Meeting: ElevenLabs Scribe v2 Realtime over its native WebSocket API.

Entirely separate from stt.py's STTService (batch: Record Meeting, Upload Recording, short voice), which is not
touched and keeps its own ElevenLabs -> Groq Whisper fallback. There is deliberately NO fallback here: a live
stream can't be replayed into a batch provider mid-meeting, so a realtime failure is reported and the session stops.

Protocol (https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime):
  wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&...
  auth: `xi-api-key` header (server-side only - the key never reaches the browser)
  client -> {"message_type": "input_audio_chunk", "audio_base_64": ..., "sample_rate": 16000, "commit": bool}
  server -> session_started | partial_transcript | committed_transcript | <error message types>
Audio is PCM 16-bit little-endian, mono, 16 kHz - produced by the browser (see frontend/src/lib/liveMeetingCapture.js).
"""

import asyncio
import base64
import json
import logging
from collections import deque
from typing import Awaitable, Callable, Optional
from urllib.parse import urlencode

import websockets

from app.config import settings

logger = logging.getLogger("ai-translator")

REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
REALTIME_MODEL = "scribe_v2_realtime"
SAMPLE_RATE = 16000
# A sentence/phrase is committed after this much silence (server-side VAD).
VAD_SILENCE_SECONDS = 1.0
# Bounds audio buffered in RAM while the upstream connection is (re)connecting or slower than realtime: 400 chunks
# of ~250 ms is ~100 s of audio (~3 MB). Beyond that the OLDEST audio is dropped - a live stream favours staying
# current over unbounded memory growth.
MAX_BUFFERED_CHUNKS = 400
MAX_RECONNECT_ATTEMPTS = 5
# Error message types that retrying can never fix.
FATAL_ERRORS = {"auth_error", "quota_exceeded", "invalid_api_key", "unauthorized"}

TextCallback = Callable[[str], Awaitable[None]]
ErrorCallback = Callable[[str, bool], Awaitable[None]]


def is_configured() -> bool:
    return bool(_api_key())


def _api_key() -> str:
    return settings.elevenlabs_api_key.strip()


def _build_url() -> str:
    # language_code is an explicit, configurable hint (settings.live_stt_language_code, default "ur"). Left empty,
    # Scribe auto-detects and can pick a wrong language for short accented Urdu/Hindi/English speech (see config.py).
    params: list[tuple[str, str]] = [
        ("model_id", REALTIME_MODEL),
        ("audio_format", f"pcm_{SAMPLE_RATE}"),
        ("commit_strategy", "vad"),
        ("vad_silence_threshold_secs", str(VAD_SILENCE_SECONDS)),
    ]
    language = settings.live_stt_language_code.strip()
    if language:
        params.append(("language_code", language))
    if settings.live_stt_debug:
        # Ask Scribe to also report the language it decided on (a second, metadata message per sentence).
        params += [("include_timestamps", "true"), ("include_language_detection", "true")]
    params += [("keyterms", term) for term in settings.elevenlabs_keyterm_list()]
    return f"{REALTIME_URL}?{urlencode(params)}"


class LiveSTT:
    """One realtime transcription stream. feed() is non-blocking; transcripts arrive via the callbacks."""

    def __init__(self, on_partial: TextCallback, on_final: TextCallback, on_error: ErrorCallback):
        self._on_partial = on_partial
        self._on_final = on_final
        self._on_error = on_error
        self._buffer: deque[bytes] = deque()
        self._wake = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._closing = False
        self._commit_requested = False  # finish() asked for a final commit; the sender clears it once sent
        self._commit_sent = False  # the final commit is on the wire: the next committed_transcript answers it
        self._ack_wanted = False  # only finish()'s commit is waited for; a pause's commit is fire-and-forget
        self._commit_acked = asyncio.Event()
        self._ws = None

    # ---------- public API ----------

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="live-stt")

    def feed(self, pcm: bytes) -> None:
        if self._closing or not pcm:
            return
        self._buffer.append(pcm)
        while len(self._buffer) > MAX_BUFFERED_CHUNKS:
            self._buffer.popleft()
        self._wake.set()

    def commit(self) -> None:
        """Asks the provider to finalize the sentence it is holding (used when the host pauses) without waiting for an
        answer: the resulting committed_transcript arrives through on_final like any other."""
        if self._closing:
            return
        self._commit_requested = True
        self._wake.set()

    async def finish(self, timeout: float = 8.0) -> None:
        """Flush what is still buffered, force the provider to commit any half-finished sentence, wait (bounded)
        for that last committed transcript, then close. Everything final arrives through on_final as usual."""
        if self._task is None or self._task.done():
            return
        self._commit_acked.clear()
        self._ack_wanted = True
        self._commit_requested = True
        self._wake.set()
        try:
            await asyncio.wait_for(self._commit_acked.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("LIVE STT: no final commit acknowledgement within %.0fs; closing anyway", timeout)
        await self.close()

    async def close(self) -> None:
        self._closing = True
        self._buffer.clear()
        self._wake.set()
        ws = self._ws
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001 - already closing
                pass
        task = self._task
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=3.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                task.cancel()

    # ---------- internals ----------

    async def _run(self) -> None:
        attempts = 0
        while not self._closing:
            try:
                connected = await self._session()
                if connected:
                    attempts = 0  # a session that actually started resets the retry budget (long meetings)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - message only; never the request/headers (API key)
                if not self._closing:  # a close we asked for is not an error
                    logger.warning("LIVE STT connection error: %s: %s", error.__class__.__name__, error)
            if self._closing:
                return
            attempts += 1
            if attempts > MAX_RECONNECT_ATTEMPTS:
                await self._on_error("The live transcription service disconnected and could not be restored.", True)
                return
            await asyncio.sleep(min(2 ** attempts, 15))

    async def _session(self) -> bool:
        """One upstream connection. Returns True if the provider acknowledged the session (session_started)."""
        started = False
        headers = {"xi-api-key": _api_key()}
        logger.info("LIVE STT: connecting (language_code=%s)", settings.live_stt_language_code.strip() or "auto-detect")
        async with websockets.connect(
            _build_url(), additional_headers=headers, max_size=2**22, ping_interval=20, ping_timeout=30,
        ) as ws:
            self._ws = ws
            sender = asyncio.create_task(self._send_loop(ws))
            try:
                async for raw in ws:
                    message = json.loads(raw)
                    kind = message.get("message_type", "")
                    if kind == "session_started":
                        started = True
                    elif kind == "partial_transcript":
                        await self._on_partial(message.get("text", "") or "")
                    elif kind == "committed_transcript":
                        text = (message.get("text", "") or "").strip()
                        if text:
                            await self._on_final(text)
                        if self._commit_sent:
                            self._commit_acked.set()
                    elif kind == "committed_transcript_with_timestamps":
                        if settings.live_stt_debug and (message.get("text") or "").strip():
                            logger.info("LIVE STT DEBUG: detected language=%r raw=%r", message.get("language_code"), message.get("text"))
                    elif kind == "committed_transcript_entities":
                        continue
                    elif "error" in message or kind.endswith("error") or kind in FATAL_ERRORS:
                        detail = str(message.get("error") or kind)
                        fatal = kind in FATAL_ERRORS
                        logger.warning("LIVE STT provider error: %s (%s)", kind, detail)
                        await self._on_error(_friendly_error(kind, detail), fatal)
                        if fatal:
                            self._closing = True
                            return started
            finally:
                sender.cancel()
                try:
                    await sender
                except (asyncio.CancelledError, Exception):
                    pass
        return started

    async def _send_loop(self, ws) -> None:
        silence = b"\x00" * (SAMPLE_RATE // 10 * 2)  # 100 ms of silence carries the final commit flag
        while True:
            while self._buffer:
                chunk = self._buffer.popleft()
                await ws.send(json.dumps({
                    "message_type": "input_audio_chunk",
                    "audio_base_64": base64.b64encode(chunk).decode("ascii"),
                    "sample_rate": SAMPLE_RATE,
                    "commit": False,
                }))
            if self._commit_requested:
                self._commit_requested = False
                await ws.send(json.dumps({
                    "message_type": "input_audio_chunk",
                    "audio_base_64": base64.b64encode(silence).decode("ascii"),
                    "sample_rate": SAMPLE_RATE,
                    "commit": True,
                }))
                self._commit_sent = self._ack_wanted
            self._wake.clear()
            if self._buffer or self._commit_requested:
                continue
            await self._wake.wait()


def _friendly_error(kind: str, detail: str) -> str:
    if kind in ("auth_error", "invalid_api_key", "unauthorized"):
        return "Live transcription is not available (the speech service rejected the server's credentials)."
    if kind == "quota_exceeded":
        return "Live transcription is not available right now (speech service quota exceeded)."
    if kind == "rate_limited":
        return "The live transcription service is busy. Retrying..."
    return "The live transcription service reported an error."
