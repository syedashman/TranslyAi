import os
from typing import Optional

from google import genai
from google.genai import errors, types

from app.config import settings

GEMINI_MODELS = [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
]


class SummarizerService:
    _client: Optional[genai.Client] = None
    _fallback_message = "Summary is unavailable right now. Please try again later."
    _generation_config = types.GenerateContentConfig(
        tools=[],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )

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

    @staticmethod
    def _should_try_next_model(error: Exception) -> bool:
        # 429 (rate limit), 503 (high demand) and 404 (model retired) are model-specific,
        # so the next model may succeed. Other 4xx errors (bad key, bad request) would fail everywhere.
        if isinstance(error, errors.ClientError):
            return error.code in (404, 429)
        return True

    @classmethod
    def generate_with_retry(cls, prompt: str) -> str:
        """Try each model in GEMINI_MODELS in order, moving to the next one immediately on failure."""
        if not cls.initialize():
            raise RuntimeError("Gemini client is not configured.")

        last_error: Optional[Exception] = None

        for model in GEMINI_MODELS:
            try:
                response = cls._client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=cls._generation_config,
                )
                return response.text.strip()
            except Exception as error:
                last_error = error
                print(f"GEMINI GENERATE ERROR ({model}): {error}")
                if not cls._should_try_next_model(error):
                    break

        raise RuntimeError(f"All Gemini models failed: {last_error}") from last_error

    @classmethod
    def summarize(cls, text: str) -> str:
        if not text or not text.strip():
            raise ValueError("Text is empty; cannot summarize.")

        prompt = (
            "Create a complete summary of the following translated text in exactly 2-3 "
            "concise, clear English sentences. Preserve the key meaning and important "
            "context. Return only the summary.\n\n"
            f"{text}"
        )
        try:
            return cls.generate_with_retry(prompt) or cls._fallback_message
        except Exception as error:
            print(f"GEMINI SUMMARY ERROR: {error}")
            return cls._fallback_message
