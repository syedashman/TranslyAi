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
    # "Live Meeting" (browser tab audio -> WebSocket -> ElevenLabs Scribe v2 Realtime -> Gemini). All additive; none
    # of these affect Record Meeting, Upload Recording or the batch STT path.
    live_meeting_enabled: bool = True
    # Largest single WebSocket message accepted from the browser (audio chunks are ~8 KB; this is generous headroom).
    live_ws_max_message_size: int = 65536
    # Finalized segments waiting for Gemini. Beyond this, segments are kept and translated as the queue drains.
    live_translation_queue_size: int = 200
    # Live pipeline concurrency: how many finalized sentences may be romanized / translated AT THE SAME TIME. Results are
    # still shown in spoken order (see LiveSession._emit_ready). One slow Gemini call then delays only its own sentence.
    live_pipeline_workers: int = 6
    # A live Gemini call slower than this gets ONE duplicate request; whichever answers first wins. 0 = off (default):
    # a duplicate spends extra requests, and Gemini quotas are per-minute (e.g. 15 requests/min on a free-tier key), so
    # only turn this on for a key/plan with plenty of headroom.
    live_gemini_hedge_seconds: float = 0.0
    # Per-sentence timing diagnostics in the server log (segment numbers/ids and durations only - never any text).
    live_timing_log: bool = True
    # 0 = no cap. The default (4 h) only exists so an abandoned session can never run forever.
    live_meeting_max_duration_seconds: int = 4 * 60 * 60
    # No message at all from the browser for this long = the connection is treated as dead.
    live_ws_idle_timeout_seconds: int = 45
    # How long a live session survives a dropped browser connection, waiting for the browser to reconnect, before
    # it is finalized automatically with what was already captured.
    live_reconnect_grace_seconds: int = 90
    # Shared (read-only) viewing of a Live Meeting. The public link is separate from the host's private Meeting Chat:
    # letting it expire never deletes anything the host saved.
    # Language hint for the LIVE speech-to-text (ElevenLabs Scribe v2 Realtime). With NO hint Scribe auto-detects the
    # language of each stretch of speech, and on short/accented Urdu-Hindi-English speech it can decide it is another
    # language (e.g. Ukrainian) and then WRITES that language - which no later step can undo. "ur" (default, the same
    # primary language the normal voice flow uses) makes Urdu/Hindi/mixed speech reliable; real English is still
    # transcribed as English. Set LIVE_STT_LANGUAGE_CODE= (empty) to go back to pure auto-detect, or another ISO code.
    live_stt_language_code: str = "ur"
    # Server-log-only diagnostics for STT problems: per sentence, the language Scribe reports and the raw text -> what the
    # Romanizer returned. Never sent to any client, never saved. Off by default.
    live_stt_debug: bool = False
    live_max_viewers: int = 200
    # How long a FINISHED live meeting stays viewable through its share link (default 24 h).
    live_share_ttl_seconds: int = 24 * 60 * 60
    # How long a guest has to sign up and claim a copy of the meeting they watched (default 7 days).
    live_claim_ttl_seconds: int = 7 * 24 * 60 * 60
    # Signs claim tokens. Optional: if empty, a key derived from SUPABASE_SERVICE_ROLE_KEY is used, and if that is
    # missing too a per-process random key (claims then don't survive a server restart).
    live_claim_secret: str = ""

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
