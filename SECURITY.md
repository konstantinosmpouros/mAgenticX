# Security Policy

## Reporting a Vulnerability

If you discover a security issue in mAgenticX, report it privately by email instead of opening a public GitHub issue.

Report vulnerabilities by email:

- `kostasbouros@hotmail.gr`

Use a clear subject line such as:

- `mAgenticX security report: <short summary>`

## What to Include

To help triage quickly, include:

- a short description of the issue
- the affected component or path
- reproduction steps
- any proof of concept, request payload, or screenshot
- the security impact you believe it has
- suggested remediation, if you have one
- your preferred contact details for follow-up

If the issue depends on configuration, deployment mode, or environment variables, include those details too.

## Supported Versions

This is a personal project, so support is best-effort and focused on the current codebase:

| Version | Supported |
| --- | --- |
| Latest code on the default branch | Best effort |
| Older snapshots, forks, and unmaintained deployments | No |

## Scope

This policy applies to vulnerabilities in this repository, including:

- the root deployment and Compose wiring
- `src/agentic_ui`
- `src/dialogue_bridge`
- `src/agents`
- `src/rag_service`
- `src/mcp_gateway`

Third-party services, external MCP servers, and upstream dependencies may need to be fixed in their own projects even when they affect this stack.

## Notes

- There is no formal SLA for replies or fixes.
- Valid, reproducible reports are much easier to act on than scanner output alone.
- If the issue comes from an upstream package or external service, the fix may need to happen there rather than in this repository.
