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
            "Translate the following text into clear, natural English. "
            "Output only the translation, without commentary.\n\n"
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

    @staticmethod
    def normalize_source_language(code: Optional[str]) -> Optional[str]:
        mapping = {
            "en": "eng_Latn",
            "es": "spa_Latn",
            "fr": "fra_Latn",
            "de": "deu_Latn",
            "it": "ita_Latn",
            "pt": "por_Latn",
            "ja": "jpn_Jpan",
            "ko": "kor_Hang",
            "zh": "zho_Hans",
            "ar": "arb_Arab",
            "ur": "urd_Arab",
        }
        if not code:
            return None
        normalized = code.strip().lower()
        return mapping.get(normalized)

    @classmethod
    def translate_to_english(cls, text: str, source_language: Optional[str] = None) -> str:
        if not text or not text.strip():
            raise ValueError("Text is empty; cannot translate.")

        source_lang = cls.normalize_source_language(source_language) or "eng_Latn"
        if source_lang == "eng_Latn":
            return text.strip()

        translation = cls._translate_with_gemini(text)
        if translation:
            return translation

        raise RuntimeError("Translation is temporarily unavailable. Please try again later.")
