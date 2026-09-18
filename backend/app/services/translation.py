from concurrent.futures import ThreadPoolExecutor, TimeoutError
import re
import warnings
from typing import Optional

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

from app.config import settings
from app.services.summarizer import SummarizerService

warnings.filterwarnings("ignore")


class TranslationService:
    _tokenizer = None
    _model = None
    _generation_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="nllb-generation")
    _claude_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="claude-translation")
    _generation_timeout_seconds = 30
    _claude_timeout_seconds = 60

    @staticmethod
    def _extract_claude_text(response) -> str:
        parts = []
        for block in response.content or []:
            if getattr(block, "type", None) == "text" or hasattr(block, "text"):
                parts.append(getattr(block, "text", ""))
        return "".join(parts).strip()

    @staticmethod
    def _create_claude_translation(client, model: str, system_prompt: str, text: str):
        request_client = client
        if hasattr(client, "with_options"):
            request_client = client.with_options(timeout=60.0)
        return request_client.messages.create(
            model=model,
            max_tokens=1000,
            system=system_prompt,
            messages=[{"role": "user", "content": text}],
        )

    @classmethod
    def _translate_with_claude(cls, text: str) -> Optional[str]:
        if not SummarizerService.initialize():
            return None

        client = SummarizerService._client
        active_model = "claude-fable-5-1"
        system_prompt = (
            "You are a professional translator. Translate the provided text from any source "
            "language into clear, natural English. Output ONLY the translated English text. "
            "Do NOT add commentary, intros, or disclaimers."
        )
        try:
            future = cls._claude_executor.submit(
                cls._create_claude_translation,
                client,
                active_model,
                system_prompt,
                text,
            )
            try:
                response = future.result(timeout=cls._claude_timeout_seconds)
            except TimeoutError as exc:
                future.cancel()
                print(f"CLAUDE TRANSLATION TIMEOUT: {exc}")
                return None
            return cls._extract_claude_text(response)
        except Exception as exc:
            print(f"CLAUDE TRANSLATION ERROR: {exc}")
            return None

    @classmethod
    def _generate(cls, inputs, forced_bos_token_id):
        with torch.no_grad():
            return cls._model.generate(
                **inputs,
                forced_bos_token_id=forced_bos_token_id,
                max_new_tokens=128,
                max_length=None,
                no_repeat_ngram_size=3,
                repetition_penalty=1.2,
            )

    @classmethod
    def initialize(cls) -> None:
        if cls._tokenizer is not None and cls._model is not None:
            return

        try:
            cls._tokenizer = AutoTokenizer.from_pretrained(settings.nllb_model)
            cls._model = AutoModelForSeq2SeqLM.from_pretrained(settings.nllb_model)
        except Exception as exc:
            raise RuntimeError(f"Failed to initialize translation model: {exc}") from exc

    @staticmethod
    def normalize_source_language(code: Optional[str]) -> Optional[str]:
        mapping = {
            "en": "eng_Latn",
            "es": "spa_Latn",
            "fr": "fra_Latn",
            "de": "deu_Latn",
            "it": "ita_Latn",
            "pt": "por_Latn",
            "ja": "jpn_Jpan",
            "ko": "kor_Hang",
            "zh": "zho_Hans",
            "ar": "arb_Arab",
            "ur": "urd_Arab",
        }
        if not code:
            return None
        normalized = code.strip().lower()
        return mapping.get(normalized)

    @staticmethod
    def split_into_chunks(text: str) -> list[str]:
        paragraphs = re.split(r"\n\s*\n", text.strip())
        chunks = []
        for paragraph in paragraphs:
            chunks.extend(
                sentence.strip()
                for sentence in re.findall(r"[^.!?\n]+(?:[.!?]+|$)", paragraph)
                if sentence.strip()
            )
        return chunks or [text.strip()]

    @classmethod
    def translate_to_english(cls, text: str, source_language: Optional[str] = None) -> str:
        if not text or not text.strip():
            raise ValueError("Text is empty; cannot translate.")

        source_lang = cls.normalize_source_language(source_language) or "eng_Latn"
        if source_lang != "eng_Latn":
            claude_translation = cls._translate_with_claude(text)
            if claude_translation is not None:
                return claude_translation

        cls.initialize()

        cls._tokenizer.src_lang = source_lang
        paragraph_chunks = [
            cls.split_into_chunks(paragraph)
            for paragraph in re.split(r"\n\s*\n", text.strip())
        ]
        chunks = [chunk for group in paragraph_chunks for chunk in group]
        if not chunks:
            return text.strip()

        try:
            forced_bos_token_id = cls._tokenizer.lang_code_to_id["eng_Latn"]
        except AttributeError:
            forced_bos_token_id = cls._tokenizer.convert_tokens_to_ids("eng_Latn")
        translated_chunks = []
        for start in range(0, len(chunks), 4):
            chunk_batch = chunks[start:start + 4]
            inputs = cls._tokenizer(
                chunk_batch,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=256,
            )
            future = cls._generation_executor.submit(cls._generate, inputs, forced_bos_token_id)
            try:
                generated_tokens = future.result(timeout=cls._generation_timeout_seconds)
            except TimeoutError:
                future.cancel()
                return text.strip()
            except Exception:
                future.cancel()
                return text.strip()
            translated_chunks.extend(
                cls._tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)
            )

        translated_paragraphs = []
        chunk_index = 0
        for chunk_group in paragraph_chunks:
            paragraph = [
                translated_chunks[chunk_index + index].strip()
                for index in range(len(chunk_group))
                if translated_chunks[chunk_index + index].strip()
            ]
            if paragraph:
                translated_paragraphs.append(" ".join(paragraph))
            chunk_index += len(chunk_group)

        return "\n\n".join(translated_paragraphs) or text.strip()
