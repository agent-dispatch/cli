#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  RuntimeService,
  getDefaultRuntimeProfile,
  getRuntimeProfile,
  validateConfig,
  type AgentDispatchConfig,
  type DispatchRequest,
  type TaskStatus
} from "@agentdispatch/core";
import { AgentDispatchClient } from "@agentdispatch/sdk";
import { SqliteTaskStore } from "@agentdispatch/store-sqlite";
import { AwsAgentCoreAdapter } from "@agentdispatch/adapter-aws-agentcore";

export function buildProgram(output: Pick<Console, "log" | "error"> = console): Command {
  const program = new Command();

  program.name("agentdispatch").description("Provider-neutral agent task dispatcher").version("0.1.0");

  program
    .command("init")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .option("--runtime-arn <arn>", "Existing AWS AgentCore runtime ARN", "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/example")
    .option("--region <region>", "AWS region", "us-west-2")
    .action(async (options) => {
      const config = sampleConfig(options.region, options.runtimeArn);
      await writeFile(options.config, `${JSON.stringify(config, null, 2)}\n`);
      output.log(`Wrote ${options.config}`);
    });

  program
    .command("providers")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .action(async (options) => {
      output.log(JSON.stringify((await createClient(options.config)).listProviders(), null, 2));
    });

  program
    .command("capabilities")
    .option("--provider <provider>")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .action(async (options) => {
      output.log(JSON.stringify((await createClient(options.config)).listCapabilities(options.provider), null, 2));
    });

  program
    .command("accounts")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .action(async (options) => {
      output.log(JSON.stringify((await createClient(options.config)).listAccountProfiles(), null, 2));
    });

  program
    .command("run")
    .option("--runtime <name>", "Named runtime profile")
    .option("--provider <provider>")
    .option("--account-profile <name>")
    .option("--capability <capability>")
    .option("--task-type <type>")
    .option("--target-mode <mode>", "Target mode", "session")
    .option("--target-details-json <json>", "JSON object merged into target.details")
    .option("--instruction <text>")
    .option("--command <command>")
    .option("--framework <name>", "Worker-side agent framework name")
    .option("--context-json <json>", "JSON object passed as input.context")
    .option("--runtime-tools-json <json>", "JSON object passed as input.runtime_tools")
    .option("--wait", "Poll until task reaches a terminal status")
    .option("--poll-interval-ms <ms>", "Wait polling interval", "1000")
    .option("--timeout-ms <ms>", "Maximum wait time", "600000")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .action(async (options) => {
      const config = await loadConfig(options.config);
      const client = await createClientFromConfig(config);
      const request = createDispatchRequest(config, options);
      const handle = await client.dispatchTask(request);
      output.log(JSON.stringify(handle, null, 2));
      if (options.wait) {
        const result = await waitForTask(client, handle.taskId, Number(options.pollIntervalMs), Number(options.timeoutMs));
        output.log(JSON.stringify(result, null, 2));
      }
    });

  program.command("status").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
    output.log(JSON.stringify(await (await createClient(options.config)).getTaskStatus(taskId), null, 2));
  });

  program.command("logs").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
    const logs = await (await createClient(options.config)).getTaskLogs(taskId);
    output.log(logs.data);
  });

  program.command("result").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
    output.log(JSON.stringify(await (await createClient(options.config)).getTaskResult(taskId), null, 2));
  });

  program.command("cancel").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
    output.log(JSON.stringify(await (await createClient(options.config)).cancelTask(taskId), null, 2));
  });

  return program;
}

export async function createClient(configPath: string): Promise<AgentDispatchClient> {
  const config = await loadConfig(configPath);
  return createClientFromConfig(config);
}

export async function createClientFromConfig(config: AgentDispatchConfig): Promise<AgentDispatchClient> {
  const stateDir = config.stateDir ?? ".agentdispatch";
  const store = new SqliteTaskStore({ stateDir });
  await store.ensureReady();
  const adapters = Object.entries(config.backends)
    .filter(([, backend]) => backend.adapter === "aws-agentcore")
    .map(([, backend]) => {
      const account = config.accounts[backend.account];
      return new AwsAgentCoreAdapter({
        account: { name: backend.account, ...account },
        region: account.region ?? String(backend.details?.region ?? process.env.AWS_REGION ?? "us-east-1"),
        runtimeArn: String(backend.details?.runtimeArn ?? process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ARN ?? ""),
        qualifier: String(backend.details?.qualifier ?? "DEFAULT"),
        defaultExecutionRoleArn: backend.details?.defaultExecutionRoleArn ? String(backend.details.defaultExecutionRoleArn) : undefined,
        deleteRuntimeOnCompletion: backend.details?.deleteRuntimeOnCompletion !== false
      });
    });
  return new AgentDispatchClient(new RuntimeService({ config, store, adapters }));
}

export async function loadConfig(path: string): Promise<AgentDispatchConfig> {
  const raw = await readFile(path, "utf8");
  const config = JSON.parse(raw) as AgentDispatchConfig;
  assertValidConfig(config);
  return config;
}

export function sampleConfig(region: string, runtimeArn: string): AgentDispatchConfig {
  return {
    stateDir: ".agentdispatch",
    accounts: {
      "dev-aws": {
        provider: "aws",
        region,
        credentialSource: "aws-sdk-default"
      }
    },
    backends: {
      "aws-agentcore": {
        provider: "aws",
        capability: "agent-runtime",
        adapter: "aws-agentcore",
        account: "dev-aws",
        details: {
          runtimeArn,
          qualifier: "DEFAULT"
        }
      }
    },
    runtimes: {
      "research-agent": {
        provider: "aws",
        account: "dev-aws",
        capability: "agent-runtime",
        backend: "aws-agentcore",
        target: { mode: "session" },
        framework: "strands"
      }
    },
    defaults: {
      runtime: "research-agent"
    }
  };
}

export function createDispatchRequest(config: AgentDispatchConfig, options: Record<string, any>): DispatchRequest {
  const runtimeProfile = resolveRuntimeProfile(config, options.runtime);
  const provider = options.provider ?? runtimeProfile?.provider ?? config.defaults?.provider;
  const accountProfile = options.accountProfile ?? runtimeProfile?.account ?? config.defaults?.accountProfile;
  const capability = options.capability ?? runtimeProfile?.capability ?? config.defaults?.capability;
  const backend = runtimeProfile?.backend ?? config.defaults?.backend;
  const taskType = options.taskType ?? (options.command ? "command.run" : "agent.run");
  if (!provider || !accountProfile || !capability) {
    throw new Error("Missing provider/account/capability. Pass CLI options or configure defaults.runtime in agentdispatch.config.json.");
  }
  return {
    provider,
    accountProfile,
    capability,
    backend,
    taskType,
    target: {
      mode: options.targetMode ?? runtimeProfile?.target?.mode ?? config.defaults?.targetMode ?? "session",
      details: mergeRecords(runtimeProfile?.target?.details, parseJsonObjectOption(options.targetDetailsJson, "target-details-json"))
    },
    input: {
      instruction: options.instruction,
      command: options.command,
      framework: options.framework ?? runtimeProfile?.framework ?? config.defaults?.framework,
      context: parseJsonObjectOption(options.contextJson, "context-json"),
      runtime_tools: mergeRecords(
        config.defaults?.runtimeTools,
        runtimeProfile?.runtimeTools,
        parseJsonObjectOption(options.runtimeToolsJson, "runtime-tools-json")
      )
    }
  };
}

function resolveRuntimeProfile(config: AgentDispatchConfig, runtimeName?: string) {
  if (!runtimeName) return getDefaultRuntimeProfile(config);
  const profile = getRuntimeProfile(config, runtimeName);
  if (!profile) throw new Error(`Runtime profile ${runtimeName} was not found.`);
  return profile;
}

async function waitForTask(client: AgentDispatchClient, taskId: string, pollIntervalMs: number, timeoutMs: number) {
  const startedAt = Date.now();
  let cursor = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    const logs = await client.getTaskLogs(taskId, cursor);
    cursor = logs.nextCursor;
    if (logs.data) process.stdout.write(logs.data);
    const task = await client.getTaskStatus(taskId);
    if (isTerminal(task.status)) {
      return client.getTaskResult(taskId);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for task ${taskId}.`);
}

function isTerminal(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function parseJsonObjectOption(value: string | undefined, name: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function mergeRecords(...records: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...records.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void buildProgram().parseAsync();
}

function assertValidConfig(config: AgentDispatchConfig): void {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid AgentDispatch config:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}
