import os
from typing import Optional

from google import genai
from google.genai import types

from app.config import settings


class SummarizerService:
    _client: Optional[genai.Client] = None
    _fallback_message = "Summary is unavailable right now. Please try again later."

    @classmethod
    def initialize(cls) -> bool:
        if cls._client is not None:
            return True

        if not os.getenv("GEMINI_API_KEY") and settings.gemini_api_key.strip():
            os.environ["GEMINI_API_KEY"] = settings.gemini_api_key

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            return False

        try:
            cls._client = genai.Client(
                api_key=os.getenv("GEMINI_API_KEY"),
                http_options=types.HttpOptions(api_version="v1"),
            )
            return True
        except Exception:
            cls._client = None
            return False

    @classmethod
    def summarize(cls, text: str) -> str:
        if not text or not text.strip():
            raise ValueError("Text is empty; cannot summarize.")

        if not cls.initialize():
            return cls._fallback_message

        try:
            prompt = (
                "Create a complete summary of the following translated text in exactly 2-3 "
                "concise, clear English sentences. Preserve the key meaning and important "
                "context. Return only the summary.\n\n"
                f"{text}"
            )
            response = cls._client.models.generate_content(
                model="gemini-3.6-flash",
                contents=prompt,
            )
            return response.text.strip() or cls._fallback_message
        except Exception as error:
            print(f"GEMINI SUMMARY ERROR: {error}")
            return cls._fallback_message
