import re


def to_plain_text(text: str) -> str:
    """Strips markdown (headings, bold, bullets, code marks, links) so replies read as normal sentences."""
    if not text:
        return ""
    cleaned = text.replace("\r\n", "\n")
    cleaned = re.sub(r"```[a-zA-Z0-9_+-]*\n?", "", cleaned)
    cleaned = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]{0,3}#{1,6}[ \t]*", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]{0,3}>[ \t]?", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]*[-*+•][ \t]+", "", cleaned)
    cleaned = re.sub(r"(\*\*|__)(.+?)\1", r"\2", cleaned, flags=re.DOTALL)
    cleaned = re.sub(r"(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])", r"\1", cleaned)
    cleaned = re.sub(r"(?<!\w)_(?![\s_])(.+?)(?<![\s_])_(?!\w)", r"\1", cleaned)
    cleaned = cleaned.replace("`", "").replace("~~", "").replace("*", "")
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"[ \t]*\n[ \t]*", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def to_plain_title(text: str, max_words: int = 5, max_chars: int = 50) -> str:
    """One short line of plain words: no markdown, no symbols, at most max_words words."""
    lines = to_plain_text(text).splitlines()
    line = re.sub(r"^title\s*:\s*", "", lines[0].strip(), flags=re.IGNORECASE) if lines else ""
    line = re.sub(r"[^\w\s'’-]|_", " ", line)
    words = [word.strip("-'’") for word in line.split() if re.search(r"\w", word)][:max_words]
    return " ".join(words)[:max_chars].rstrip(" '-’")


def to_summary_text(text: str) -> str:
    """Cleans a summary but keeps its structure: '• ' bullets and **bold** lead-ins."""
    if not text:
        return ""
    cleaned = text.replace("\r\n", "\n")
    cleaned = re.sub(r"```[a-zA-Z0-9_+-]*\n?", "", cleaned)
    cleaned = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]{0,3}#{1,6}[ \t]*", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]{0,3}>[ \t]?", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]*[-*+•‣◦▪][ \t]+", "• ", cleaned)
    cleaned = re.sub(r"__(.+?)__", r"**\1**", cleaned, flags=re.DOTALL)
    # Keep paired **bold**; anything left over (single or unpaired asterisks, backticks) is noise.
    parts = re.split(r"(\*\*[^*\n]+?\*\*)", cleaned)
    cleaned = "".join(part if part.startswith("**") and part.endswith("**") and len(part) > 4 else part.replace("*", "") for part in parts)
    cleaned = cleaned.replace("`", "").replace("~~", "")
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"[ \t]*\n[ \t]*", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()
