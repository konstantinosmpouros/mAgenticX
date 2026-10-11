"""Which slash commands exist, which an agent can run, and checking an invocation.

The general commands ship with the image (``builtin/<name>/COMMAND.md``) and are
the same for every agent. Every one is listed for every agent; one the agent
cannot run — ``/remember`` with memory off, ``/compact`` on a LangGraph agent —
carries the reason, so the menu can say why instead of hiding it. The same
check refuses it at run time: the bridge validates an invocation first, but this
service never trusts that alone.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

from harness.commands.spec import NAME_PATTERN, CommandFileError, CommandSpec, parse_command_md

_BUILTIN_DIR = Path(__file__).resolve().parent / "builtin"

#: Longest argument a command takes — the text after ``/name``. The bridge caps
#: the whole message too; this bound is the agents service's own.
MAX_ARGS_CHARS = 20_000

_REASONS = {
    "deep_agent": "This agent can't run this command.",
    "memory": "Memory is turned off in your settings.",
    "past_conversations": "Searching past conversations is turned off in your settings.",
}


class CommandRefused(ValueError):
    """An invocation this run will not apply; the message is safe to show the user."""


@dataclass(frozen=True)
class AgentFacts:
    """What a command may require of the agent, for one user's run."""

    deep_agent: bool
    memory: bool
    past_conversations: bool

    @classmethod
    def for_run(cls, agent_type: Any, context: Mapping[str, Any] | None) -> "AgentFacts":
        """From the agent's manifest type and the run context's preference flags
        (the same ``use_memory`` / ``search_past_convs`` the tools are gated on)."""
        ctx = context or {}
        return cls(
            deep_agent=agent_type == "deep agent",
            memory=bool(ctx.get("use_memory", True)),
            past_conversations=bool(ctx.get("search_past_convs", False)),
        )


@dataclass(frozen=True)
class CommandInvocation:
    """A checked invocation: the command and the user's argument text."""

    spec: CommandSpec
    args: str


@lru_cache(maxsize=1)
def builtin_commands() -> dict[str, CommandSpec]:
    """Every built-in command by name, read once. A bad file fails loudly at
    first use (and in the test that loads them all), never mid-run."""
    commands: dict[str, CommandSpec] = {}
    for path in sorted(_BUILTIN_DIR.glob("*/COMMAND.md")):
        try:
            spec = parse_command_md(path.read_text(encoding="utf-8"))
        except CommandFileError as exc:
            raise CommandFileError(f"{path.parent.name}/COMMAND.md: {exc}") from exc
        if spec.name != path.parent.name:
            raise CommandFileError(f"{path.parent.name}/COMMAND.md is named '{spec.name}'; the folder must match.")
        commands[spec.name] = spec
    return commands


def unavailable_reason(spec: CommandSpec, facts: AgentFacts) -> str | None:
    """Why ``spec`` cannot run for these facts, or ``None`` when it can."""
    for requirement in sorted(spec.requires):
        if not getattr(facts, requirement):
            return _REASONS[requirement]
    return None


def list_commands(facts: AgentFacts) -> list[tuple[CommandSpec, str | None]]:
    """Every command with its unavailable reason (``None`` = runnable), by name."""
    return [(spec, unavailable_reason(spec, facts)) for _, spec in sorted(builtin_commands().items())]


def resolve_invocation(raw: Any, facts: AgentFacts) -> CommandInvocation | None:
    """Check the run context's ``command`` — ``{name, args}`` — and return it, or
    ``None`` when the turn carries no command. Raises :class:`CommandRefused`."""
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise CommandRefused("That command isn't valid.")
    name, args = raw.get("name"), raw.get("args") or ""
    if not isinstance(name, str) or not NAME_PATTERN.match(name) or not isinstance(args, str):
        raise CommandRefused("That command isn't valid.")
    spec = builtin_commands().get(name)
    if spec is None:
        raise CommandRefused(f"/{name} isn't a command.")
    if spec.kind != "prompt":
        # An action is the app's to run (compact, open a panel); it never
        # reaches an agent turn.
        raise CommandRefused(f"/{name} runs in the app, not as a message.")
    reason = unavailable_reason(spec, facts)
    if reason:
        raise CommandRefused(reason)
    if len(args) > MAX_ARGS_CHARS:
        raise CommandRefused("The text after the command is too long.")
    return CommandInvocation(spec=spec, args=args)


def lookup_command(raw: Any) -> CommandSpec | None:
    """The spec a run context names, without re-checking it — for the agent build,
    after the stream route has already resolved the invocation."""
    if isinstance(raw, Mapping) and isinstance(raw.get("name"), str):
        spec = builtin_commands().get(raw["name"])
        return spec if spec is not None and spec.kind == "prompt" else None
    return None
