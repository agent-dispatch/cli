# Release Workflow

`@agent-dispatch/cli` is published after `@agent-dispatch/core`, `@agent-dispatch/sdk`, `@agent-dispatch/store-sqlite`, and `@agent-dispatch/adapter-aws-agentcore`.

## Prerequisites

- Publish upstream AgentDispatch packages for the target compatibility line.
- Configure npm Trusted Publisher for `agent-dispatch/cli` using workflow `.github/workflows/publish.yml`.
- Confirm the target package version has not already been published.

## Publish

Use the `Publish` GitHub Actions workflow with the target version. The workflow updates upstream AgentDispatch packages to latest compatible published versions, validates typecheck, tests, and build, then publishes through Trusted Publisher.
