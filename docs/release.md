# Release Workflow

`@agentdispatch/cli` is published after `@agentdispatch/core`, `@agentdispatch/sdk`, `@agentdispatch/store-sqlite`, and `@agentdispatch/adapter-aws-agentcore`.

## Prerequisites

- Publish upstream AgentDispatch packages for the target compatibility line.
- Add an npm automation token as `NPM_TOKEN` in repository secrets.
- Replace bootstrap `file:../` package links with published package versions before the first registry release.

## Publish

Use the `Publish` GitHub Actions workflow with the target version. The workflow validates typecheck, tests, and build before publishing with npm provenance.
