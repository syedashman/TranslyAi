from app.services.summarizer import SummarizerService
from app.services.textclean import to_plain_title


class TitleService:
    default_title = "New chat"
    # Titles that mean "not named yet": ours, and the default many chat tables already use.
    untitled = ("new chat", "new conversation", "untitled", "")

    @classmethod
    def is_untitled(cls, title: str) -> bool:
        return (title or "").strip().lower() in cls.untitled

    @classmethod
    def fallback_title(cls, text: str) -> str:
        return to_plain_title(text) or cls.default_title

    @classmethod
    def generate(cls, text: str) -> str:
        """Blocking (Gemini call): run it in a worker thread. Falls back to the first words of the message."""
        snippet = (text or "").strip()[:500]
        if not snippet:
            return cls.default_title

        prompt = (
            "Write a short, clear title of 3 to 5 words for a chat that starts with the user's message below. "
            "The title must describe what the user wrote. "
            "Write the title in English, even if the message is in another language or in Roman script. "
            "Only use ideas that appear in the message and do not add details that are not there. "
            "Use plain words only: no markdown, no quotes, no emoji, no symbols, no punctuation, and no prefix like 'Title:'. "
            "Return only the title.\n\n"
            f"User message:\n{snippet}"
        )
        try:
            title = to_plain_title(SummarizerService.generate_with_retry(prompt))
        except Exception as error:
            print(f"GEMINI TITLE ERROR: {error}")
            title = ""
        return title or cls.fallback_title(snippet)
