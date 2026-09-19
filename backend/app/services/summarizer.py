import os
import time
from typing import Optional

from google import genai
from google.genai import errors, types

from app.config import settings


class SummarizerService:
    _client: Optional[genai.Client] = None
    _fallback_message = "Summary is unavailable right now. Please try again later."
    _primary_model = "gemini-3.6-flash"
    _fallback_model = "gemini-3.5-flash"
    _max_retries = 3
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
    def _is_retryable(error: Exception) -> bool:
        if not isinstance(error, errors.ServerError):
            return False
        if error.code == 503:
            return True
        status = (error.status or "").upper()
        message = (error.message or "").lower()
        return status == "UNAVAILABLE" or "high demand" in message or "overloaded" in message

    @classmethod
    def generate_with_retry(cls, prompt: str) -> str:
        """Call Gemini with exponential backoff, falling back to a secondary model.

        Runs synchronously and is only ever invoked off the event loop (via
        asyncio.to_thread / a ThreadPoolExecutor), so time.sleep is used for the
        backoff delay rather than asyncio.sleep, which would require an event loop
        on the calling thread.
        """
        if not cls.initialize():
            raise RuntimeError("Gemini client is not configured.")

        last_error: Optional[Exception] = None

        for attempt in range(1, cls._max_retries + 1):
            try:
                response = cls._client.models.generate_content(
                    model=cls._primary_model,
                    contents=prompt,
                    config=cls._generation_config,
                )
                return response.text.strip()
            except Exception as error:
                last_error = error
                print(
                    f"GEMINI GENERATE ERROR ({cls._primary_model}, "
                    f"attempt {attempt}/{cls._max_retries}): {error}"
                )
                if not cls._is_retryable(error) or attempt == cls._max_retries:
                    break
                time.sleep(1 if attempt == 1 else 2)

        try:
            response = cls._client.models.generate_content(
                model=cls._fallback_model,
                contents=prompt,
                config=cls._generation_config,
            )
            return response.text.strip()
        except Exception as error:
            print(f"GEMINI GENERATE ERROR ({cls._fallback_model}): {error}")
            raise RuntimeError(str(error)) from error

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
