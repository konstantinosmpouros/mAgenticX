"""The agents service runtime, split by concern.

* ``abstractions`` — what an agent *is*: the base classes (``BaseAgent``,
  ``LangGraphAgent``, ``DeepAgent``) plus the configurable kinds (``AgentSpec``,
  ``YamlDeepAgent``, user-authored agents).
* ``agui`` — the AG-UI streaming protocol (emitter, events, normalizer).
* ``checkpointer`` — the durable LangGraph saver and copy-on-fork.
* ``filesystem`` — the per-(user, agent, conversation) workspace and its mounts.
* ``middlewares`` · ``personalization`` · ``skill_registry`` · ``tools``.

**This package deliberately re-exports nothing.** Import from the owning
subpackage (``from runtime.abstractions import DeepAgent``) so each symbol has
exactly one path. It previously re-exported the two agent base classes as a
shorthand, which left the same domain reachable two ways — and forced anything
needing both a base class and a spec to import from two levels at once. Keeping
the init import-free also stops it from pulling ``abstractions`` (and through it
``utils``) into every unrelated ``runtime.*`` import.
"""
