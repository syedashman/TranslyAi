import os

from groq import Groq


class STTService:
    @classmethod
    async def transcribe(cls, file_path: str) -> str:
        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            raise Exception("GROQ_API_KEY environment variable is missing")

        client = Groq(api_key=groq_api_key)

        with open(file_path, "rb") as file:
            transcription = client.audio.transcriptions.create(
                file=(os.path.basename(file_path), file.read()),
                model="whisper-large-v3-turbo",
                response_format="text",
            )
        return str(transcription)
