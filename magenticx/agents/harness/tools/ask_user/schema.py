"""Input schema of ``ask_user``: 1-3 questions, each with optional suggested answers."""
from __future__ import annotations

from pydantic import BaseModel, Field

#: The interrupt carries at most this many questions; the UI lays them out as one panel.
MAX_QUESTIONS = 3
MAX_QUESTION_CHARS = 300
MAX_OPTIONS = 6


class AskUserQuestion(BaseModel):
    question: str = Field(
        min_length=1,
        max_length=MAX_QUESTION_CHARS,
        description="One short question about one thing (e.g. which period, which project, how deep).",
    )
    options: list[str] = Field(
        default_factory=list,
        max_length=MAX_OPTIONS,
        description=(
            "2-5 short suggested answers, shown as choices. The user can always write "
            "their own answer in a separate field, so never add an 'Other' or 'Something "
            "else' option. Leave empty for a purely open question (e.g. a name you cannot guess)."
        ),
    )
    multiple: bool = Field(
        default=False,
        description="True when several of the options may be chosen together.",
    )


class AskUserInput(BaseModel):
    questions: list[AskUserQuestion] = Field(
        min_length=1,
        max_length=MAX_QUESTIONS,
        description="1-3 questions, only the ones whose answers would change what you do.",
    )


__all__ = ["MAX_QUESTIONS", "AskUserInput", "AskUserQuestion"]
