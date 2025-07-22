from typing import Any, Dict, List, Optional, Tuple
from openai import AsyncOpenAI
from langchain_core.runnables import RunnableLambda

client = AsyncOpenAI()

CATEGORY_LABELS = {
    "harassment": "Harassment / Abusive",
    "harassment_threatening": "Harassment (Threatening)",
    "hate": "Hate",
    "hate_threatening": "Hate (Threatening)",
    "illicit": "Illicit Activities",
    "illicit_violent": "Illicit (Violent)",
    "self_harm": "Self-Harm",
    "self_harm_intent": "Self-Harm (Intent)",
    "self_harm_instructions": "Self-Harm (Instructions)",
    "sexual": "Sexual Content",
    "sexual_minors": "Sexual Content Involving Minors",
    "violence": "Violence",
    "violence_graphic": "Graphic Violence",
    "harassment/threatening": "Harassment (Threatening)",
    "hate/threatening": "Hate (Threatening)",
    "illicit/violent": "Illicit (Violent)",
    "self-harm": "Self-Harm",
    "self-harm/intent": "Self-Harm (Intent)",
    "self-harm/instructions": "Self-Harm (Instructions)",
    "sexual/minors": "Sexual Content Involving Minors",
    "violence/graphic": "Graphic Violence",
}


def _extract_last_user(messages: List[Dict[str, Any]]) -> str:
    """
    Return content of the last message with role 'user'.
    (Safer than just taking list[-1] if your list includes assistant/system.)
    """
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return msg["content"]
    # Fallback: last message content anyway
    if not messages:
        raise ValueError("`messages` must contain at least one message.")
    return messages[-1]["content"]

async def _moderate(text: str):
    """Call the OpenAI moderation API to check the text for safety."""
    return client.moderations.create(
        model="omni-moderation-latest",
        input=text
    ).results[0]

def _format(result) -> Tuple[bool, Optional[Dict[str, str]]]:
    """Return (allowed, payload). If blocked: allowed=False and payload is the user-facing dict."""
    if not result.flagged:
        return True, None

    cats = result.categories
    scores = result.category_scores
    flagged = [
        (k, getattr(scores, k, None))
        for k, v in vars(cats).items()
        if v and not k.startswith("_")
    ]
    # Deduplicate aliases (first occurrence wins)
    seen = set()
    cleaned = []
    for k, sc in flagged:
        if k not in seen:
            seen.add(k)
            cleaned.append((k, sc))

    bullets = ", ".join(
        f"{CATEGORY_LABELS.get(k, k)} ({sc:.2f})"
        if isinstance(sc, (int, float)) else CATEGORY_LABELS.get(k, k)
        for k, sc in cleaned
    )

    summary = (
        "⚠️ Your message was flagged by safety filters.\n"
        f"**Categories:** {bullets}\n"
        "Please rephrase to remove disallowed, dangerous, or instructional details."
    )
    return False, {"type": "response", "content": summary}

moderation_agent = (
    RunnableLambda(_extract_last_user) |
    RunnableLambda(_moderate) |
    RunnableLambda(_format)
)