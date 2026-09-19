import asyncio
import os

import requests

from app.config import settings

API_URL = "https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo"


class STTService:
    @classmethod
    async def transcribe(cls, file_path: str) -> str:
        hf_token = os.getenv("HF_API_KEY") or settings.hf_api_key
        if not hf_token:
            raise RuntimeError("HF_API_KEY environment variable is missing")

        headers = {"Authorization": f"Bearer {hf_token}"}

        def _sync_post():
            with open(file_path, "rb") as file:
                data = file.read()
            return requests.post(API_URL, headers=headers, data=data, timeout=30)

        loop = asyncio.get_event_loop()
        try:
            response = await loop.run_in_executor(None, _sync_post)
        except (OSError, requests.RequestException) as exc:
            raise RuntimeError(f"HF STT connection failed: {exc}") from exc

        if response.status_code != 200:
            raise RuntimeError(f"HF STT Error ({response.status_code}): {response.text}")

        result = response.json()
        transcript = str(result.get("text", "")).strip()
        if not transcript:
            raise ValueError("No speech was detected in the uploaded audio file.")
        return transcript
