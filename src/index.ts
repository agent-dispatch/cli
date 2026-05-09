#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { RuntimeService, type AgentDispatchConfig } from "@agentdispatch/core";
import { AgentDispatchClient } from "@agentdispatch/sdk";
import { SqliteTaskStore } from "@agentdispatch/store-sqlite";
import { AwsAgentCoreAdapter } from "@agentdispatch/adapter-aws-agentcore";

const program = new Command();

program.name("agentdispatch").description("Provider-neutral agent task dispatcher").version("0.1.0");

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
    console.log(JSON.stringify(handle, null, 2));
  });

program.command("status").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
  console.log(JSON.stringify(await (await createClient(options.config)).getTaskStatus(taskId), null, 2));
});

program.command("logs").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
  const logs = await (await createClient(options.config)).getTaskLogs(taskId);
  process.stdout.write(logs.data);
});

program.command("result").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
  console.log(JSON.stringify(await (await createClient(options.config)).getTaskResult(taskId), null, 2));
});

program.command("cancel").argument("<taskId>").option("--config <path>", "Config file", "agentdispatch.config.json").action(async (taskId, options) => {
  console.log(JSON.stringify(await (await createClient(options.config)).cancelTask(taskId), null, 2));
});

void program.parseAsync();

async function createClient(configPath: string): Promise<AgentDispatchClient> {
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

async function loadConfig(path: string): Promise<AgentDispatchConfig> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as AgentDispatchConfig;
}
