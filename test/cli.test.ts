import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, loadConfig, sampleConfig } from "../src/index.js";

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
  });

  it("builds a provider-neutral sample config", () => {
    expect(sampleConfig("us-east-1", "arn:runtime")).toMatchObject({
      defaults: { provider: "aws", capability: "agent-runtime" }
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
});
