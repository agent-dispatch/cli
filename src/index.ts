#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { RuntimeService, validateConfig, type AgentDispatchConfig } from "@agentdispatch/core";
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
    .requiredOption("--provider <provider>")
    .requiredOption("--account-profile <name>")
    .requiredOption("--capability <capability>")
    .requiredOption("--task-type <type>")
    .option("--target-mode <mode>", "Target mode", "session")
    .option("--instruction <text>")
    .option("--command <command>")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .action(async (options) => {
      const client = await createClient(options.config);
      const handle = await client.dispatchTask({
        provider: options.provider,
        accountProfile: options.accountProfile,
        capability: options.capability,
        taskType: options.taskType,
        target: { mode: options.targetMode },
        input: { instruction: options.instruction, command: options.command }
      });
      output.log(JSON.stringify(handle, null, 2));
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
    defaults: {
      provider: "aws",
      accountProfile: "dev-aws",
      capability: "agent-runtime",
      backend: "aws-agentcore"
    }
  };
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
