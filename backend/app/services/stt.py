import asyncio
import os
from typing import Optional

from dotenv import find_dotenv, load_dotenv
from elevenlabs import ElevenLabs
from groq import Groq

from app.config import settings
from app.services.romanizer import to_roman_script

load_dotenv(find_dotenv(), override=True)


WHISPER_MODEL = "whisper-large-v3"
ELEVENLABS_MODEL = "scribe_v2"
DEFAULT_LANGUAGE = "ur"
# Whisper reads `prompt` as the text that came just before the audio, not as instructions. So it is a style primer:
# natural Urdu-script speech with English words kept in Latin, and a few fillers so Whisper transcribes fillers
# instead of skipping them. It deliberately contains no names, so none can leak into the transcript.
WHISPER_PROMPT = "جی، وہ، مطلب، میں نے آج meeting میں Python اور Machine Learning کے بارے میں بات کی، اور پھر client کو email بھی بھیج دیا۔"
# Bounds a single provider's network call so a stuck/slow request fails fast enough to fall back, instead of
# hanging for the SDK's own much longer default timeout.
STT_PROVIDER_TIMEOUT_SECONDS = 45.0
TRANSCRIBE_TIMEOUT_SECONDS = 60.0


class STTService:
    _groq_client: Optional[Groq] = None
    _elevenlabs_client: Optional[ElevenLabs] = None

    @classmethod
    def _get_groq_client(cls) -> Groq:
        if cls._groq_client is not None:
            return cls._groq_client

        if not os.getenv("GROQ_API_KEY") and settings.groq_api_key.strip():
            os.environ["GROQ_API_KEY"] = settings.groq_api_key

        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is missing")

        cls._groq_client = Groq(api_key=groq_api_key)
        return cls._groq_client

    @classmethod
    def _get_elevenlabs_client(cls) -> ElevenLabs:
        if cls._elevenlabs_client is not None:
            return cls._elevenlabs_client

        elevenlabs_api_key = os.getenv("ELEVENLABS_API_KEY") or settings.elevenlabs_api_key.strip()
        if not elevenlabs_api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY environment variable is missing. "
                "Set it in backend/.env or switch STT_PROVIDER back to 'whisper'."
            )

        cls._elevenlabs_client = ElevenLabs(api_key=elevenlabs_api_key)
        return cls._elevenlabs_client

    @classmethod
    async def transcribe_with_whisper(
        cls, file_path: str, language: Optional[str] = None, *, auto_detect: bool = False, timeout: Optional[float] = None
    ) -> str:
        """Raw transcript from Groq Whisper-large-v3 (temperature 0.0, no clean-up).

        auto_detect=False (default, unchanged behavior): language defaults to "ur" and the Urdu-biased style
        prompt is sent, exactly as before. auto_detect=True (used by the meeting pipeline for multilingual
        recordings): neither is forced, letting Whisper detect the spoken language itself.
        """
        client = cls._get_groq_client()
        if not auto_detect:
            language = language or DEFAULT_LANGUAGE

        def _call() -> str:
            # Pass the open handle (not bytes/path) so the SDK streams it instead of loading it into RAM.
            with open(file_path, "rb") as file:
                kwargs: dict = {}
                if language:
                    kwargs["language"] = language
                if not auto_detect:
                    kwargs["prompt"] = WHISPER_PROMPT
                transcription = client.audio.transcriptions.create(
                    file=(os.path.basename(file_path), file),
                    model=WHISPER_MODEL,
                    response_format="text",
                    temperature=0.0,
                    **kwargs,
                )
            return str(transcription)

        try:
            # The SDK call is synchronous network I/O; run it off the event loop and bound how long it may block.
            return await asyncio.wait_for(asyncio.to_thread(_call), timeout=timeout or STT_PROVIDER_TIMEOUT_SECONDS)
        except Exception as error:
            print(f"GROQ STT ERROR: {error.__class__.__name__}: {error}")
            raise

    @classmethod
    async def transcribe_with_elevenlabs(
        cls, file_path: str, language: Optional[str] = None, *, auto_detect: bool = False, timeout: Optional[float] = None
    ) -> str:
        """Raw transcript from ElevenLabs Scribe v2 (temperature 0.0, verbatim, no clean-up).

        auto_detect=True (meeting pipeline only): no language_code is sent at all, so Scribe v2 detects the
        spoken language itself instead of being forced to "ur" - meetings may mix Urdu, Hindi, Sindhi, English,
        German, etc. Default behavior (auto_detect=False) is unchanged.
        """
        client = cls._get_elevenlabs_client()
        if not auto_detect:
            language = language or DEFAULT_LANGUAGE
        keyterms = settings.elevenlabs_keyterm_list()

        def _call() -> str:
            with open(file_path, "rb") as file:
                # keyterms/language_code are only passed when set: the SDK treats an explicit None differently
                # from the argument being omitted entirely.
                extra: dict = {"keyterms": keyterms} if keyterms else {}
                if language:
                    extra["language_code"] = language
                response = client.speech_to_text.convert(
                    model_id=ELEVENLABS_MODEL,
                    file=(os.path.basename(file_path), file),
                    temperature=0.0,
                    # False = keep filler words, false starts and repeats; only Scribe v2 supports this flag.
                    no_verbatim=False,
                    tag_audio_events=False,
                    **extra,
                )
            return str(getattr(response, "text", "") or "")

        try:
            # The SDK call is synchronous network I/O; run it off the event loop and bound how long it may block.
            return await asyncio.wait_for(asyncio.to_thread(_call), timeout=timeout or STT_PROVIDER_TIMEOUT_SECONDS)
        except Exception as error:
            # Message only: never the request/response object, so an API-key or header value can't end up in a log.
            print(f"ELEVENLABS STT ERROR: {error.__class__.__name__}: {error}")
            raise

    @classmethod
    async def transcribe(
        cls, file_path: str, language: Optional[str] = None, *, auto_detect: bool = False, timeout: Optional[float] = None
    ) -> tuple[str, str]:
        """Raw transcript from whichever provider STT_PROVIDER selects, plus the provider that actually produced it.

        STT_PROVIDER=elevenlabs (the default): ElevenLabs Scribe v2 is always tried first. A successful response is
        used as-is and Groq is never called. Only when ElevenLabs raises - network/API/timeout/auth error, or any
        other exception - does this fall back to Groq Whisper automatically.
        STT_PROVIDER=whisper: Groq Whisper only, exactly as before, with no ElevenLabs fallback either way.

        auto_detect and timeout are passed straight through to whichever provider(s) are tried; both default to
        the existing short-voice behavior (forced "ur", the existing 45s provider timeout) when not given.
        """
        provider = (settings.stt_provider or "elevenlabs").strip().lower()

        if provider == "whisper":
            return await cls.transcribe_with_whisper(file_path, language, auto_detect=auto_detect, timeout=timeout), "whisper"

        if provider != "elevenlabs":
            print(f"STT_PROVIDER '{provider}' is not recognized; using 'elevenlabs'.")

        try:
            text = await cls.transcribe_with_elevenlabs(file_path, language, auto_detect=auto_detect, timeout=timeout)
        except Exception as primary_error:
            print(f"STT DEBUG: primary=elevenlabs status=failed fallback=groq_whisper reason={primary_error.__class__.__name__}")
            try:
                text = await cls.transcribe_with_whisper(file_path, language, auto_detect=auto_detect, timeout=timeout)
            except Exception as fallback_error:
                # Both providers failed: surface one clear, specific error instead of a generic 500 - this is the
                # only case where the caller doesn't get a transcript, so it needs to say why.
                raise RuntimeError(
                    f"ElevenLabs transcription failed ({primary_error}) and the Groq Whisper fallback also failed "
                    f"({fallback_error})."
                ) from fallback_error
            return text, "groq_whisper (fallback)"

        print("STT DEBUG: primary=elevenlabs status=success")
        return text, "elevenlabs"

    @classmethod
    async def transcribe_roman(cls, file_path: str, language: Optional[str] = None) -> str:
        """Verbatim transcription for the input box.

        Stage 1 (STT_PROVIDER: ElevenLabs Scribe v2 by default, falling back to Groq Whisper-large-v3 only on
        failure; language="ur", temperature 0.0) captures every spoken word. Stage 2 only changes the script (Urdu
        letters -> Roman letters). It never cleans, corrects or shortens: fillers, repeats and wording stay. If
        stage 2 fails or is not word-for-word, the raw transcript is returned untouched.
        """
        raw, provider = await cls.transcribe(file_path, language)
        raw = raw.strip()
        if not raw:
            print(f"STT DEBUG: provider={provider} raw='' final=''")
            return ""
        try:
            final = (await asyncio.wait_for(asyncio.to_thread(to_roman_script, raw), timeout=TRANSCRIBE_TIMEOUT_SECONDS)).strip()
        except Exception as error:
            print(f"STT ROMANIZE ERROR: {error}")
            final = raw
        # Development visibility only (see the task's DEBUGGING section): raw/final are speech content, never
        # secrets, and are logged exactly as produced - never trimmed or altered.
        print(f"STT DEBUG: provider={provider} raw={raw!r} final={final!r}")
        return final
