from __future__ import annotations

import asyncio
from typing import Optional

from app.services.language import LanguageService
from app.services.moderation import ModerationService, ProhibitedContentError
from app.services.speech import SpeechService
from app.services.summarizer import SummarizerService
from app.services.translation import TranslationService


async def translate_and_summarize(
    text: str,
    source_language: Optional[str] = None,
    audio_path: Optional[str] = None,
    spoken: bool = False,
):
    """Pipeline entry-point for transcription, detection, translation, and summarization."""
    if not text and not audio_path:
        raise ValueError("Either text or audio input is required.")

    normalized_source = LanguageService.normalize_code(source_language)

    if audio_path:
        text = await SpeechService.transcribe_file(audio_path, language=normalized_source)

    # Moderate the transcript itself, after STT - before it ever reaches Gemini translation. ModerationService.check
    # already fails open internally (a moderation-call failure never blocks), but this stays fail-open too: only a
    # genuine ProhibitedContentError (caught by the route) stops the pipeline; nothing else raised here should.
    try:
        await asyncio.to_thread(ModerationService.check, text)
    except ProhibitedContentError:
        raise
    except Exception as error:
        print(f"MODERATION CHECK ERROR (allowing content through): {error}")

    detected_language = normalized_source or LanguageService.detect(text)

    if detected_language is None:
        raise ValueError("Unable to detect the input language automatically.")

    english_translation, translated = await asyncio.to_thread(
        TranslationService.translate_with_status, text, spoken or bool(audio_path)
    )
    if translated:
        summary = await asyncio.to_thread(SummarizerService.summarize, english_translation)
    else:
        summary = SummarizerService._fallback_message

    return {
        "detected_language": LanguageService.display_name(detected_language),
        "original_text": text.strip(),
        "english_translation": english_translation.strip(),
        "summary": summary.strip(),
    }
