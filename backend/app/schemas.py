from typing import Optional

from pydantic import BaseModel, Field


class TranslationRequest(BaseModel):
    text: str = Field(..., min_length=1)
    source_language: Optional[str] = None


class TranslationResponse(BaseModel):
    detected_language: str
    original_text: str
    english_translation: str
    summary: str
