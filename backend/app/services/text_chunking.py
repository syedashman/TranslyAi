"""Content-preserving text chunking for very long inputs (meeting transcripts).

Used only by the meeting pipeline. The short text/voice translation paths are untouched - they already fit
comfortably in one Gemini call and are not routed through this at all.
"""

import re


def chunk_text(text: str, max_chars: int = 6000) -> list[str]:
    """Splits `text` into chunks of at most ~max_chars, never cutting a sentence in half where avoidable.

    Splits on paragraph boundaries first and packs consecutive paragraphs into a chunk up to the limit; a single
    paragraph longer than max_chars is further split on sentence boundaries, and a single "sentence" longer than
    max_chars (no punctuation at all) is split on whitespace as a last resort. Every character of the input is
    preserved across the returned chunks - nothing is dropped or summarized here, this only decides how the text
    is batched into separate Gemini calls.
    """
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    paragraphs = [part for part in re.split(r"\n{2,}", text) if part.strip()]
    units: list[str] = []
    for paragraph in paragraphs:
        units.extend(_split_long_unit(paragraph, max_chars))

    chunks: list[str] = []
    buffer = ""
    for unit in units:
        candidate = f"{buffer}\n\n{unit}" if buffer else unit
        if len(candidate) <= max_chars:
            buffer = candidate
        else:
            if buffer:
                chunks.append(buffer)
            buffer = unit
    if buffer:
        chunks.append(buffer)
    return chunks


def _split_long_unit(unit: str, max_chars: int) -> list[str]:
    """A single paragraph, split on sentence boundaries if it alone exceeds max_chars."""
    if len(unit) <= max_chars:
        return [unit]

    sentences = re.split(r"(?<=[.!?])\s+", unit)
    pieces: list[str] = []
    buffer = ""
    for sentence in sentences:
        if len(sentence) > max_chars:
            if buffer:
                pieces.append(buffer)
                buffer = ""
            pieces.extend(_split_by_words(sentence, max_chars))
            continue
        candidate = f"{buffer} {sentence}" if buffer else sentence
        if len(candidate) <= max_chars:
            buffer = candidate
        else:
            if buffer:
                pieces.append(buffer)
            buffer = sentence
    if buffer:
        pieces.append(buffer)
    return pieces


def _split_by_words(text: str, max_chars: int) -> list[str]:
    """Last resort for a "sentence" with no punctuation at all: split on whitespace."""
    words = text.split(" ")
    pieces: list[str] = []
    buffer = ""
    for word in words:
        candidate = f"{buffer} {word}" if buffer else word
        if len(candidate) <= max_chars or not buffer:
            buffer = candidate
        else:
            pieces.append(buffer)
            buffer = word
    if buffer:
        pieces.append(buffer)
    return pieces
