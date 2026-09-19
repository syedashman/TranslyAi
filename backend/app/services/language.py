from typing import Optional

from lingua import Language, LanguageDetectorBuilder

SUPPORTED_LANGUAGES = (
    Language.ENGLISH, Language.SPANISH, Language.FRENCH, Language.GERMAN,
    Language.ITALIAN, Language.PORTUGUESE, Language.JAPANESE, Language.KOREAN,
    Language.CHINESE, Language.ARABIC, Language.URDU,
)


class LanguageService:
    _detector = None

    @classmethod
    def initialize(cls) -> None:
        if cls._detector is not None:
            return

        try:
            cls._detector = LanguageDetectorBuilder.from_languages(*SUPPORTED_LANGUAGES).build()
        except Exception as exc:
            raise RuntimeError(f"Failed to initialize language detector: {exc}") from exc

    @staticmethod
    def normalize_code(code: Optional[str]) -> Optional[str]:
        if not code:
            return None
        value = getattr(code, "name", code)
        value = str(value).strip().lower()
        if len(value) == 2 and value in {"en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ar", "ur"}:
            return value
        mapping = {
            "english": "en",
            "spanish": "es",
            "french": "fr",
            "german": "de",
            "italian": "it",
            "portuguese": "pt",
            "japanese": "ja",
            "korean": "ko",
            "chinese": "zh",
            "arabic": "ar",
            "urdu": "ur",
            "roman urdu": "ur",
        }
        return mapping.get(value)

    @staticmethod
    def looks_like_roman_urdu(text: str) -> bool:
        roman_urdu_words = {
            "aap", "acha", "achha", "aur", "bahut", "bohat", "chahiye", "hai", "hain",
            "karna", "karo", "ka", "ke", "ki", "kya", "mein", "mera", "meri", "mujhe",
            "nahin", "nahi", "se", "tum", "yeh", "woh",
        }
        words = {word.strip(".,!?;:'\"()[]{}").lower() for word in text.split()}
        return len(words & roman_urdu_words) >= 2

    @classmethod
    def detect(cls, text: str) -> Optional[str]:
        if not text or not text.strip():
            raise ValueError("Text is empty; cannot detect language.")

        if cls.looks_like_roman_urdu(text):
            return "ur"

        try:
            cls.initialize()
            confidence_values = list(cls._detector.compute_language_confidence_values(text))
            if not confidence_values:
                return "en"

            best_match = confidence_values[0]
            if getattr(best_match, "value", 1.0) < 0.55:
                return "en"

            detected = getattr(best_match, "language", None)
            iso_code = getattr(detected, "iso_code_639_1", None)
            normalized = cls.normalize_code(iso_code)
            return normalized if normalized in {"en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ar", "ur"} else "en"
        except Exception:
            return "en"

    @staticmethod
    def display_name(code: Optional[str]) -> str:
        if not code:
            return "Unknown"

        mapping = {
            "en": "English",
            "es": "Spanish",
            "fr": "French",
            "de": "German",
            "it": "Italian",
            "pt": "Portuguese",
            "ja": "Japanese",
            "ko": "Korean",
            "zh": "Chinese",
            "ar": "Arabic",
            "ur": "Urdu",
        }
        return mapping.get(code.lower(), code.upper())
