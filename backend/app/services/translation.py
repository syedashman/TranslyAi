from concurrent.futures import ThreadPoolExecutor, TimeoutError
from typing import Optional

from app.services.summarizer import SummarizerService


class TranslationService:
    _gemini_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gemini-translation")
    _gemini_timeout_seconds = 60

    @classmethod
    def _translate_with_gemini(cls, text: str) -> Optional[str]:
        if not SummarizerService.initialize():
            return None

        prompt = (
            "You are a professional translator. Translate the following input into clear, "
            "natural English.\n"
            "If the input is in Roman Urdu, Hinglish, or any regional dialect "
            "(e.g. 'bhai summary bhi aaegi na'), ALWAYS translate its true meaning into "
            "English (e.g. 'Brother, will the summary be provided for sure?').\n"
            "Do NOT return the original text un-translated if it is in Roman script/Urdu. "
            "Return ONLY the English translation without quotes or extra conversational "
            "text.\n\n"
            f"{text}"
        )

        try:
            future = cls._gemini_executor.submit(SummarizerService.generate_with_retry, prompt)
            try:
                translation = future.result(timeout=cls._gemini_timeout_seconds)
            except TimeoutError as exc:
                future.cancel()
                print(f"GEMINI TRANSLATION TIMEOUT: {exc}")
                return None
            return translation.strip()
        except Exception as exc:
            print(f"GEMINI TRANSLATION ERROR: {exc}")
            return None

    @classmethod
    def translate_to_english(cls, text: str, source_language: Optional[str] = None) -> str:
        if not text or not text.strip():
            raise ValueError("Text is empty; cannot translate.")

        translation = cls._translate_with_gemini(text)
        if translation:
            return translation

        raise RuntimeError("Translation is temporarily unavailable. Please try again later.")
