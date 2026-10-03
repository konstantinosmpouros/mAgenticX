"""Remote skill sources (plan 30) — index daily, fetch on Add, verify everything.

* :mod:`.sources` — the allowlist and every gate a skill must pass. Policy, in
  code, so widening it goes through review.
* :mod:`.client` — the only outbound HTTP path: host allowlist on every
  redirect hop, a byte ceiling on every body, timeouts on every call.
* :mod:`.sync` — the daily pass that keeps ``skill_catalogue`` current. It is
  the whole catalogue: the platform no longer bundles skills of its own.
* :mod:`.fetch` — the Add-time download, pinned to a commit and checked file by
  file against it before anything is stored.
"""
from harness.skill_registry.remote.fetch import (
    RemoteSkillRefused,
    RemoteSkillUnavailable,
    fetch_remote_copy,
)
from harness.skill_registry.remote.sources import (
    SOURCES,
    RemoteSource,
    get_source,
    source_label,
    upstream_url,
)
from harness.skill_registry.remote.sync import (
    run_remote_skill_sync_loop,
    run_sync_pass,
)

__all__ = [
    "RemoteSkillRefused",
    "RemoteSkillUnavailable",
    "RemoteSource",
    "SOURCES",
    "fetch_remote_copy",
    "get_source",
    "run_remote_skill_sync_loop",
    "run_sync_pass",
    "source_label",
    "upstream_url",
]
