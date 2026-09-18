from typing import Optional

from anthropic import Anthropic

from app.config import settings


class SummarizerService:
    _client: Optional[Anthropic] = None
    _model = "claude-4-5-haiku"
    _fallback_message = "Summary is unavailable right now. Please try again later."

    @classmethod
    def initialize(cls) -> bool:
        if cls._client is not None:
            return True

        if not settings.anthropic_api_key.strip():
            return False

        try:
            cls._client = Anthropic(api_key=settings.anthropic_api_key)
            return True
        except Exception:
            cls._client = None
            return False

    @classmethod
    def summarize(cls, text: str) -> str:
        if not text or not text.strip():
            raise ValueError("Text is empty; cannot summarize.")

        if not cls.initialize():
            return cls._fallback_message

        prompt = (
            "Create a complete summary of the following translated text in exactly 2-3 concise, "
            "clear English sentences. Preserve the key meaning, include the important context, "
            "and finish the summary without truncation. Return only the summary.\n\n"
            f"{text}"
        )
        system_prompt = (
            "You are a precise English summarizer. Always produce a complete 2-3 sentence summary "
            "and never stop mid-sentence."
        )

        client = cls._client
        response = None
        working_model = None
        compatibility_models = [
            "claude-3-haiku-20240307",
            "claude-3-5-haiku-20241022",
            "claude-3-5-sonnet-20241022",
            "claude-3-sonnet-20240229",
            "claude-3-opus-20240229",
        ]

        try:
            available_models = list(client.models.list())
            available_model_ids = [model.id for model in available_models]
            print("AVAILABLE MODELS:", available_model_ids)
            if not available_model_ids:
                return "Summary unavailable: Anthropic returned no available models."

            working_model = available_model_ids[0]
            response = client.messages.create(
                model=working_model,
                max_tokens=1000,
                system=system_prompt,
                messages=[{"role": "user", "content": prompt}],
            )
        except (AttributeError, NotImplementedError):
            for candidate_model in compatibility_models:
                try:
                    response = client.messages.create(
                        model=candidate_model,
                        max_tokens=1000,
                        system=system_prompt,
                        messages=[{"role": "user", "content": prompt}],
                    )
                    working_model = candidate_model
                    break
                except Exception as error:
                    print(f"CLAUDE API ERROR ({candidate_model}): {error}")
            if response is None:
                return "Summary unavailable: all compatibility model attempts failed."
        except Exception as error:
            print(f"CLAUDE API ERROR ({working_model or 'model discovery'}): {error}")
            return f"Summary unavailable ({working_model or 'model discovery'}): {str(error)}"

        summary_text = ""
        for block in response.content or []:
            if getattr(block, "type", None) == "text" or hasattr(block, "text"):
                summary_text += getattr(block, "text", "")

        summary = summary_text.strip()
        return summary or cls._fallback_message
