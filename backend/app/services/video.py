"""FFmpeg-based audio extraction for the Meeting Chat "Upload Recording" path (video or audio file uploads) -
the ONLY new processing step video support adds. Once this produces an audio file, everything downstream (STT,
translation, summary, persistence) is the exact same, unmodified process_meeting() pipeline used for a browser
recording (see meeting_processor.process_meeting_upload) - nothing here talks to ElevenLabs/Groq/Gemini/Supabase.

FFmpeg availability: this project's Render deployment is a plain Docker service built from backend/Dockerfile
(python:3.11-slim), which does not include FFmpeg by default - the Dockerfile installs it via apt-get (see the
comment there). Locally, FFmpeg must also be installed and on PATH (e.g. `apt install ffmpeg` / `brew install
ffmpeg` / `choco install ffmpeg` on Windows), or just run the app inside Docker where it's already handled.
"""

import asyncio
import logging
import os
import shutil
import tempfile

from app.services.speech import SpeechService

logger = logging.getLogger("ai-translator")

# Audio-only extraction of even a 100-minute file is normally fast (no video re-encoding happens in the common,
# codec-copy case below); generous anyway so a slow disk or a cold container is never cut off prematurely.
FFMPEG_TIMEOUT_SECONDS = 20 * 60.0

# The three video containers the "Upload Recording" picker accepts (see meeting_routes.upload_meeting).
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm"}
# Audio files the existing STT providers already accept directly - no FFmpeg step needed for these, they go
# straight into the existing pipeline exactly like a browser recording does (see meeting_routes.upload_meeting).
SUPPORTED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".mpeg", ".mpga"}
SUPPORTED_UPLOAD_EXTENSIONS = SUPPORTED_VIDEO_EXTENSIONS | SUPPORTED_AUDIO_EXTENSIONS

# The container each source format's audio is remuxed into when copied without re-encoding - matches what these
# formats actually carry (MP4/MOV: AAC, WebM: Opus), both already accepted directly by the existing STT
# pipeline, so the common case never needs a real transcode.
_COPY_TARGET_EXTENSION = {".mp4": ".m4a", ".mov": ".m4a", ".webm": ".webm"}


class VideoExtractionError(Exception):
    """A short, user-facing reason audio extraction failed - never FFmpeg's raw stderr, a file path, or a stack
    trace (see the module docstring's security note in the task this was built for)."""


def _no_audio_stream(stderr_text: str) -> bool:
    markers = ("does not contain any stream", "matches no streams", "output file #0 does not contain any stream")
    lowered = stderr_text.lower()
    return any(marker in lowered for marker in markers)


class VideoService:
    @staticmethod
    def is_ffmpeg_available() -> bool:
        return shutil.which("ffmpeg") is not None

    @staticmethod
    async def _run_ffmpeg(source_path: str, dest_path: str, codec_args: list[str]) -> tuple[bool, str]:
        """One FFmpeg pass, file-to-file: FFmpeg does its own disk I/O reading source_path and writing
        dest_path - nothing here ever holds either file's bytes in Python memory, which is what keeps this safe
        for a multi-hundred-MB/multi-hour recording."""
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", source_path, "-vn", "-map", "0:a:0", *codec_args, dest_path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=FFMPEG_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise VideoExtractionError("This recording took too long to process. Please try a shorter recording.")
        stderr_text = (stderr or b"").decode("utf-8", errors="ignore")
        ok = process.returncode == 0 and os.path.exists(dest_path) and os.path.getsize(dest_path) > 0
        return ok, stderr_text

    @classmethod
    async def extract_audio(cls, source_path: str) -> str:
        """Extracts source_path's audio track into a new temp file. Tries a fast, lossless remux first (no
        re-encoding - "-acodec copy"); only falls back to a real re-encode if that fails for a reason other than
        "no audio track" at all. Returns the new file's path - the caller discards source_path itself, and the
        existing process_meeting() pipeline discards the returned path once it's done transcribing it, exactly
        like any other meeting audio file."""
        if not cls.is_ffmpeg_available():
            raise VideoExtractionError("Video processing is not available on the server right now. Please try again later.")

        extension = os.path.splitext(source_path)[1].lower()
        copy_ext = _COPY_TARGET_EXTENSION.get(extension, ".m4a")
        attempts = [
            (copy_ext, ["-acodec", "copy"]),               # fast, lossless remux - the common case
            (".m4a", ["-acodec", "aac", "-b:a", "160k"]),   # re-encode fallback if the copy attempt fails
        ]

        last_stderr = ""
        for dest_ext, codec_args in attempts:
            fd, dest_path = tempfile.mkstemp(suffix=dest_ext)
            os.close(fd)
            ok, stderr_text = await cls._run_ffmpeg(source_path, dest_path, codec_args)
            if ok:
                return dest_path
            SpeechService.discard(dest_path)
            if _no_audio_stream(stderr_text):
                raise VideoExtractionError("This video does not contain an audio track.")
            last_stderr = stderr_text

        logger.warning("MEETING VIDEO EXTRACTION FAILED (both attempts): %s", last_stderr[-500:])
        raise VideoExtractionError("Unable to extract audio from this recording.")
