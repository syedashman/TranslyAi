import os
from typing import Optional

from dotenv import find_dotenv, load_dotenv
from groq import Groq

from app.config import settings

load_dotenv(find_dotenv(), override=True)


WHISPER_PROMPT = (
    "Transcribe exact spoken Urdu, Roman Urdu, Hinglish, or English audio phonetically. "
    "Do not add or guess words that were not spoken."
)


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

        # Without an explicit choice the language is left out so Whisper auto-detects it per recording.
        options = {"language": language} if language else {}

        try:
            # Pass the open handle (not bytes/path) so the SDK streams it instead of loading it into RAM.
            with open(file_path, "rb") as file:
                transcription = client.audio.transcriptions.create(
                    file=(os.path.basename(file_path), file),
                    model="whisper-large-v3-turbo",
                    prompt=WHISPER_PROMPT,
                    response_format="text",
                    temperature=0.0,
                    **options,
                )
            return str(transcription)
        except Exception as error:
            print(f"GROQ STT ERROR: {error}")
            raise
