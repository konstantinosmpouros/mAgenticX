# TODO

## General

- Consider using a centralized logging solution like ELK or Datadog or loki with Grafana for better observability.

## Security

- Secure the agents from prompt injection by implementing input filtering / guardrails before requests reach the agents.

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

## Agentic UI

- Use [shadcn/ui](https://www.shadcn.io/components) for a more polished and consistent design across the app. This will also help with accessibility and responsiveness.
- Chart can be visualized with [shadcn/charts](https://www.shadcn.io/charts) and the agent can have a custom tool like the todo tool in order to represent the chart and create a custom AGUI event for the interaction with the chart.
- I think the best way to implement an agentic UI is to have all the agui event for every message (raw event list) and then upon read a past message to have a parser that will parse the raw event list and create the final UI for that message, this way we can have a more flexible and powerful way to create the UI for each message and also we can have a better control over the state of the UI and the interactions with it. This will also allow us to have a better way to handle the streaming of the messages and the interactions with the UI without having to worry about the state of the UI at any given time. Also the chain of thought if we can change the icon is the perfect task drop down

## Bugs

- When changing to voice mode the transition in bad in the input bar actually the transition.
- The mermaid diagrams, code blocks are not rendering according to the browser size, we need to make it responsive. This problem is more extensive and l mean that the user messages as well are not showing if the width of the browser is too small, we need to make the whole chat body responsive and adapt to different screen sizes or appear a horizontal scrollbar.
- In the hr policies agent in the detached inference l got a "stream observer lost" error and the agent stopped working, we need to investigate this issue and fix it.
- The rate limit of inference per user per minute should show in the UI a more user-friendly message instead of just showing an error, we can show a message like "You have reached the maximum number of agent runs per minute, please wait a few seconds and try again." or something like that.
