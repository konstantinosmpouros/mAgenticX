from typing import Any

from deepagents import SubAgent

from runtime import DeepAgent
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
