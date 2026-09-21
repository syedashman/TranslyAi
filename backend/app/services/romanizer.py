import unicodedata

from app.services.summarizer import SummarizerService

ROMANIZE_SYSTEM_INSTRUCTION = (
    "You convert text written in Devanagari (Hindi), Urdu (Arabic script), or any other non-Latin script into "
    "Roman Urdu using Latin letters only, spelled the way people type it on a phone "
    "(e.g. 'मेरा नाम बिलाल है' -> 'mera naam Bilal hai', 'میرا نام بلال ہے' -> 'mera naam Bilal hai').\n"
    "Do NOT translate: keep the same language, the same words, and the same order. "
    "Do NOT skip, add, summarize, or paraphrase anything; convert every single word and sentence.\n"
    "Words already in Latin script (English words, names, technical terms) stay exactly as they are. "
    "Names are spelled in their natural English/Roman form (e.g. Syed Muhammad Ashman).\n"
    "Keep punctuation and line breaks. Return ONLY the converted text, with no quotes, notes, or commentary, "
    "and never use Devanagari, Arabic-script, or any other non-Latin characters."
)


def has_non_latin_letters(text: str) -> bool:
    """True when the text contains letters from a script other than Latin (Devanagari, Urdu, etc.)."""
    return any(ch.isalpha() and not unicodedata.name(ch, "").startswith("LATIN") for ch in text or "")


def to_roman_script(text: str) -> str:
    """Returns the text in Latin script. Text that is already Latin, or a failed conversion, comes back unchanged."""
    if not text or not has_non_latin_letters(text):
        return text
    try:
        roman = SummarizerService.generate_with_retry(
            text, system_instruction=ROMANIZE_SYSTEM_INSTRUCTION, temperature=0.0
        ).strip()
    except Exception as error:
        print(f"ROMANIZE ERROR: {error}")
        return text
    # Only accept the result if it is really Latin; otherwise keep the original transcript.
    return roman if roman and not has_non_latin_letters(roman) else text
