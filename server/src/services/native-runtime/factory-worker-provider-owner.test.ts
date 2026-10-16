import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACTORY_COMPANY_ID, FactoryWorkerBusyError, createFactoryWorkerLeaseDescriptor } from "@paperclipai/adapter-utils/factory-worker-lease";
import type { FactoryProviderBinding } from "@paperclipai/adapter-utils/factory-provider-admission";
import { NativeSshForegroundOwner } from "./native-ssh-foreground-owner.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "factory-provider-owner-")); directories.push(directory);
  const runId = randomUUID(), runnerInstanceId = randomUUID(), workspaceId = randomUUID(), leaseId = randomUUID();
  const workspaceRoot = `/workspace/${FACTORY_COMPANY_ID}/${workspaceId}`, sessionId = "native-" + randomUUID();
  const workerLease = createFactoryWorkerLeaseDescriptor({ companyId: FACTORY_COMPANY_ID, runId, leaseId,
    workspaceId, workspaceRoot, sessionId, deadlineUnixMs: Date.now() + 60_000 });
  const providerAdmission: FactoryProviderBinding = { schema: "factory.provider-worker-binding.v2", provider: "codex",
    admissionId: randomUUID(), capabilityId: randomUUID(), normalizedSessionId: sessionId, runnerInstanceId, workerPlanSha256: "a".repeat(64) };
  const owner = new NativeSshForegroundOwner({ directory, runId, runnerInstanceId, ownershipError: () => new Error("ownership-held") });
  const remoteBinary = workspaceRoot + "/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd";
  const spec = { command: remoteBinary, cwd: workspaceRoot, environment: {}, args: ["--run-id", runId,
    "--environment-lease-id", leaseId, "--session-id", sessionId, "--runner-id", runnerInstanceId] };
  return { owner, workerLease, providerAdmission, remoteBinary, spec };
}

describe("post-staging Factory provider caller", () => {
  it("authorizes only after staging then forwards bound admission", async () => {
    const f = fixture(), events: string[] = [];
    const openDuplexChannel = vi.fn(async (_input: unknown) => { events.push("open"); throw new FactoryWorkerBusyError(); });
    const launch = f.owner.createLauncher({ runner: { openDuplexChannel }, remoteBinary: f.remoteBinary,
      remoteCwd: f.workerLease.workspaceRoot, diagnosticsDirectory: f.workerLease.diagnosticsDirectory,
      ensureArtifact: async () => { events.push("stage"); }, createWorkerAdmission: async () => {
        events.push("authorize"); return { workerLease: f.workerLease, providerAdmission: f.providerAdmission };
      } });
    await expect(launch(f.spec).completion).rejects.toBeInstanceOf(FactoryWorkerBusyError);
    expect(events).toEqual(["stage", "authorize", "open"]);
    expect(openDuplexChannel.mock.calls[0]?.[0]).toMatchObject({ workerLease: f.workerLease, providerAdmission: f.providerAdmission });
  });
  it("rejects substituted runner/argv before transport", async () => {
    for (const substitute of ["owner", "argv"]) {
      const f = fixture(), openDuplexChannel = vi.fn();
      if (substitute === "owner") f.providerAdmission.runnerInstanceId = "foreign";
      else f.spec.args[3] = randomUUID();
      const launch = f.owner.createLauncher({ runner: { openDuplexChannel }, remoteBinary: f.remoteBinary,
        remoteCwd: f.workerLease.workspaceRoot, diagnosticsDirectory: f.workerLease.diagnosticsDirectory,
        ensureArtifact: async () => {}, createWorkerAdmission: async () => ({ workerLease: f.workerLease, providerAdmission: f.providerAdmission }) });
      await expect(launch(f.spec).completion).rejects.toThrow("ownership-held");
      expect(openDuplexChannel).not.toHaveBeenCalled();
    }
  });
  it("keeps legacy callback free of provider binding", async () => {
    const f = fixture(), openDuplexChannel = vi.fn(async (_input: unknown) => { throw new FactoryWorkerBusyError(); });
    const launch = f.owner.createLauncher({ runner: { openDuplexChannel }, remoteBinary: f.remoteBinary,
      remoteCwd: f.workerLease.workspaceRoot, diagnosticsDirectory: f.workerLease.diagnosticsDirectory,
      ensureArtifact: async () => {}, createWorkerLease: async () => f.workerLease });
    await expect(launch(f.spec).completion).rejects.toBeInstanceOf(FactoryWorkerBusyError);
    expect(openDuplexChannel.mock.calls[0]?.[0]).not.toHaveProperty("providerAdmission");
  });
});
