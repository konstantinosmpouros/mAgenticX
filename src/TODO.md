# TODO

## General

- Consider using a centralized logging solution like ELK or Datadog or loki with Grafana for better observability.

## New Features

- Projects / Workspaces: group related conversations, files, agents, tools, preferences, and instructions into persistent workspaces for long-running work.
- Deep Research mode: run longer multi-step research workflows with source citations, confidence notes, step traces, and exportable reports.
- Scheduled Tasks: let users create one-off or recurring agent jobs that run later, complete while the user is offline, and notify them with results.
- Artifacts / Canvas: add an editable side workspace for generated reports, markdown docs, code, tables, diagrams, JSON configs, and other reusable outputs.
- Agent run timeline: make planning, retrieval, tool calls, verification, and final-answer steps visible as a polished timeline for each agent run. Use this for the approval of a [HITL Event](https://ai-sdk.dev/elements/components/confirmation) or create a custom one. This can be used for the agentic chat stream feel as [actions](https://elements.ai-sdk.dev/components/task) or [this one](https://elements.ai-sdk.dev/components/tool). Also cause we are detached from the ui in the runtime we need to modify the planning card to be per conversation that is actively streaming and not in general.

## Agents

- Update the retrieval process and the whole RAG pipelines so that it will be like an mcp tool calling.
- Add end-to-end file (no image) attachment support in inference, including deep-agent passthrough and LangGraph input normalization/parsing for file parts.

## Dialogue Bridge

- Add the pgvector in order to have an embedding for each conversation and then we can use this embedding to find the most relevant conversations for a given query, this will be useful for the retrieval process and memory across chats.
- The inference needs to be transferred into Redis in order to be better. This will allow us to have a better performance and also we can have a better way to handle the streaming of the messages and the interactions with the UI without having to worry about a thousand calls to the database.

## Agentic UI

- Chart can be visualized with [shadcn/charts](https://www.shadcn.io/charts) and the agent can have a custom tool like the todo tool in order to represent the chart and create a custom AGUI event for the interaction with the chart.
- I think the best way to implement an agentic UI is to have all the agui event for every message (raw event list) and then upon read a past message to have a parser that will parse the raw event list and create the final UI for that message, this way we can have a more flexible and powerful way to create the UI for each message and also we can have a better control over the state of the UI and the interactions with it. This will also allow us to have a better way to handle the streaming of the messages and the interactions with the UI without having to worry about the state of the UI at any given time. Also the chain of thought if we can change the icon is the perfect task drop down
