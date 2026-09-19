import time
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
    _clients: list[genai.Client] = []
    _fallback_message = "Summary is unavailable right now. Please try again later."
    _key_cooldown_seconds = 60
    _cooldown_until: dict[tuple[int, str], float] = {}
    _generation_config = types.GenerateContentConfig(
        tools=[],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )

    @classmethod
    def initialize(cls) -> bool:
        if cls._clients:
            return True

        clients = []
        for index, api_key in enumerate(settings.gemini_key_list(), start=1):
            try:
                clients.append(
                    genai.Client(api_key=api_key, http_options=types.HttpOptions(api_version="v1"))
                )
            except Exception as error:
                print(f"GEMINI CLIENT INIT ERROR (key {index}): {error}")

        cls._clients = clients
        return bool(clients)

    @staticmethod
    def _is_quota_error(error: Exception) -> bool:
        if not isinstance(error, errors.ClientError):
            return False
        return error.code == 429 or (error.status or "").upper() == "RESOURCE_EXHAUSTED"

    @staticmethod
    def _is_key_error(error: Exception) -> bool:
        if not isinstance(error, errors.ClientError):
            return False
        return error.code in (401, 403) or (error.code == 400 and "api key" in (error.message or "").lower())

    @staticmethod
    def _should_try_next_model(error: Exception) -> bool:
        # 503 (high demand) and 404 (model retired) are model-specific, so the next model may work.
        # Other 4xx errors (bad request) would fail on every model.
        if isinstance(error, errors.ClientError):
            return error.code == 404
        return True

    @classmethod
    def _is_cooling_down(cls, key_index: int, model: str) -> bool:
        return cls._cooldown_until.get((key_index, model), 0.0) > time.monotonic()

    @classmethod
    def _start_cooldown(cls, key_index: int, model: str) -> None:
        cls._cooldown_until[(key_index, model)] = time.monotonic() + cls._key_cooldown_seconds

    @classmethod
    def generate_with_retry(cls, prompt: str) -> str:
        """Try each model in GEMINI_MODELS; within a model, rotate through the configured API keys.

        A quota (429) or invalid-key error moves to the next key for the same model, and that
        key/model pair is skipped for a short cooldown so an exhausted key never slows later
        requests. A 503 or 404 moves straight to the next model.
        """
        if not cls.initialize():
            raise RuntimeError("Gemini client is not configured.")

        last_error: Optional[Exception] = None
        total_keys = len(cls._clients)

        for model in GEMINI_MODELS:
            for key_index, client in enumerate(cls._clients):
                if cls._is_cooling_down(key_index, model):
                    continue
                try:
                    response = client.models.generate_content(
                        model=model,
                        contents=prompt,
                        config=cls._generation_config,
                    )
                    return response.text.strip()
                except Exception as error:
                    last_error = error
                    print(f"GEMINI GENERATE ERROR ({model}, key {key_index + 1}/{total_keys}): {error}")
                    if cls._is_key_error(error):
                        for cooldown_model in GEMINI_MODELS:
                            cls._start_cooldown(key_index, cooldown_model)
                        continue
                    if cls._is_quota_error(error):
                        cls._start_cooldown(key_index, model)
                        continue
                    if cls._should_try_next_model(error):
                        break
                    raise RuntimeError(f"Gemini request failed: {error}") from error

        if last_error is None:
            raise RuntimeError("All Gemini API keys are temporarily rate limited.")
        raise RuntimeError(f"All Gemini models and API keys failed: {last_error}") from last_error

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
