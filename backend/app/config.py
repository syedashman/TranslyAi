from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "AI Translator"
    frontend_origin: str = "http://localhost:5173"
    backend_port: int = 8000
    gemini_api_key: str = ""
    hf_api_key: str = ""
    groq_api_key: str = ""
    whisper_model: str = "small"
    nllb_model: str = "facebook/nllb-200-distilled-600M"
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
