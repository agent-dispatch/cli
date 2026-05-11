# @agent-dispatch/cli

[![npm](https://img.shields.io/npm/v/@agent-dispatch/cli.svg)](https://www.npmjs.com/package/@agent-dispatch/cli)
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

Run a smoke-test task:

```bash
agentdispatch run \
  --config ./agentdispatch.config.json \
  --instruction "Summarize the current repository and identify follow-up work." \
  --provider aws \
  --account-profile dev-aws \
  --protocol a2a
```

Inspect a task:

```bash
agentdispatch status task_...
agentdispatch logs task_...
agentdispatch result task_...
```

## What the CLI is for

- Bootstrap `agentdispatch.config.json` without hand-writing JSON.
- Verify account profiles, adapter config, runtime mode, and protocol settings.
- Test `spawn_cloud_agent` outside a lead-agent environment.
- Give developers a reproducible command path before wiring OpenClaw, Hermes Agent, Claude Code, or Codex through MCP.

## MCP handoff

After `doctor` passes, point your MCP client at the server:

```json
{
  "mcpServers": {
    "agentdispatch": {
      "command": "npx",
      "args": ["@agent-dispatch/mcp-server", "--config", "/absolute/path/agentdispatch.config.json"]
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
