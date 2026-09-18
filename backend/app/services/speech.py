import os
import tempfile
from typing import Optional

from app.services.stt import STTService


class SpeechService:
    @classmethod
    async def transcribe_file(cls, audio_bytes: bytes, filename: str, language: Optional[str] = None) -> str:
        if not audio_bytes:
            raise ValueError("Audio file is empty.")

        suffix = os.path.splitext(filename)[1] or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name

        try:
            return await STTService.transcribe(temp_path)
        finally:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass
