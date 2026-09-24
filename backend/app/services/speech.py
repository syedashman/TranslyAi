import os
import tempfile
from typing import Optional

from fastapi import UploadFile

from app.services.stt import STTService

UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_AUDIO_BYTES = 25 * 1024 * 1024


class SpeechService:
    @staticmethod
    async def save_upload(upload: UploadFile, max_bytes: int = MAX_AUDIO_BYTES) -> str:
        """Stream an upload to a temp file in chunks so the audio is never fully held in RAM.

        max_bytes defaults to the existing 25 MB short-voice limit; the meeting pipeline passes a much larger
        limit (see meeting_routes.py) since a 30-100 minute recording is naturally bigger than a short clip.
        """
        suffix = os.path.splitext(upload.filename or "")[1] or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_path = temp_file.name
            total = 0
            try:
                while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError(f"Audio file is too large ({max_bytes // (1024 * 1024)} MB maximum).")
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
    async def transcribe_file(
        cls, audio_path: str, language: Optional[str] = None, roman: bool = False,
        *, auto_detect: bool = False, timeout: Optional[float] = None,
    ) -> str:
        if roman:
            return await STTService.transcribe_roman(audio_path, language=language)
        text, _provider = await STTService.transcribe(audio_path, language=language, auto_detect=auto_detect, timeout=timeout)
        return text
