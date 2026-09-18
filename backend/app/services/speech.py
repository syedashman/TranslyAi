import os
import tempfile
from typing import Optional

from faster_whisper import WhisperModel

from app.config import settings


class SpeechService:
    _model: Optional[WhisperModel] = None

    @classmethod
    def initialize(cls) -> None:
        if cls._model is not None:
            return

        try:
            cls._model = WhisperModel(
                settings.whisper_model,
                device="cpu",
                compute_type="int8",
            )
        except Exception as exc:
            raise RuntimeError(f"Failed to initialize Whisper model: {exc}") from exc

    @classmethod
    def transcribe_file(cls, audio_bytes: bytes, filename: str, language: Optional[str] = None) -> str:
        cls.initialize()

        suffix = os.path.splitext(filename)[1] or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name

        try:
            segments, info = cls._model.transcribe(
                temp_path,
                language=language,
                beam_size=5,
                vad_filter=True,
            )
            transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
            if not transcript:
                raise ValueError("No speech was detected in the uploaded audio file.")
            return transcript.strip()
        finally:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass
