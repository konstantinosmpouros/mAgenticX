"""Agent tool: designate a finished file as a user-facing deliverable.

The single explicit act that promotes ONE document out of the agent's scratch
and helper files into something the user actually receives. Everything an agent
(or its sub-agents) writes to ``/conversation/output/`` stays invisible; only a
file passed to ``present_artifact`` is surfaced — as a live artifact card during
the run and, once the run finalizes, as a downloadable/previewable attachment on
the assistant message.

The tool itself does NOT emit the AG-UI event (deep agents don't stream the
custom channel — see ``runtime.agui.normalizer``). It validates the file exists
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
from runtime.filesystem import resolve_output_file

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
            f"Presented '{title}' to the user. The document is now attached to "
            "your reply — do not paste its full contents into the chat."
        )

    return StructuredTool.from_function(
        func=_present_artifact,
        name="present_artifact",
        description=(
            "Hand a finished document to the user. Call this ONCE for each final "
            "deliverable you want the user to receive (a report, export, or "
            "written document) after you have saved it under "
            "'/conversation/output/' with write_file. The file is shown to the "
            "user as a downloadable, previewable attachment on your reply. Do "
            "NOT present scratch notes, intermediate drafts, or helper files — "
            "only the finished artifact(s). Provide the file 'path', a short "
            "'title', and an optional one-line 'summary'."
        ),
        args_schema=_PresentArtifactArgs,
    )
