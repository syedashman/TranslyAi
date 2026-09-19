from __future__ import annotations

from typing import Optional

from app.services.language import LanguageService
from app.services.speech import SpeechService
from app.services.summarizer import SummarizerService
from app.services.translation import TranslationService


async def translate_and_summarize(
    text: str,
    source_language: Optional[str] = None,
    audio_path: Optional[str] = None,
):
    """Pipeline entry-point for transcription, detection, translation, and summarization."""
    if not text and not audio_path:
        raise ValueError("Either text or audio input is required.")

    if audio_path:
        text = await SpeechService.transcribe_file(audio_path)

    normalized_source = LanguageService.normalize_code(source_language)
    detected_language = normalized_source or LanguageService.detect(text)

    if detected_language is None:
        raise ValueError("Unable to detect the input language automatically.")

    english_translation = TranslationService.translate_to_english(text, detected_language)
    summary = SummarizerService.summarize(english_translation)

    return {
        "detected_language": LanguageService.display_name(detected_language),
        "original_text": text.strip(),
        "english_translation": english_translation.strip(),
        "summary": summary.strip(),
    }
