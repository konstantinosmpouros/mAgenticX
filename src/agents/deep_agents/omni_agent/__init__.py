from typing import Any

from deepagents import create_deep_agent, SubAgent
from deepagents.backends import FilesystemBackend

from agent_runtime import DeepAgent
from core.settings import settings
from deep_agents.omni_agent.system_prompts import RESEARCHER_SYSTEM_PROMPT, WRITER_SYSTEM_PROMPT

class OmniAgent(DeepAgent):
    """
    General-purpose autonomous agent with research, writing, and file-management
    capabilities.

    Demonstrates the full ``DeepAgent`` lifecycle:
    - ``AGENT.md``             — loaded automatically via MemoryMiddleware
    - ``skills/*/SKILL.md``    — loaded automatically via SkillsMiddleware (progressive disclosure)
    - ``register_subagents()`` — declares researcher + writer sub-agents
    - ``register_agent()``     — wires everything into ``create_deep_agent``

    Storage strategy:
    - Uses ``FilesystemBackend`` rooted at the implementation directory so that
        ``AGENT.md`` and ``skills/`` are resolved from disk.
    - Override ``load_memory()`` in a subclass and swap in a ``StoreBackend``
        (or ``CompositeBackend``) inside ``register_agent()`` to enable
        cross-session persistence.
    """

    name = "omni-agent-v1"
    agent_id = "Omni-Agent v1"
    label = "Omni"
    version = "1.0.0"
    description = "General-purpose agent for research, writing, and file management"
    icon = "BrainCircuit"

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
        return create_deep_agent(
            model=omni.main_model,
            name=self.name,
            tools=self.tools,
            memory=self.agent_md_paths,
            skills=self.skills_paths,
            subagents=self.sub_agents,
            checkpointer=self.checkpointer,
            store=None,
            backend=FilesystemBackend(root_dir=self._impl_dir, virtual_mode=True),
            context_schema=self.context,
        )
