import asyncio
import os
from typing import Optional

from dotenv import find_dotenv, load_dotenv
from groq import Groq

from app.config import settings
from app.services.romanizer import to_roman_script

load_dotenv(find_dotenv(), override=True)


WHISPER_MODEL = "whisper-large-v3"
DEFAULT_LANGUAGE = "ur"
WHISPER_PROMPT = (
    "Aapka kaam sirf audio ko exact Roman Urdu text mein transcribe karna hai. "
    "Audio: 'Assalamu alaikum, main aapko bataunga...'. "
    "Do not translate into English. Do not drop words."
)
ROMANIZE_TIMEOUT_SECONDS = 45.0


class STTService:
    _client: Optional[Groq] = None

    @classmethod
    def _get_client(cls) -> Groq:
        if cls._client is not None:
            return cls._client

        if not os.getenv("GROQ_API_KEY") and settings.groq_api_key.strip():
            os.environ["GROQ_API_KEY"] = settings.groq_api_key

        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            raise Exception("GROQ_API_KEY environment variable is missing")

        cls._client = Groq(api_key=groq_api_key)
        return cls._client

    @classmethod
    async def transcribe(cls, file_path: str, language: Optional[str] = None) -> str:
        client = cls._get_client()

        # Urdu is enforced so Whisper follows the spoken Urdu instead of guessing another language or translating it.
        language = language or DEFAULT_LANGUAGE

        try:
            # Pass the open handle (not bytes/path) so the SDK streams it instead of loading it into RAM.
            with open(file_path, "rb") as file:
                transcription = client.audio.transcriptions.create(
                    file=(os.path.basename(file_path), file),
                    model=WHISPER_MODEL,
                    prompt=WHISPER_PROMPT,
                    response_format="text",
                    temperature=0.0,
                    language=language,
                )
            return str(transcription)
        except Exception as error:
            print(f"GROQ STT ERROR: {error}")
            raise

    @classmethod
    async def transcribe_roman(cls, file_path: str, language: Optional[str] = None) -> str:
        """Transcribes and guarantees Latin-script text for the input box.

        Forcing Urdu makes Whisper answer in Urdu (Arabic) script most of the time, so whenever the result contains
        non-Latin letters it is converted to Roman Urdu (no translation). If the conversion is unavailable the
        original transcript is returned rather than an error.
        """
        text = (await cls.transcribe(file_path, language)).strip()
        try:
            return (await asyncio.wait_for(asyncio.to_thread(to_roman_script, text), timeout=ROMANIZE_TIMEOUT_SECONDS)).strip()
        except Exception as error:
            print(f"STT ROMANIZE ERROR: {error}")
            return text
