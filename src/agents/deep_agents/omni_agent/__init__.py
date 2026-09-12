from typing import Any

from deepagents import SubAgent

from harness.abstractions import DeepAgent
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
        )
