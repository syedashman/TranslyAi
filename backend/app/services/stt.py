import os

from dotenv import find_dotenv, load_dotenv
from groq import Groq

from app.config import settings

load_dotenv(find_dotenv(), override=True)


class STTService:
    @classmethod
    async def transcribe(cls, file_path: str) -> str:
        if not os.getenv("GROQ_API_KEY") and settings.groq_api_key.strip():
            os.environ["GROQ_API_KEY"] = settings.groq_api_key

        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            raise Exception("GROQ_API_KEY environment variable is missing")

        client = Groq(api_key=groq_api_key)

        try:
            with open(file_path, "rb") as file:
                transcription = client.audio.transcriptions.create(
                    file=(os.path.basename(file_path), file.read()),
                    model="whisper-large-v3-turbo",
                    prompt=(
                        "Transcribe the audio in English or Roman Urdu script only. "
                        "Do NOT output Devanagari or Hindi characters."
                    ),
                    response_format="text",
                )
            return str(transcription)
        except Exception as error:
            print(f"GROQ STT ERROR: {error}")
            raise
