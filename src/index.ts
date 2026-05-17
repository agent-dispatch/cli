#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  ListAgentRuntimesCommand
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  RuntimeService,
  getDefaultRuntimeProfile,
  getRuntimeProfile,
  listRuntimeProfiles,
  validateConfig,
  type AgentDispatchConfig,
  type DispatchRequest,
  type TaskRecord,
  type TaskStatus
} from "@agent-dispatch/core";
import { AgentDispatchClient } from "@agent-dispatch/sdk";
import { SqliteTaskStore } from "@agent-dispatch/store-sqlite";
import { AwsAgentCoreAdapter, sendAwsAgentCoreA2AMessage, type AwsAgentCoreA2AMessage, type AwsAgentCoreA2AResult } from "@agent-dispatch/adapter-aws-agentcore";

export interface CliOutput {
  log(value: string): void;
  error(value: string): void;
  write?(value: string): void;
}

const PLACEHOLDER_RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000:1";

export function buildProgram(output: CliOutput = console): Command {
  const program = new Command();

  program.name("agentdispatch").description("Provider-neutral agent task dispatcher").version(readPackageVersion());

  program
    .command("init")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .option("--runtime-arn <arn>", "Existing AWS AgentCore runtime ARN")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--protocol <protocol>", "AgentCore runtime protocol", "a2a")
    .action(async (options) => {
      const config = sampleConfig(options.region, options.runtimeArn, options.protocol);
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
    .command("doctor")
    .description("Validate AgentDispatch config before dispatching work")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .option("--aws-live", "Run AWS AgentCore live preflight checks")
    .option("--runtime <name>", "Runtime profile to use for live checks; defaults to defaults.runtime")
    .option("--json", "Emit JSON output")
    .action(async (options) => {
      const config = await loadConfig(options.config);
      const report = options.awsLive
        ? await createDoctorReportWithLiveChecks(config, { runtime: options.runtime })
        : createDoctorReport(config);
      if (options.json) {
        output.log(JSON.stringify(report, null, 2));
        return;
      }
      output.log(formatDoctorReport(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    });

  program
    .command("run")
    .option("--runtime <name>", "Named runtime profile")
    .option("--provider <provider>")
    .option("--account-profile <name>")
    .option("--capability <capability>")
    .option("--task-type <type>")
    .option("--target-mode <mode>", "Target mode")
    .option("--protocol <protocol>", "Runtime protocol such as a2a, http, mcp, or ag-ui")
    .option("--runtime-arn <arn>", "Existing AWS AgentCore runtime ARN for session mode")
    .option("--ecr-image-uri <uri>", "ECR image URI used to create an AgentCore runtime in runtime mode")
    .option("--execution-role-arn <arn>", "IAM execution role ARN used to create an AgentCore runtime in runtime mode")
    .option("--environment-json <json>", "JSON object merged into target.details.environmentVariables")
    .option("--env <key=value>", "Environment variable for runtime mode; repeatable", collectOption, [])
    .option("--cleanup-after-task", "Delete runtime-mode AgentCore resources after the task, including A2A runtimes")
    .option("--target-details-json <json>", "JSON object merged into target.details")
    .option("--instruction <text>")
    .option("--command <command>")
    .option("--framework <name>", "Worker-side agent framework name")
    .option("--model-json <json>", "JSON object passed as input.model")
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
        const result = await waitForTask(client, handle.taskId, Number(options.pollIntervalMs), Number(options.timeoutMs), output);
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

  program
    .command("a2a-send")
    .description("Send an A2A message to a spawned cloud agent using the task's cloudAgent metadata")
    .argument("<taskId>")
    .requiredOption("--text <text>", "Text message to send")
    .option("--metadata-json <json>", "JSON metadata object sent with the A2A message")
    .option("--config <path>", "Config file", "agentdispatch.config.json")
    .action(async (taskId, options) => {
      const client = await createClient(options.config);
      const task = await client.getTaskStatus(taskId);
      const result = await sendA2AFollowUpFromTask(task, {
        text: options.text,
        metadata: parseJsonObjectOption(options.metadataJson, "metadata-json")
      });
      output.log(JSON.stringify(result, null, 2));
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
        protocol: optionalString(backend.details?.protocol ?? process.env.AGENTDISPATCH_AGENTCORE_PROTOCOL),
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

export function sampleConfig(region: string, runtimeArn?: string, protocol = "a2a"): AgentDispatchConfig {
  const details: Record<string, unknown> = { qualifier: "DEFAULT", protocol };
  if (runtimeArn) details.runtimeArn = runtimeArn;
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
        details
      }
    },
    runtimes: {
      "research-agent": {
        provider: "aws",
        account: "dev-aws",
        capability: "agent-runtime",
        backend: "aws-agentcore",
        protocol,
        target: { mode: "session", protocol },
        framework: "strands",
        model: { provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet" }
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
  const protocol = options.protocol ?? runtimeProfile?.protocol ?? runtimeProfile?.target?.protocol ?? config.defaults?.protocol;
  if (!provider || !accountProfile || !capability) {
    throw new Error("Missing provider/account/capability. Pass CLI options or configure defaults.runtime in agentdispatch.config.json.");
  }
  if (taskType === "command.run" && !options.command) {
    throw new Error("Pass --command when dispatching command.run tasks.");
  }
  if (taskType === "agent.run" && !options.instruction) {
    throw new Error("Pass --instruction when dispatching agent.run tasks.");
  }
  if (options.command && options.instruction && !options.taskType) {
    throw new Error("Pass either --instruction or --command, or set --task-type explicitly.");
  }
  return {
    provider,
    accountProfile,
    capability,
    backend,
    taskType,
    target: {
      mode: options.targetMode ?? runtimeProfile?.target?.mode ?? config.defaults?.targetMode ?? "session",
      protocol,
      details: mergeRecords(
        runtimeProfile?.target?.details,
        createTargetDetailsFromOptions(options),
        parseJsonObjectOption(options.targetDetailsJson, "target-details-json")
      )
    },
    input: {
      instruction: options.instruction,
      command: options.command,
      protocol,
      framework: options.framework ?? runtimeProfile?.framework ?? config.defaults?.framework,
      model: parseJsonObjectOption(options.modelJson, "model-json") ?? runtimeProfile?.model ?? config.defaults?.model,
      context: parseJsonObjectOption(options.contextJson, "context-json"),
      runtime_tools: mergeRecords(
        config.defaults?.runtimeTools,
        runtimeProfile?.runtimeTools,
        parseJsonObjectOption(options.runtimeToolsJson, "runtime-tools-json")
      )
    }
  };
}

function createTargetDetailsFromOptions(options: Record<string, any>): Record<string, unknown> | undefined {
  return mergeRecords(
    stringRecord("runtimeArn", options.runtimeArn),
    stringRecord("ecrImageUri", options.ecrImageUri),
    stringRecord("executionRoleArn", options.executionRoleArn),
    environmentVariablesRecord(options),
    options.cleanupAfterTask ? { cleanupAfterTask: true } : undefined
  );
}

export async function sendA2AFollowUpFromTask(
  task: TaskRecord,
  message: AwsAgentCoreA2AMessage,
  sender: typeof sendAwsAgentCoreA2AMessage = sendAwsAgentCoreA2AMessage
): Promise<AwsAgentCoreA2AResult> {
  if (!task.cloudAgent) {
    throw new Error(`Task ${task.id} does not include cloudAgent metadata.`);
  }
  if (task.cloudAgent.provider !== "aws" || task.cloudAgent.backend !== "aws-agentcore") {
    throw new Error(`Task ${task.id} cloudAgent is ${task.cloudAgent.provider}/${task.cloudAgent.backend}; only aws/aws-agentcore is supported by this CLI command.`);
  }
  if (task.cloudAgent.protocol !== "a2a") {
    throw new Error(`Task ${task.id} cloudAgent protocol is ${task.cloudAgent.protocol}, not a2a.`);
  }
  return sender(task.cloudAgent, message);
}

export interface DoctorReport {
  ok: boolean;
  accounts: number;
  backends: number;
  runtimes: number;
  defaultRuntime?: string;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
}

export interface AwsLiveDoctorOptions {
  runtime?: string;
  checker?: AwsLivePreflightChecker;
}

export interface AwsLiveCheckInput {
  runtimeName: string;
  region: string;
  mode: string;
  runtimeArn?: string;
}

export interface AwsLiveCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export type AwsLivePreflightChecker = (input: AwsLiveCheckInput) => Promise<AwsLiveCheck[]>;

export function createDoctorReport(config: AgentDispatchConfig): DoctorReport {
  const checks: DoctorReport["checks"] = [];
  const accounts = Object.keys(config.accounts).length;
  const backends = Object.keys(config.backends).length;
  const runtimes = listRuntimeProfiles(config);

  checks.push({
    name: "accounts",
    status: accounts > 0 ? "pass" : "fail",
    message: accounts > 0 ? `${accounts} account profile(s) configured.` : "No account profiles configured."
  });
  checks.push({
    name: "backends",
    status: backends > 0 ? "pass" : "fail",
    message: backends > 0 ? `${backends} backend(s) configured.` : "No backends configured."
  });
  checks.push({
    name: "default-runtime",
    status: config.defaults?.runtime ? "pass" : "warn",
    message: config.defaults?.runtime
      ? `Default runtime is ${config.defaults.runtime}.`
      : "No defaults.runtime configured; agents must pass routing fields explicitly."
  });

  for (const [name, backend] of Object.entries(config.backends)) {
    if (backend.adapter !== "aws-agentcore") continue;
    const runtimeArn = optionalString(backend.details?.runtimeArn ?? process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ARN);
    const hasPlaceholderRuntimeArn = runtimeArn === PLACEHOLDER_RUNTIME_ARN;
    checks.push({
      name: `backend.${name}.runtimeArn`,
      status: runtimeArn && !hasPlaceholderRuntimeArn ? "pass" : "warn",
      message: runtimeArn
        ? hasPlaceholderRuntimeArn
          ? `AWS AgentCore backend ${name} still uses the sample placeholder runtimeArn; session mode dispatch will fail until a real ARN is configured.`
          : `AWS AgentCore backend ${name} has a runtime ARN for session mode.`
        : `AWS AgentCore backend ${name} has no runtimeArn; session mode dispatch will fail unless AGENTDISPATCH_AGENTCORE_RUNTIME_ARN is set.`
    });
    const account = config.accounts[backend.account];
    checks.push({
      name: `backend.${name}.credentials`,
      status: account?.credentialSource ? "pass" : "warn",
      message: account?.credentialSource
        ? `AWS credentials come from ${account.credentialSource}.`
        : `Backend ${name} account has no credentialSource.`
    });
  }

  for (const runtime of runtimes) {
    const backend = config.backends[runtime.backend];
    checks.push({
      name: `runtime.${runtime.name}`,
      status: backend ? "pass" : "fail",
      message: backend
        ? `Runtime ${runtime.name} routes ${runtime.provider}/${runtime.capability}/${runtime.target?.mode ?? "session"}/${runtime.protocol ?? runtime.target?.protocol ?? "http"} through ${runtime.backend}.`
        : `Runtime ${runtime.name} references missing backend ${runtime.backend}.`
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    accounts,
    backends,
    runtimes: runtimes.length,
    defaultRuntime: config.defaults?.runtime,
    checks
  };
}

export async function createDoctorReportWithLiveChecks(
  config: AgentDispatchConfig,
  options: AwsLiveDoctorOptions = {}
): Promise<DoctorReport> {
  const report = createDoctorReport(config);
  const runtimes = selectAwsLiveRuntimeProfiles(config, options.runtime);
  if (runtimes.length === 0) {
    report.checks.push({
      name: "aws.live",
      status: "warn",
      message: options.runtime
        ? `Runtime profile ${options.runtime} was not found or does not route to aws-agentcore.`
        : "No AWS AgentCore runtime profile is configured for live checks."
    });
    return refreshDoctorReportStatus(report);
  }

  const checker = options.checker ?? checkAwsAgentCoreLive;
  for (const runtime of runtimes) {
    const backend = config.backends[runtime.backend];
    const account = config.accounts[runtime.account];
    const region = account?.region ?? optionalString(backend?.details?.region) ?? process.env.AWS_REGION ?? "us-east-1";
    const mode = runtime.target?.mode ?? config.defaults?.targetMode ?? "session";
    const runtimeArn = optionalString(runtime.target?.details?.runtimeArn) ??
      optionalString(backend?.details?.runtimeArn) ??
      process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ARN;

    try {
      report.checks.push(...await checker({ runtimeName: runtime.name, region, mode, runtimeArn }));
    } catch (error) {
      report.checks.push({
        name: `aws.${runtime.name}.live`,
        status: "fail",
        message: `AWS AgentCore live preflight failed: ${formatErrorMessage(error)}`
      });
    }
  }

  return refreshDoctorReportStatus(report);
}

export async function checkAwsAgentCoreLive(input: AwsLiveCheckInput): Promise<AwsLiveCheck[]> {
  const checks: AwsLiveCheck[] = [];
  const client = new BedrockAgentCoreControlClient({ region: input.region });
  try {
    await resolveAwsCredentials(client);
    checks.push({
      name: `aws.${input.runtimeName}.credentials`,
      status: "pass",
      message: `AWS credentials resolved for region ${input.region}.`
    });
  } catch (error) {
    return [{
      name: `aws.${input.runtimeName}.credentials`,
      status: "fail",
      message: `AWS credentials could not be resolved: ${formatErrorMessage(error)}`
    }];
  }

  if (input.mode === "session") {
    if (!input.runtimeArn) {
      checks.push({
        name: `aws.${input.runtimeName}.runtime`,
        status: "fail",
        message: "Session mode requires runtimeArn in the runtime profile, backend details, or AGENTDISPATCH_AGENTCORE_RUNTIME_ARN."
      });
      return checks;
    }
    try {
      const parsed = parseAgentCoreRuntimeArn(input.runtimeArn);
      const runtime = await client.send(new GetAgentRuntimeCommand({
        agentRuntimeId: parsed.id,
        agentRuntimeVersion: parsed.version
      }));
      const status = runtime.status === "READY" ? "pass" : "warn";
      checks.push({
        name: `aws.${input.runtimeName}.runtime`,
        status,
        message: `AgentCore runtime ${runtime.agentRuntimeName ?? parsed.id} is ${runtime.status ?? "UNKNOWN"} in ${input.region}.`
      });
    } catch (error) {
      checks.push({
        name: `aws.${input.runtimeName}.runtime`,
        status: "fail",
        message: `AgentCore runtime ${input.runtimeArn} was not reachable: ${formatErrorMessage(error)}`
      });
    }
    return checks;
  }

  try {
    await client.send(new ListAgentRuntimesCommand({ maxResults: 1 }));
    checks.push({
      name: `aws.${input.runtimeName}.control-plane`,
      status: "pass",
      message: `AgentCore control plane is reachable in ${input.region}; runtime mode can create runtimes at dispatch time.`
    });
  } catch (error) {
    checks.push({
      name: `aws.${input.runtimeName}.control-plane`,
      status: "fail",
      message: `AgentCore control plane was not reachable in ${input.region}: ${formatErrorMessage(error)}`
    });
  }
  return checks;
}

function resolveRuntimeProfile(config: AgentDispatchConfig, runtimeName?: string) {
  if (!runtimeName) return getDefaultRuntimeProfile(config);
  const profile = getRuntimeProfile(config, runtimeName);
  if (!profile) throw new Error(`Runtime profile ${runtimeName} was not found.`);
  return profile;
}

async function waitForTask(client: AgentDispatchClient, taskId: string, pollIntervalMs: number, timeoutMs: number, output: CliOutput = console) {
  const startedAt = Date.now();
  let cursor = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    const logs = await client.getTaskLogs(taskId, cursor);
    cursor = logs.nextCursor;
    if (logs.data) {
      if (output.write) output.write(logs.data);
      else process.stdout.write(logs.data);
    }
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

function environmentVariablesRecord(options: Record<string, any>): Record<string, unknown> | undefined {
  const environmentVariables = mergeRecords(
    parseJsonObjectOption(options.environmentJson, "environment-json"),
    parseEnvironmentOptionList(options.env)
  );
  return environmentVariables ? { environmentVariables } : undefined;
}

function parseEnvironmentOptionList(values: unknown): Record<string, string> | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const environmentVariables: Record<string, string> = {};
  for (const value of values) {
    if (typeof value !== "string") continue;
    const separatorIndex = value.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error("--env must use KEY=value format.");
    }
    const key = value.slice(0, separatorIndex);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`--env key ${key} is not a valid environment variable name.`);
    }
    environmentVariables[key] = value.slice(separatorIndex + 1);
  }
  return environmentVariables;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function resolveAwsCredentials(client: BedrockAgentCoreControlClient): Promise<unknown> {
  const credentials = client.config.credentials;
  return typeof credentials === "function" ? credentials() : credentials;
}

function stringRecord(key: string, value: unknown): Record<string, unknown> | undefined {
  return typeof value === "string" && value.length > 0 ? { [key]: value } : undefined;
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `AgentDispatch config ${report.ok ? "OK" : "FAILED"}`,
    `Accounts: ${report.accounts}`,
    `Backends: ${report.backends}`,
    `Runtimes: ${report.runtimes}`,
    ...report.checks.map((check) => `[${check.status.toUpperCase()}] ${check.name}: ${check.message}`)
  ];
  return lines.join("\n");
}

function refreshDoctorReportStatus(report: DoctorReport): DoctorReport {
  return {
    ...report,
    ok: report.checks.every((check) => check.status !== "fail")
  };
}

function mergeRecords(...records: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...records.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function selectAwsLiveRuntimeProfiles(config: AgentDispatchConfig, runtimeName?: string) {
  const selected = runtimeName
    ? [getRuntimeProfile(config, runtimeName)].filter((runtime) => runtime !== undefined)
    : [getDefaultRuntimeProfile(config)].filter((runtime) => runtime !== undefined);
  return selected.filter((runtime) => {
    const backend = runtime ? config.backends[runtime.backend] : undefined;
    return backend?.adapter === "aws-agentcore";
  });
}

function parseAgentCoreRuntimeArn(runtimeArn: string): { id: string; version?: string } {
  const resource = runtimeArn.split(":").slice(5).join(":");
  const suffix = resource.split("/").at(-1) ?? runtimeArn;
  const [id, version] = suffix.split(":");
  return { id, version };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = typeof (error as { name?: unknown }).name === "string" ? `${(error as { name: string }).name}: ` : "";
    return `${code}${error.message}`;
  }
  return String(error);
}

if (isCliEntrypoint()) {
  void buildProgram().parseAsync();
}

function assertValidConfig(config: AgentDispatchConfig): void {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid AgentDispatch config:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
