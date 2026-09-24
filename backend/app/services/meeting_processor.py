"""The "Start Meeting" background pipeline: finalized audio -> transcript -> translation -> summary.

Reuses the existing STTService (ElevenLabs Scribe v2 with Groq Whisper fallback, unchanged), TranslationService
and SummarizerService (same Gemini models, prompts and key rotation as the short-voice flow) - nothing here talks
to any provider directly or duplicates their configuration. The only things specific to meetings are: language
auto-detection instead of forcing Urdu, a much longer STT timeout, splitting the transcript into chunks before
translation so a single Gemini call's output-length limit can't truncate a long meeting, and a meeting-level
retry-with-backoff around each Gemini call (see MEETING_GEMINI_RETRY_*) - a background job has minutes of slack
that the short-voice flow's 60s HTTP-bound request doesn't, so it's worth riding out a transient 503/quota blip
here by calling the *same* existing translate/summarize functions again, rather than failing the whole meeting.
"""

import asyncio
import logging

from app.services.meeting_jobs import get_job, update_job
from app.services.meeting_store import MeetingStore
from app.services.speech import SpeechService
from app.services.summarizer import SummarizerService
from app.services.text_chunking import chunk_text
from app.services.translation import TranslationService

logger = logging.getLogger("ai-translator")

# A 30-100 minute file can take Scribe v2 much longer to transcribe than a short clip; this only bounds one
# provider's network call inside a background task, so it never holds an HTTP request open.
MEETING_STT_TIMEOUT_SECONDS = 20 * 60.0

# Translation chunk size: comfortably under every current Gemini model's per-response output limit, so a chunk's
# translation is never truncated. Summarization is done once over the full combined translation afterward (Gemini's
# input context window covers even a 100-minute transcript easily; it's a single response's OUTPUT length that
# is limited, which is why only the translation step needs chunking).
TRANSLATION_CHUNK_CHARS = 6000

# If the combined translation is unusually large, summarize it in two passes (chunk-level summaries, then one
# final pass over those) instead of one very large single call - still "the full/combined content", just processed
# safely rather than blindly.
SUMMARY_TWO_PASS_THRESHOLD_CHARS = 120_000

# A transient Gemini issue (429/503/all-keys-briefly-exhausted) already gets retried across models/keys inside
# SummarizerService.generate_with_retry, but that whole rotation is bounded to ~60s by
# TranslationService._gemini_timeout_seconds - fine for an interactive request, not enough for "Gemini is
# flaky for a minute or two" during a background job that can afford to just wait and call it again.
MEETING_GEMINI_RETRY_ATTEMPTS = 3
MEETING_GEMINI_RETRY_DELAY_SECONDS = 5.0


async def _translate_chunk_with_retry(chunk: str, index: int, total: int) -> str:
    """Calls the existing TranslationService.translate_with_status - unmodified - up to
    MEETING_GEMINI_RETRY_ATTEMPTS times if Gemini is temporarily unavailable, before giving up on this chunk."""
    last_text = ""
    for attempt in range(1, MEETING_GEMINI_RETRY_ATTEMPTS + 1):
        text, translated = await asyncio.to_thread(TranslationService.translate_with_status, chunk, True)
        if translated:
            return text
        last_text = text
        logger.warning(
            "MEETING TRANSLATE RETRY: part %d/%d attempt %d/%d failed (%s)",
            index + 1, total, attempt, MEETING_GEMINI_RETRY_ATTEMPTS, text,
        )
        if attempt < MEETING_GEMINI_RETRY_ATTEMPTS:
            await asyncio.sleep(MEETING_GEMINI_RETRY_DELAY_SECONDS)
    raise RuntimeError(
        f"Gemini translation failed on part {index + 1} of {total} after {MEETING_GEMINI_RETRY_ATTEMPTS} attempts: {last_text}"
    )


async def _translate_transcript(transcript: str) -> str:
    chunks = chunk_text(transcript, max_chars=TRANSLATION_CHUNK_CHARS)
    if not chunks:
        return ""
    translated_parts: list[str] = []
    for index, chunk in enumerate(chunks):
        translated_parts.append(await _translate_chunk_with_retry(chunk, index, len(chunks)))
    return "\n\n".join(translated_parts)


async def _summarize_once_with_retry(text: str) -> str:
    """Calls the existing SummarizerService.summarize - unmodified - up to MEETING_GEMINI_RETRY_ATTEMPTS times.
    summarize() never raises on its own (it returns SummarizerService._fallback_message on any failure instead of
    a distinct error), so that exact fallback string is what's checked for and retried on here."""
    for attempt in range(1, MEETING_GEMINI_RETRY_ATTEMPTS + 1):
        summary = await asyncio.to_thread(SummarizerService.summarize, text)
        if summary != SummarizerService._fallback_message:
            return summary
        logger.warning("MEETING SUMMARY RETRY: attempt %d/%d got the fallback message", attempt, MEETING_GEMINI_RETRY_ATTEMPTS)
        if attempt < MEETING_GEMINI_RETRY_ATTEMPTS:
            await asyncio.sleep(MEETING_GEMINI_RETRY_DELAY_SECONDS)
    raise RuntimeError("Gemini summarization is temporarily unavailable.")


async def _summarize(translation: str) -> str:
    if len(translation) <= SUMMARY_TWO_PASS_THRESHOLD_CHARS:
        return await _summarize_once_with_retry(translation)

    # Map: summarize each piece on its own, then reduce: one final summarize pass over those partial summaries -
    # still the existing SummarizerService/prompt both times, just applied twice for an unusually long meeting.
    logger.info("MEETING SUMMARY: translation is %d chars, summarizing in two passes", len(translation))
    partial_summaries = []
    for chunk in chunk_text(translation, max_chars=TRANSLATION_CHUNK_CHARS):
        partial_summaries.append(await _summarize_once_with_retry(chunk))
    return await _summarize_once_with_retry("\n\n".join(partial_summaries))


async def _persist(job: dict) -> None:
    persisted = await MeetingStore.upsert(job)
    logger.info("MEETING PERSIST: id=%s status=%s persisted=%s", job.get("id"), job.get("status"), persisted)


async def process_meeting(job_id: str, audio_path: str) -> None:
    """Runs as a FastAPI BackgroundTask, after the POST /api/meetings response has already been sent - nothing
    here keeps an HTTP request open, however long it takes."""
    try:
        update_job(job_id, status="transcribing")
        transcript = await SpeechService.transcribe_file(
            audio_path, auto_detect=True, timeout=MEETING_STT_TIMEOUT_SECONDS,
        )
        transcript = (transcript or "").strip()
        if not transcript:
            raise RuntimeError("No speech was detected in the recording.")
        update_job(job_id, transcript=transcript)

        update_job(job_id, status="translating")
        translation = await _translate_transcript(transcript)
        update_job(job_id, translation=translation)

        update_job(job_id, status="summarizing")
        summary = await _summarize(translation)
        update_job(job_id, summary=summary)

        # Persist to Supabase BEFORE flipping the LIVE in-memory status to "completed": the frontend polls that
        # in-memory status and, the moment it sees "completed", immediately refreshes Meeting History
        # (GET /api/meetings, which reads Supabase - see MeetingModal's onSaved). If the status flip happened
        # first, that refresh could race ahead of this write and simply not find the row yet. Awaiting the
        # persist attempt first means the write has already happened (or definitively failed) before the
        # frontend can ever observe "completed".
        final_job = get_job(job_id)
        if final_job is None:
            return  # job was evicted (see meeting_jobs._MAX_JOBS) - nothing left to persist or mark completed
        final_job["status"] = "completed"
        await _persist(final_job)

        update_job(job_id, status="completed")
    except Exception as error:
        logger.error("MEETING PROCESSING FAILED (job %s): %r", job_id, error)
        job = update_job(job_id, status="failed", error_message=str(error))
        if job:
            await _persist(job)
    finally:
        SpeechService.discard(audio_path)
