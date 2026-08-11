"""Declarative (YAML-defined) agents.

Everything for defining an agent by a folder (``agent.yaml`` + ``AGENT.md``)
instead of a Python subclass: the :class:`AgentSpec` schema, the generic
:class:`YamlDeepAgent` runtime, the image→volume :func:`seed_global_agents`
seeder, and the :func:`manifest_from_spec` / :func:`read_prompt` helpers. See
``docs/draft/platform-restructure-change-plan.md``.
"""
from runtime.declarative.agent_spec import AgentSpec, ModelSpec, SubAgentSpec, ToolRef
from runtime.declarative.utils import manifest_from_spec, read_prompt
from runtime.declarative.yaml_agent import YamlDeepAgent
from runtime.declarative.agent_seed import seed_global_agents

__all__ = [
    "AgentSpec",
    "ModelSpec",
    "SubAgentSpec",
    "ToolRef",
    "YamlDeepAgent",
    "seed_global_agents",
    "manifest_from_spec",
    "read_prompt",
]
