from typing import Any

from deepagents import SubAgent

from runtime import DeepAgent
from core.settings import settings
from deep_agents.omni_agent.system_prompts import RESEARCHER_SYSTEM_PROMPT, WRITER_SYSTEM_PROMPT


HITL_GATED_TOOLS: dict[str, bool] = {
    # Filesystem mutations — anything that writes to disk goes through approval.
    "write_file": True,
    "edit_file": True,
    # Code execution — arbitrary shell / python is always user-approved.
    "execute": True,
    # Subagent delegation — researcher / writer hand-offs require approval so
    # the user can see the prompt before a model spends tokens on it.
    "task": True,
}


OMNI_INSTRUCTIONS = """\
# OmniAgent

You are OmniAgent, a general-purpose autonomous assistant capable of research, writing, analysis, and persistent file management.

## Core Responsibilities

- **Research** — gather, verify, and synthesize information from available sources.
- **Writing** — produce well-structured documents, reports, and summaries.
- **Analysis** — break down complex problems and provide actionable insights.
- **File Management** — persist important outputs to your store so they can be retrieved in future sessions.

## Working with Your Filesystem

You have three structurally-isolated virtual mounts:

- `/memories/AGENT.md` — durable cross-conversation memory about THIS user, shared with every deep agent they use. Read it at the start of every task. Update it via `edit_file` whenever the user shares a fact worth remembering across sessions (preferences, ongoing projects, communication style, key people).
- `/skills/` — the skills the user has enabled for you. Each subdirectory is a SKILL.md you can pull in on demand. Do NOT write to or edit files here; this is your skill library.
- `/conversation/` — this conversation's working area. All documents you create for the user (reports, summaries, drafts) belong here. Files written in *other* conversations are not visible here — use `/memories/AGENT.md` for things that should outlive this chat.

### File conventions

- Before starting a task, `ls /conversation/` to see what already exists in this chat and `read_file /memories/AGENT.md` for durable user context.
- Save final outputs under `/conversation/` with descriptive filenames: `/conversation/<topic>_<type>.md` (e.g. `/conversation/climate_change_report.md`).
- If the user references work from a previous conversation, you cannot reach those files directly — check `/memories/AGENT.md` for any pointers, or ask the user to re-share.

## Delegation

You have two specialist sub-agents. Delegate instead of doing everything yourself:

- `research(query)` — deep-dive a topic, look up facts, or gather sources.
- `write(instructions)` — format, polish, or produce structured written output.

## Behaviour

- On complex tasks: plan first, then act step by step.
- Always save significant outputs to `/conversation/` before responding.
- Be concise in chat but thorough in stored documents.
- Keep `/memories/AGENT.md` tight — prefer overwriting stale entries to appending forever.
"""


class OmniAgent(DeepAgent):
    """
    General-purpose autonomous agent with research, writing, and file-management
    capabilities.

    Demonstrates the full ``DeepAgent`` lifecycle:
    - ``instructions``         — static system prompt (class attribute)
    - ``/memories/AGENT.md``   — durable cross-agent user memory via CompositeBackend
    - ``/skills/``             — per-(user, agent) assigned skills, populated from
                                 the user's pool via the Skills tab Manage view
    - ``register_subagents()`` — declares researcher + writer sub-agents
    - ``register_agent()``     — calls ``build_deep_agent()`` (base assembler)
    """

    name = "omni-agent-v1"
    agent_id = "Omni-Agent v1"
    label = "Omni"
    version = "1.0.0"
    description = "General-purpose agent for research, writing, and file management"
    icon = "BrainCircuit"

    # Replaces the bundled <impl_dir>/AGENT.md template; loaded via
    # create_deep_agent(system_prompt=...) below.
    instructions = OMNI_INSTRUCTIONS

    # ------------------------------------------------------------------
    # Sub-agents
    # ------------------------------------------------------------------
    def register_subagents(self) -> list[SubAgent]:
        omni = settings.deep_agents.omni
        return [
            SubAgent(
                model=omni.researcher_model,
                name="researcher",
                description=(
                    "Deep-dives a topic, looks up facts, gathers and verifies "
                    "sources. Returns structured findings ready to act on."
                ),
                system_prompt=RESEARCHER_SYSTEM_PROMPT,
                tools=[],
            ),
            SubAgent(
                model=omni.writer_model,
                name="writer",
                description=(
                    "Formats, polishes, and produces structured written output. "
                    "Saves the final document to the store and returns the filename."
                ),
                system_prompt=WRITER_SYSTEM_PROMPT,
                tools=[],
            ),
        ]

    # ------------------------------------------------------------------
    # Main agent
    # ------------------------------------------------------------------
    def register_agent(self) -> Any:
        omni = settings.deep_agents.omni
        return self.build_deep_agent(
            model=omni.main_model,
            system_prompt=self.instructions,
            subagents=self.sub_agents,
            interrupt_on=HITL_GATED_TOOLS,
        )
