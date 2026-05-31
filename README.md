# @agent-dispatch/cli

[![npm](https://img.shields.io/npm/v/@agent-dispatch/cli.svg)](https://www.npmjs.com/package/@agent-dispatch/cli)
[![CI](https://github.com/agent-dispatch/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-dispatch/cli/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@agent-dispatch/cli.svg)](https://www.npmjs.com/package/@agent-dispatch/cli)

Command-line tools for configuring, validating, and testing AgentDispatch before you connect it to an MCP-capable lead agent.

## Install

```bash
npm install -g @agent-dispatch/cli
```

## Quickstart

Create a local config:

```bash
agentdispatch init \
  --region us-west-2 \
  --runtime-arn arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime \
  --protocol a2a
```

Validate local configuration and provider requirements:

```bash
agentdispatch doctor --config ./agentdispatch.config.json
```

Run an opt-in AWS live preflight before first AgentCore spawn:

```bash
agentdispatch doctor \
  --config ./agentdispatch.config.json \
  --aws-live \
  --runtime research-agent
```

This resolves AWS credentials through the standard AWS SDK chain and checks that the configured AgentCore runtime is reachable for session-mode dispatch.

Run a smoke-test task:

```bash
agentdispatch run \
  --config ./agentdispatch.config.json \
  --instruction "Summarize the current repository and identify follow-up work." \
  --provider aws \
  --account-profile dev-aws \
  --protocol a2a
```

Pass AgentCore runtime details without hand-writing `target.details` JSON:

```bash
agentdispatch run \
  --config ./agentdispatch.config.json \
  --instruction "Run the background research task in AgentCore." \
  --target-mode session \
  --runtime-arn arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime
```

For runtime provisioning, use `--target-mode runtime` with `--ecr-image-uri` and `--execution-role-arn`:

```bash
agentdispatch run \
  --config ./agentdispatch.config.json \
  --instruction "Run the background research task in a fresh AgentCore runtime." \
  --target-mode runtime \
  --ecr-image-uri 123456789012.dkr.ecr.us-west-2.amazonaws.com/agentdispatch-worker:latest \
  --execution-role-arn arn:aws:iam::123456789012:role/AgentDispatchAgentCoreRole \
  --env AGENT_FRAMEWORK=openclaw \
  --cleanup-after-task
```

Use `--env KEY=value` for runtime environment variables such as framework selectors, and add `--cleanup-after-task` when the runtime should be deleted after completion.

Inspect a task:

```bash
agentdispatch status task_...
agentdispatch logs task_...
agentdispatch result task_...
```

Continue an A2A cloud-agent session from the saved task metadata:

```bash
agentdispatch a2a-send task_... \
  --config ./agentdispatch.config.json \
  --text "Continue the investigation and focus on IAM findings."
```

## What the CLI is for

- Bootstrap `agentdispatch.config.json` without hand-writing JSON.
- Verify account profiles, adapter config, runtime mode, and protocol settings.
- Test `spawn_cloud_agent` outside a lead-agent environment.
- Test A2A follow-up against the cloud agent returned by an AgentCore task.
- Give developers a reproducible command path before wiring OpenClaw, Hermes Agent, Claude Code, or Codex through MCP.

## MCP handoff

After `doctor` passes, point your MCP client at the server:

```json
{
  "mcpServers": {
    "agentdispatch": {
      "command": "npx",
      "args": ["-y", "@agent-dispatch/mcp-server", "--config", "/absolute/path/agentdispatch.config.json"]
    }
  }
}
```

The lead agent can then call `spawn_cloud_agent` and receive task polling tools plus A2A cloud-agent metadata.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

See the [release workflow](https://github.com/agent-dispatch/cli/blob/main/docs/release.md) for npm Trusted Publisher setup, provenance publishing, and upstream package order.
