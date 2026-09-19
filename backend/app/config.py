from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    app_name: str = "AI Translator"
    frontend_origin: str = "http://localhost:5173"
    backend_port: int = 8000
    gemini_api_key: str = ""
    gemini_api_key_2: str = ""
    gemini_api_key_3: str = ""
    gemini_api_keys: str = ""
    hf_api_key: str = ""
    groq_api_key: str = ""
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""

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


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
