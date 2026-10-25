from typing import Any

from deepagents import SubAgent
from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT

from harness.abstractions import DeepAgent
from harness.abstractions.subagent_tree import SUBAGENTS_KEY, subagent
from core.settings import settings
from deep_agents.omni_agent.system_prompts import (
    OMNI_INSTRUCTIONS,
    RESEARCHER_SYSTEM_PROMPT,
    WRITER_SYSTEM_PROMPT,
)


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


def _helpers() -> list[dict[str, Any]]:
    """The general-purpose helpers each Omni sub-agent can delegate to.

    Every sub-agent may hand a self-contained piece of its work to a ``helper``
    (two levels below Omni), which may hand one more piece to a
    ``sub-helper`` (three levels below — the most nesting allows, so it does
    the work itself). Distinct names per level: a name may not repeat down a
    branch. Models and tools are inherited from the agent above; every
    hand-off still goes through the ``task`` approval gate.
    """
    prompt = GENERAL_PURPOSE_SUBAGENT["system_prompt"]
    return [
        subagent(
            "helper",
            (
                "A general-purpose helper for one self-contained piece of your task "
                "(looking something up, drafting a section, checking a result). Give it "
                "everything it needs in the description; it returns its result to you. "
                "It can split its own work once more."
            ),
            prompt,
            subagents=[
                subagent(
                    "sub-helper",
                    (
                        "A general-purpose helper for one small, self-contained piece of your "
                        "task. Give it everything it needs; it does the work itself and returns "
                        "the result."
                    ),
                    prompt,
                ),
            ],
        ),
    ]


class OmniAgent(DeepAgent):
    """
    General-purpose autonomous agent with research, writing, and file-management
    capabilities.

    Demonstrates the full ``DeepAgent`` lifecycle:
    - ``instructions``         — static system prompt (class attribute); the base
                                 appends the memory block when ``use_memory`` is on
    - ``/memories/AGENTS.md``  — per-(user, agent) memory index + ``entries/``,
                                 mounted only when ``use_memory`` is on
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

    # Static system prompt, loaded via create_deep_agent(system_prompt=...). The
    # base appends memory-usage instructions when use_memory is on — this prompt
    # itself stays memory-free so a memory-off run never advertises /memories/.
    instructions = OMNI_INSTRUCTIONS

    # Declared, not passed at register_agent() time: the Agents tab reports the
    # always-gated tools from the class, which it can read without building the
    # agent. Passing these as an argument made them invisible to that listing,
    # so the UI showed four of them as ungated and user-toggleable when every
    # call was in fact pausing for approval.
    hitl_gates = HITL_GATED_TOOLS

    # ------------------------------------------------------------------
    # Sub-agents
    # ------------------------------------------------------------------
    def register_subagents(self) -> list[SubAgent]:
        omni = settings.deep_agents.omni
        # deepagents' general-purpose sub-agent, declared here (same description
        # and prompt) so it too can delegate; the build adds it otherwise.
        general_purpose: dict[str, Any] = {
            **GENERAL_PURPOSE_SUBAGENT,
            "model": omni.main_model,
            SUBAGENTS_KEY: _helpers(),
        }
        if self.skills_paths:
            general_purpose["skills"] = list(self.skills_paths)
        return [
            general_purpose,
            SubAgent(
                model=omni.researcher_model,
                name="researcher",
                description=(
                    "Deep-dives a topic, looks up facts, gathers and verifies "
                    "sources. Returns structured findings ready to act on."
                ),
                system_prompt=RESEARCHER_SYSTEM_PROMPT,
                tools=[],
                **{SUBAGENTS_KEY: _helpers()},
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
                **{SUBAGENTS_KEY: _helpers()},
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
        )
