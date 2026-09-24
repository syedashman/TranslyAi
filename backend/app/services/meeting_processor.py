"""The "Start Meeting" background pipeline: finalized audio -> transcript -> translation -> summary.

Reuses the existing STTService (ElevenLabs Scribe v2 with Groq Whisper fallback, unchanged), TranslationService
and SummarizerService (same Gemini models, prompts and key rotation as the short-voice flow) - nothing here talks
to any provider directly or duplicates their configuration. The only things specific to meetings are: language
auto-detection instead of forcing Urdu, a much longer STT timeout, and splitting the transcript into chunks before
translation so a single Gemini call's output-length limit can't truncate a long meeting.
"""

import asyncio
import logging

from app.services.meeting_jobs import update_job
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


async def _translate_transcript(transcript: str) -> str:
    chunks = chunk_text(transcript, max_chars=TRANSLATION_CHUNK_CHARS)
    if not chunks:
        return ""
    translated_parts: list[str] = []
    for index, chunk in enumerate(chunks):
        text, translated = await asyncio.to_thread(TranslationService.translate_with_status, chunk, True)
        if not translated:
            raise RuntimeError(f"Gemini translation failed on part {index + 1} of {len(chunks)}: {text}")
        translated_parts.append(text)
    return "\n\n".join(translated_parts)


async def _summarize(translation: str) -> str:
    if len(translation) <= SUMMARY_TWO_PASS_THRESHOLD_CHARS:
        return await asyncio.to_thread(SummarizerService.summarize, translation)

    # Map: summarize each piece on its own, then reduce: one final summarize pass over those partial summaries -
    # still the existing SummarizerService/prompt both times, just applied twice for an unusually long meeting.
    logger.info("MEETING SUMMARY: translation is %d chars, summarizing in two passes", len(translation))
    partial_summaries = []
    for chunk in chunk_text(translation, max_chars=TRANSLATION_CHUNK_CHARS):
        partial_summaries.append(await asyncio.to_thread(SummarizerService.summarize, chunk))
    return await asyncio.to_thread(SummarizerService.summarize, "\n\n".join(partial_summaries))


async def _set_stage(job_id: str, status: str) -> None:
    job = update_job(job_id, status=status)
    if job:
        await MeetingStore.upsert(job)


async def process_meeting(job_id: str, audio_path: str) -> None:
    """Runs as a FastAPI BackgroundTask, after the POST /api/meetings response has already been sent - nothing
    here keeps an HTTP request open, however long it takes."""
    try:
        await _set_stage(job_id, "transcribing")
        transcript = await SpeechService.transcribe_file(
            audio_path, auto_detect=True, timeout=MEETING_STT_TIMEOUT_SECONDS,
        )
        transcript = (transcript or "").strip()
        if not transcript:
            raise RuntimeError("No speech was detected in the recording.")
        update_job(job_id, transcript=transcript)

        await _set_stage(job_id, "translating")
        translation = await _translate_transcript(transcript)
        update_job(job_id, translation=translation)

        await _set_stage(job_id, "summarizing")
        summary = await _summarize(translation)
        update_job(job_id, summary=summary)

        job = update_job(job_id, status="completed")
        if job:
            await MeetingStore.upsert(job)
    except Exception as error:
        logger.error("MEETING PROCESSING FAILED (job %s): %r", job_id, error)
        job = update_job(job_id, status="failed", error_message=str(error))
        if job:
            await MeetingStore.upsert(job)
    finally:
        SpeechService.discard(audio_path)
