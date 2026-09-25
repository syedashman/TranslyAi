from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    app_name: str = "TranslyAi"
    frontend_origin: str = "http://localhost:5173"
    backend_port: int = 8000
    gemini_api_key: str = ""
    gemini_api_key_2: str = ""
    gemini_api_key_3: str = ""
    gemini_api_keys: str = ""
    hf_api_key: str = ""
    groq_api_key: str = ""
    elevenlabs_api_key: str = ""
    # Which STT provider /api/transcribe and /api/audio use, primary first.
    # "elevenlabs" (Scribe v2, default): tried first, auto-falls back to Groq Whisper only if it fails.
    # "whisper": Groq Whisper only, no ElevenLabs involved.
    stt_provider: str = "elevenlabs"
    # Comma-separated words/phrases to bias ElevenLabs Scribe v2 towards (product names, jargon, etc.).
    # Edit this in .env, not in code. Leave blank for none.
    elevenlabs_keyterms: str = ""
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    # "Upload Recording" (Meeting Chat video/audio file upload) size cap in MB - separate from the browser
    # recording limit (meeting_routes.MAX_MEETING_AUDIO_BYTES, unchanged) and the short-voice 25 MB limit
    # (SpeechService.MAX_AUDIO_BYTES, unchanged). Default of 2048 MB (2 GB) comfortably covers a ~100-minute
    # meeting video at typical bitrates; raise via MEETING_VIDEO_MAX_MB in .env if needed.
    meeting_video_max_mb: int = 2048

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def gemini_key_list(self) -> list[str]:
        """All configured Gemini keys in priority order, de-duplicated and blank-free."""
        candidates = [
            self.gemini_api_key,
            self.gemini_api_key_2,
            self.gemini_api_key_3,
            *self.gemini_api_keys.split(","),
        ]
        keys: list[str] = []
        for candidate in candidates:
            key = candidate.strip()
            if key and key not in keys:
                keys.append(key)
        return keys

    def elevenlabs_keyterm_list(self) -> list[str]:
        """Configured keyterms, blank-free. Edit ELEVENLABS_KEYTERMS in .env to change this without a code change."""
        return [term.strip() for term in self.elevenlabs_keyterms.split(",") if term.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
