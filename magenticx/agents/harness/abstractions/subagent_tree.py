"""Sub-agents that have sub-agents of their own, for agents written in code.

A deep agent declares its sub-agents as ``deepagents.SubAgent`` dicts. One of
those dicts may carry a ``subagents`` list of further specs — the same shape,
any depth up to :data:`MAX_SUBAGENT_DEPTH` — and ``DeepAgent.build_deep_agent``
turns each such list into a ``task`` tool for that sub-agent (see
``DeepAgent._prepare_subagents``). The key is ours: deepagents never sees it.

A YAML agent declares the same tree in ``agent.yaml`` and gets it validated by
:class:`~harness.abstractions.agent_spec.AgentSpec`. A code agent has no schema,
so :func:`validate_subagent_tree` applies the same rules when the agent is
built — a mistake fails the build loudly rather than producing a sub-agent the
model can never reach, or one that delegates to itself.

Usage in a code agent::

    from harness.abstractions.subagent_tree import subagent

    def register_subagents(self):
        return [
            subagent(
                "researcher", "Finds and checks facts.", RESEARCHER_PROMPT,
                model="openai:gpt-4o",
                subagents=[subagent("fact-checker", "Verifies one claim.", CHECKER_PROMPT, tools=[])],
            ),
        ]
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from harness.abstractions.agent_spec import MAX_SUBAGENT_DEPTH

#: The key on a sub-agent spec that holds its own sub-agents.
SUBAGENTS_KEY = "subagents"


def subagent(
    name: str,
    description: str,
    system_prompt: str,
    *,
    model: Any = None,
    tools: Sequence[Any] | None = None,
    interrupt_on: Mapping[str, Any] | None = None,
    middleware: Sequence[Any] | None = None,
    subagents: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """A sub-agent spec, optionally with sub-agents of its own.

    Omitted values mean what they mean everywhere else: no ``model`` runs on the
    model of the agent above it, no ``tools`` inherits that agent's tools (an
    empty list means none beyond the built-in file and planning tools), and no
    ``interrupt_on`` inherits the run's approval gates.
    """
    spec: dict[str, Any] = {"name": name, "description": description, "system_prompt": system_prompt}
    if model is not None:
        spec["model"] = model
    if tools is not None:
        spec["tools"] = list(tools)
    if interrupt_on is not None:
        spec["interrupt_on"] = dict(interrupt_on)
    if middleware is not None:
        spec["middleware"] = list(middleware)
    if subagents:
        spec[SUBAGENTS_KEY] = list(subagents)
    return spec


def validate_subagent_tree(specs: Sequence[Any], *, max_depth: int = MAX_SUBAGENT_DEPTH) -> None:
    """Raise ``ValueError`` unless the sub-agent tree is buildable.

    The rules of ``AgentSpec`` for code-defined specs: at most ``max_depth``
    levels below the main agent, unique sibling names, no name repeated below
    itself, and no spec object nested inside itself. A compiled sub-agent
    (``runnable``) is opaque and cannot carry ``subagents``.
    """
    def check(level: Sequence[Any], above: tuple[str, ...], seen: frozenset[int]) -> None:
        depth = len(above) + 1
        names: list[str] = []
        for spec in level:
            if not isinstance(spec, Mapping):
                continue
            name = str(spec.get("name") or "")
            path = " > ".join((*above, name))
            if id(spec) in seen:
                raise ValueError(f"Sub-agent {path!r} contains itself; sub-agents cannot loop.")
            if depth > max_depth:
                raise ValueError(
                    f"Sub-agent {path!r} is {depth} levels below the agent; at most {max_depth} are allowed."
                )
            if name in above:
                raise ValueError(f"Sub-agent {path!r} repeats a name above it; sub-agents cannot loop.")
            if name in names:
                where = f"under {above[-1]!r}" if above else "of the agent"
                raise ValueError(f"Sub-agents {where} share a name: {name}.")
            names.append(name)
            children = spec.get(SUBAGENTS_KEY) or []
            if children and "runnable" in spec:
                raise ValueError(f"Compiled sub-agent {path!r} cannot declare sub-agents.")
            check(children, (*above, name), seen | {id(spec)})

    check(list(specs or []), (), frozenset())


__all__ = ["SUBAGENTS_KEY", "subagent", "validate_subagent_tree"]
