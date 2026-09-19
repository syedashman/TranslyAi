import asyncio
import gc

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.schemas import TranslationRequest, TranslationResponse
from app.services.language import LanguageService
from app.services.speech import SpeechService
from app.services.summarizer import SummarizerService
from app.services.translation import TranslationService
from app.services.translator import translate_and_summarize

router = APIRouter(prefix="/api", tags=["translator"])


@router.post("/translate", response_model=TranslationResponse)
async def translate_endpoint(request: TranslationRequest):
    source_language = getattr(request, "source_lang", request.source_language)
    try:
        detected_language = LanguageService.normalize_code(source_language)
        if detected_language is None:
            detected_language = await asyncio.wait_for(
                asyncio.to_thread(LanguageService.detect, request.text),
                timeout=15.0,
            )

        translated_text, translated = await asyncio.wait_for(
            asyncio.to_thread(TranslationService.translate_with_status, request.text),
            timeout=15.0,
        )
    except Exception as exc:
        print(f"TRANSLATE ENDPOINT ERROR: {exc}")
        translated_text, translated = TranslationService._fallback_message, False

    if not translated:
        summary = SummarizerService._fallback_message
    else:
        try:
            summary = await asyncio.wait_for(
                asyncio.to_thread(SummarizerService.summarize, translated_text),
                timeout=15.0,
            )
        except Exception as exc:
            print(f"SUMMARY ENDPOINT ERROR: {exc}")
            summary = SummarizerService._fallback_message

    fallback_language = LanguageService.normalize_code(source_language) or "en"
    return {
        "detected_language": LanguageService.display_name(fallback_language),
        "original_text": request.text.strip(),
        "english_translation": translated_text.strip(),
        "summary": summary.strip(),
    }


@router.post("/audio", response_model=TranslationResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    source_language: str | None = Form(default=None),
):
    gc.collect()
    audio_path = None
    try:
        if not file.filename:
            raise ValueError("No audio file uploaded.")

        audio_path = await SpeechService.save_upload(file)
        result = await translate_and_summarize(
            text="",
            source_language=source_language,
            audio_path=audio_path,
        )
        return result
    except ValueError as exc:
        print(f"AUDIO ENDPOINT VALUE ERROR: {exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        print(f"AUDIO ENDPOINT RUNTIME ERROR: {exc}")
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        print(f"AUDIO ENDPOINT ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        SpeechService.discard(audio_path)
        await file.close()
        gc.collect()
