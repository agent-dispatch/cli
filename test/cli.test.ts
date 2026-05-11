import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, createDispatchRequest, createDoctorReport, loadConfig, sampleConfig } from "../src/index.js";

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
    expect(config.runtimes["research-agent"].backend).toBe("aws-agentcore");
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
      input: {
        instruction: "do work",
        framework: "strands",
        context: { repo: "agent-dispatch" }
      }
    });
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

  it("warns when AgentCore session runtime ARN is missing", () => {
    const config = sampleConfig("us-west-2", "");
    const report = createDoctorReport(config);

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "backend.aws-agentcore.runtimeArn", status: "warn" })
    ]));
  });
});
