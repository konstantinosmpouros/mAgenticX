"""Agent abstractions — the base classes and the configurable agent kinds.

Everything that answers *what an agent is and how one is defined* lives here, so
adding an agent never means touching the runtime's other concerns (streaming,
checkpointing, filesystem, tools):

* :class:`BaseAgent` — identity, config, tool selection, manifest, error encoding.
* :class:`LangGraphAgent` — the ``StateGraph`` base for graph-shaped agents.
* :class:`DeepAgent` — the deepagents base: lifecycle hooks, workspace mounts,
  sub-agents, HITL.
* :class:`AgentSpec` (+ ``ModelSpec``/``SubAgentSpec``/``ToolRef``) — the schema
  that makes an agent *configurable* rather than coded.
* :class:`YamlDeepAgent` — one generic deep agent driven entirely by an
  ``AgentSpec``, so a folder of config is a working agent.
* :func:`seed_global_agents` — copies the image's platform agent folders onto the
  mounted volume at boot.
* the user-agent authoring surface (``validate_write`` / ``write_user_agent`` /
  ``list_user_agents`` / ``get_user_agent`` / ``delete_user_agent``) — the same
  spec, authored per user through the builder UI.

The shared helpers (``manifest_from_spec`` / ``read_prompt``) deliberately live in
``utils.declarative``, not here, so the registry discoverer can build a manifest
from a spec without importing the agent runtime at all.
"""
from runtime.abstractions.base_agent import AgentType, BaseAgent
from runtime.abstractions.langgraph_agent import LangGraphAgent
from runtime.abstractions.deep_agent import DeepAgent
from runtime.abstractions.agent_spec import AgentSpec, ModelSpec, SubAgentSpec, ToolRef
from runtime.abstractions.yaml_agent import YamlDeepAgent
from runtime.abstractions.agent_seed import seed_global_agents
from runtime.abstractions.user_agents import (
    AgentValidationError,
    delete_user_agent,
    get_user_agent,
    list_user_agents,
    validate_write,
    write_user_agent,
)

__all__ = [
    "AgentType",
    "BaseAgent",
    "LangGraphAgent",
    "DeepAgent",
    "AgentSpec",
    "ModelSpec",
    "SubAgentSpec",
    "ToolRef",
    "YamlDeepAgent",
    "seed_global_agents",
    "AgentValidationError",
    "validate_write",
    "list_user_agents",
    "get_user_agent",
    "write_user_agent",
    "delete_user_agent",
]
