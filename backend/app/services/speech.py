import os
import tempfile
from typing import Optional

from fastapi import UploadFile

from app.services.stt import STTService

UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_AUDIO_BYTES = 25 * 1024 * 1024


class SpeechService:
    @staticmethod
    async def save_upload(upload: UploadFile) -> str:
        """Stream an upload to a temp file in chunks so the audio is never fully held in RAM."""
        suffix = os.path.splitext(upload.filename or "")[1] or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_path = temp_file.name
            total = 0
            try:
                while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise ValueError("Audio file is too large (25 MB maximum).")
                    temp_file.write(chunk)
            except Exception:
                temp_file.close()
                SpeechService.discard(temp_path)
                raise

        if total == 0:
            SpeechService.discard(temp_path)
            raise ValueError("Audio file is empty.")
        return temp_path

    @staticmethod
    def discard(path: Optional[str]) -> None:
        if not path:
            return
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    @classmethod
    async def transcribe_file(cls, audio_path: str, language: Optional[str] = None, roman: bool = False) -> str:
        if roman:
            return await STTService.transcribe_roman(audio_path, language=language)
        return await STTService.transcribe(audio_path, language=language)
