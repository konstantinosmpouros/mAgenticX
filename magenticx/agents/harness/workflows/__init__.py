"""The workflow engine: a workflow is a LangGraph graph described as data.

A ``WorkflowSpec`` (``spec.py``) declares inputs, state fields with reducers,
nodes from the closed catalogue (``nodes/``) and the edges between them. The
validator (``validator.py``) holds it to the graph rules, the compiler
(``compiler.py``) turns it into a ``StateGraph`` over the durable checkpointer,
and the runner (``runner.py``) streams a run as AG-UI frames, each stamped with
the run envelope (``events.py``) so the UI can replay it node by node. Nodes
exchange data only through path templates (``templating.py``) and branch only
on structured rules (``rules.py``) — there is no expression evaluation
anywhere. Definitions, versions and persisted state live in ``agent_runtime``
(``store.py``).

A workflow is not an agent and a run of it is not a conversation.

Nothing is re-exported here on purpose: the store is imported at boot by the
checkpointer bootstrap, and must not drag in the node catalogue (and through
it the MCP and tool modules). Import the module you need.
"""
