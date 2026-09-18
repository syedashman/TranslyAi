import os

import httpx

from app.config import settings

API_URL = "https://router.huggingface.co/hf-inference/v1/audio/transcriptions"
LEGACY_API_URL = "https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo"


class STTService:
    @classmethod
    async def transcribe(cls, file_path: str) -> str:
        hf_token = settings.hf_api_key or os.environ.get("HF_API_KEY")
        if not hf_token:
            raise RuntimeError("HF_API_KEY is not configured for audio transcription.")

        headers = {"Authorization": f"Bearer {hf_token}"}
        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                with open(file_path, "rb") as file:
                    files = {"file": (os.path.basename(file_path), file, "audio/webm")}
                    data = {"model": "openai/whisper-large-v3-turbo"}
                    response = await client.post(API_URL, headers=headers, files=files, data=data)

                if response.status_code != 200:
                    with open(file_path, "rb") as file:
                        response = await client.post(
                            LEGACY_API_URL,
                            headers=headers,
                            content=file.read(),
                        )
        except (OSError, httpx.RequestError) as exc:
            raise RuntimeError(f"HF STT connection failed: {exc}") from exc

        if response.status_code != 200:
            raise RuntimeError(f"HF STT Error ({response.status_code}): {response.text}")

        result = response.json()
        transcript = str(result.get("text", "")).strip()
        if not transcript:
            raise ValueError("No speech was detected in the uploaded audio file.")
        return transcript
