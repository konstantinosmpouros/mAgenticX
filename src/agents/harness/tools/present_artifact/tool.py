"""Agent tool: designate a finished file as a user-facing deliverable.

The single explicit act that promotes a document out of the agent's scratch and
helper files into something the user actually receives. Everything an agent (or
its sub-agents) writes to ``/conversation/output/`` stays invisible; only a file
passed to ``present_artifact`` is surfaced — as a live artifact card during the
run and, once the run finalizes, as a downloadable/previewable attachment on the
assistant message.

The card lands **at the position of the call**, not at the end of the turn: the
timeline closes the open content block so any text the model writes afterwards
starts below it. That makes the tool a mid-reply move ("here is the summary" →
card → "and the detail is in section 3"), which is what the description steers
towards. Presenting several distinct files in one turn is safe — each gets its
own card, and the bridge dedupes the finalize fetch by path.

The tool itself does NOT emit the AG-UI event (deep agents don't stream the
custom channel — see ``harness.agui.normalizer``). It validates the file exists
under the conversation's output mount and returns a confirmation the model can
act on; the ``AGUIStreamNormalizer`` detects the ``present_artifact`` tool call
by name and synthesizes the ``PRESENT_ARTIFACT`` custom event (top-level agent
only). The bridge reads the referenced bytes back at finalize and persists them.

Bound **per run** (closes over this run's ``user_id`` + ``agent_slug`` +
``conversation_id``), so it can only ever reach this conversation's output dir.
"""
from __future__ import annotations

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger
from harness.filesystem import resolve_output_file

logger = get_logger(__name__)

_MAX_TITLE = 120
_MAX_SUMMARY = 300


class _PresentArtifactArgs(BaseModel):
    path: str = Field(
        description="Virtual path of the finished file to present, under "
        "'/conversation/output/' (e.g. '/conversation/output/q3_report.docx'). "
        "The file must already be written there with write_file."
    )
    title: str = Field(
        description="Short, human-friendly title for the deliverable shown to "
        "the user, e.g. 'Q3 Financial Report'."
    )
    summary: str = Field(
        default="",
        description="Optional one-line description of what the document contains.",
    )


def build_present_artifact_tool(
    *, user_id: str, agent_slug: str, conversation_id: str
) -> StructuredTool:
    """Return a ``present_artifact`` tool bound to this run's conversation."""

    def _present_artifact(path: str, title: str, summary: str = "") -> str:
        title = (title or "").strip()[:_MAX_TITLE]
        if not title:
            return "Could not present: 'title' is required."

        # Resolve + guard the path against the output mount. A path outside
        # output/ (or with an illegal segment) is a hard error the model should
        # fix, not a silent no-op.
        try:
            resolved = resolve_output_file(
                user_id=user_id,
                agent_slug=agent_slug,
                conversation_id=conversation_id,
                virtual_path=path,
            )
        except ValueError as exc:
            return f"Could not present: {exc}"

        if not resolved.is_file():
            return (
                f"Could not present: no file at {path!r}. Write the document to "
                "'/conversation/output/' with write_file first, then present it."
            )

        logger.info(
            "artifact_presented",
            "Agent designated an output file as a user-facing deliverable",
            agent_slug=agent_slug,
            conversation_id=conversation_id,
            filename=resolved.name,
        )
        return (
            f"'{title}' is now a document card in the conversation, which the "
            "user can open or download. Carry on in the same reply — whatever "
            "you write next appears below the card. Do not paste the document's "
            "contents into the chat."
        )

    return StructuredTool.from_function(
        func=_present_artifact,
        name="present_artifact",
        description=(
            "Hand a finished document to the user, right where you are in the "
            "reply. The moment you call this, a document card appears in the "
            "conversation at that point — the user can preview or download it, "
            "and anything you write afterwards continues below it. So use it "
            "mid-answer, as you go: hand over each document as it becomes "
            "ready and keep talking around it, rather than saving every "
            "delivery for a sign-off at the end. A file written to "
            "'/conversation/output/' stays invisible until you present it, so "
            "write it there first with write_file. Present as many separate "
            "documents as you genuinely produced — each gets its own card — "
            "but present a given file once, and only when it is finished: "
            "never scratch notes, intermediate drafts, or helper files. "
            "Provide the file 'path', a short 'title', and an optional "
            "one-line 'summary' shown under the title on the card."
        ),
        args_schema=_PresentArtifactArgs,
    )
