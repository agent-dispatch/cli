import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, createDispatchRequest, createDoctorReport, loadConfig, sampleConfig, sendA2AFollowUpFromTask } from "../src/index.js";

let stateDir: string | undefined;

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

describe("agentdispatch CLI", () => {
  it("creates a sample config with init", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agentdispatch-cli-"));
    const configPath = join(stateDir, "agentdispatch.config.json");
    const output: string[] = [];
    const program = buildProgram({ log: (value: string) => output.push(value), error: () => undefined });

    await program.parseAsync(["node", "agentdispatch", "init", "--config", configPath, "--region", "us-west-2", "--runtime-arn", "arn:test"]);
    const config = JSON.parse(await readFile(configPath, "utf8"));

    expect(output[0]).toContain("Wrote");
    expect(config.accounts["dev-aws"].provider).toBe("aws");
    expect(config.backends["aws-agentcore"].details.runtimeArn).toBe("arn:test");
    expect(config.backends["aws-agentcore"].details.protocol).toBe("a2a");
    expect(config.runtimes["research-agent"].backend).toBe("aws-agentcore");
    expect(config.runtimes["research-agent"].protocol).toBe("a2a");
  });

  it("does not write a fake runtime ARN when init omits one", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agentdispatch-cli-"));
    const configPath = join(stateDir, "agentdispatch.config.json");
    const program = buildProgram({ log: () => undefined, error: () => undefined });

    await program.parseAsync(["node", "agentdispatch", "init", "--config", configPath, "--region", "us-west-2"]);
    const config = JSON.parse(await readFile(configPath, "utf8"));

    expect(config.backends["aws-agentcore"].details.runtimeArn).toBeUndefined();
    expect(createDoctorReport(config).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "backend.aws-agentcore.runtimeArn", status: "warn" })
    ]));
  });

  it("builds a provider-neutral sample config", () => {
    expect(sampleConfig("us-east-1", "arn:runtime")).toMatchObject({
      defaults: { runtime: "research-agent" }
    });
  });

  it("builds dispatch requests from config defaults", () => {
    const request = createDispatchRequest(sampleConfig("us-east-1", "arn:runtime"), {
      instruction: "do work",
      contextJson: "{\"repo\":\"agent-dispatch\"}"
    });
    expect(request).toMatchObject({
      provider: "aws",
      accountProfile: "dev-aws",
      capability: "agent-runtime",
      backend: "aws-agentcore",
      taskType: "agent.run",
      target: {
        protocol: "a2a"
      },
      input: {
        instruction: "do work",
        protocol: "a2a",
        framework: "strands",
        model: { provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet" },
        context: { repo: "agent-dispatch" }
      }
    });
  });

  it("preserves runtime profile target mode when CLI option is omitted", () => {
    const config = sampleConfig("us-east-1", "arn:runtime");
    config.runtimes!["research-agent"].target = { mode: "runtime", details: { ecrImageUri: "image" } };

    const request = createDispatchRequest(config, { instruction: "do work" });

    expect(request.target).toEqual({ mode: "runtime", protocol: "a2a", details: { ecrImageUri: "image" } });
  });

  it("rejects empty run payloads", () => {
    expect(() => createDispatchRequest(sampleConfig("us-east-1", "arn:runtime"), {})).toThrow("Pass --instruction");
    expect(() => createDispatchRequest(sampleConfig("us-east-1", "arn:runtime"), { taskType: "command.run" })).toThrow("Pass --command");
  });

  it("rejects ambiguous run payloads unless task type is explicit", () => {
    expect(() => createDispatchRequest(sampleConfig("us-east-1", "arn:runtime"), { instruction: "do work", command: "echo hi" })).toThrow("Pass either");
    expect(createDispatchRequest(sampleConfig("us-east-1", "arn:runtime"), { taskType: "command.run", instruction: "do work", command: "echo hi" }).taskType).toBe("command.run");
  });

  it("infers command.run and parses target details", () => {
    const request = createDispatchRequest(sampleConfig("us-east-1", "arn:runtime"), {
      command: "echo hello",
      targetMode: "runtime",
      targetDetailsJson: "{\"ecrImageUri\":\"image\",\"executionRoleArn\":\"role\"}"
    });
    expect(request).toMatchObject({
      taskType: "command.run",
      target: {
        mode: "runtime",
        details: { ecrImageUri: "image", executionRoleArn: "role" }
      },
      input: { command: "echo hello" }
    });
  });

  it("rejects invalid account and backend mappings", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agentdispatch-cli-"));
    const configPath = join(stateDir, "agentdispatch.config.json");
    await writeFile(configPath, JSON.stringify({
      accounts: { "dev-gcp": { provider: "gcp", credentialSource: "gcloud-default" } },
      backends: {
        "aws-agentcore": {
          provider: "aws",
          capability: "agent-runtime",
          adapter: "aws-agentcore",
          account: "dev-gcp"
        }
      }
    }));

    await expect(loadConfig(configPath)).rejects.toThrow("provider aws does not match account dev-gcp");
  });

  it("reports preflight checks for AgentCore configuration", () => {
    const report = createDoctorReport(sampleConfig("us-west-2", "arn:aws:bedrock-agentcore:test"));

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "default-runtime", status: "pass" }),
      expect.objectContaining({ name: "backend.aws-agentcore.runtimeArn", status: "pass" }),
      expect.objectContaining({ name: "backend.aws-agentcore.credentials", status: "pass" }),
      expect.objectContaining({ name: "runtime.research-agent", status: "pass" })
    ]));
  });

  it("sends A2A follow-up from stored task cloudAgent metadata", async () => {
    const result = await sendA2AFollowUpFromTask({
      id: "task_1",
      provider: "aws",
      accountProfile: "dev-aws",
      capability: "agent-runtime",
      taskType: "agent.run",
      target: { mode: "session", protocol: "a2a" },
      input: { instruction: "run" },
      backend: "aws-agentcore",
      status: "running",
      providerRefs: {},
      cloudAgent: {
        protocol: "a2a",
        provider: "aws",
        backend: "aws-agentcore",
        accountProfile: "dev-aws",
        sessionId: "session_1"
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }, {
      text: "continue",
      metadata: { priority: "background" }
    }, async (cloudAgent, message) => ({
      text: `${cloudAgent.sessionId}:${message.text}`,
      metadata: message.metadata
    }));

    expect(result).toEqual({
      text: "session_1:continue",
      metadata: { priority: "background" }
    });
  });

  it("rejects A2A follow-up when task has no compatible cloudAgent", async () => {
    const task = {
      id: "task_1",
      provider: "aws",
      accountProfile: "dev-aws",
      capability: "agent-runtime",
      taskType: "agent.run",
      target: { mode: "session" },
      input: { instruction: "run" },
      backend: "aws-agentcore",
      status: "succeeded",
      providerRefs: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } as const;

    await expect(sendA2AFollowUpFromTask(task, { text: "continue" })).rejects.toThrow("does not include cloudAgent");
  });

  it("warns when AgentCore session runtime ARN is missing", () => {
    const config = sampleConfig("us-west-2", "");
    const report = createDoctorReport(config);

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "backend.aws-agentcore.runtimeArn", status: "warn" })
    ]));
  });
});
