"""Async sub-agents (plan 41): every sub-agent runs as a background task.

* ``token``        — the signed task-launch token: who is calling ``/ap``;
* ``specs``        — graph ids, tree paths, the ``AsyncSubAgent`` specs;
* ``client``       — the deepagents middleware, served in process;
* ``notification`` — the one place that knows the notification message shape;
* ``store``        — ``async_tasks`` / ``async_task_runs`` in ``agent_runtime``;
* ``events``       — the Redis streams the bridge reads;
* ``metrics``      — the log-derived gauge and histogram;
* ``runner``       — runs, settles and wakes tasks.

Deliberately exports nothing: ``harness.abstractions.deep_agent`` imports the
light modules directly, and the runner (which imports the agent registry)
must never be pulled in by an import of this package, or the two would cycle.
"""
