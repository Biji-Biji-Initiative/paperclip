import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACTORY_COMPANY_ID, FACTORY_WORKER_POLICY, FACTORY_LEASE_FIXED_ENV, FactoryWorkerBusyError, createFactoryWorkerLeaseDescriptor, encodeFactoryWorkerLaunch } from "@paperclipai/adapter-utils/factory-worker-lease";
import { prepareGitHubExecutionEnvironment } from "@paperclipai/adapter-utils/execution-target";
import { prepareHeartbeatGitHubLaunchers } from "../heartbeat-github-launchers.js";
import { NativeSshForegroundOwner } from "./native-ssh-foreground-owner.js";
import { buildFactoryWorkerEnvironment } from "./factory-worker-runtime.js";

// The public server dev shim omits this internal launcher; exercise its source.
const { spawnRunner } = await import(new URL(
  "../../../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts", import.meta.url,
).href) as typeof import("../../../../packages/paperclip-runner/dist/control-plane/durable-prp-control-plane.js");

function fixture() {
  const workspaceId = randomUUID();
  const workspaceRoot = `/workspace/${FACTORY_COMPANY_ID}/${workspaceId}`;
  const lease = createFactoryWorkerLeaseDescriptor({ companyId: FACTORY_COMPANY_ID,
    workspaceId, workspaceRoot, runId: randomUUID(), leaseId: randomUUID(),
    sessionId: randomUUID(), deadlineUnixMs: Date.now() + 60_000 });
  const command = [workspaceRoot + "/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd"] as const;
  return { lease, command };
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Factory worker bootstrap environment", () => {
  it("encodes a real controller bootstrap using the fixed worker paths and proxy", () => {
    const { lease, command } = fixture();
    const bootstrap = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/paperclip", USER: "controller", LOGNAME: "controller", XDG_CONFIG_HOME: "/server/config",
      HTTPS_PROXY: "http://controller-proxy.invalid", PAPERCLIP_WORKSPACE_CWD: lease.workspaceRoot,
      DO_NOT_TRACK: "1" };
    expect(() => encodeFactoryWorkerLaunch(lease, command, bootstrap)).toThrow("factory_worker_lease_invalid");
    const payload = JSON.parse(encodeFactoryWorkerLaunch(lease, command, buildFactoryWorkerEnvironment(bootstrap)).toString());
    expect(payload.environment).toMatchObject({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/node/lease",
      USER: "node", LOGNAME: "node", XDG_CONFIG_HOME: "/home/node/lease/.config",
      HTTPS_PROXY: "http://factory-gateway:3128", PAPERCLIP_WORKSPACE_CWD: lease.workspaceRoot, DO_NOT_TRACK: "1" });
  });

  it("omits unsupported bootstrap fields and keeps the receiver contract closed", () => {
    const { lease, command } = fixture();
    const env = buildFactoryWorkerEnvironment({ SHELL: "/bin/sh" });
    expect(JSON.parse(encodeFactoryWorkerLaunch(lease, command, env).toString()).environment).not.toHaveProperty("SHELL");
    expect(() => encodeFactoryWorkerLaunch(lease, command, { ...env, SHELL: "/bin/sh" }))
      .toThrow("factory_worker_lease_invalid");
  });

  it("omits unset process environment fields from the encoded launch", () => {
    const { lease, command } = fixture();
    const payload = JSON.parse(encodeFactoryWorkerLaunch(lease, command,
      buildFactoryWorkerEnvironment({ SHELL: undefined })).toString());
    expect(payload.environment).not.toHaveProperty("SHELL");
  });

  it("refuses provider credential overrides before building a launch environment", () => {
    expect(() => buildFactoryWorkerEnvironment({ OPENAI_API_KEY: "denied-test-value" }))
      .toThrow("native_execution_ownership_unverified");
  });

  it.each(["GH_TOKEN", "PAPERCLIP_GITHUB_BROKER_TOKEN"])("refuses nonempty %s before filtering Git scaffolding", key => {
    expect(() => buildFactoryWorkerEnvironment({ [key]: "denied-test-value" }))
      .toThrow("native_execution_ownership_unverified");
  });

  it("passes the actual Git preparation and runner spawn through protected admission", async () => {
    const { lease, command } = fixture();
    const directory = mkdtempSync("/data/tmp/factory-envelope-test-"); roots.push(directory);
    const runnerInstanceId = randomUUID();
    const target = { kind: "remote" as const, transport: "ssh" as const,
      factoryWorkerPolicy: FACTORY_WORKER_POLICY, remoteCwd: lease.workspaceRoot,
      spec: { host: "fixture.invalid", port: 2222, username: "node", remoteCwd: lease.workspaceRoot,
        remoteWorkspacePath: lease.workspaceRoot, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    const gitEnv = await prepareGitHubExecutionEnvironment({ target, cwd: lease.workspaceRoot,
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/paperclip" },
      hostCredentials: false, networkAccess: true });
    const createBrokerToken = vi.fn(() => { throw new Error("broker_not_qualified"); });
    const prepared = await prepareHeartbeatGitHubLaunchers({ target, cwd: lease.workspaceRoot, runId: lease.runId,
      env: gitEnv, native: true, githubConfigured: false, agentId: randomUUID(), brokerUrl: "", createBrokerToken });
    expect(createBrokerToken).not.toHaveBeenCalled();
    expect(() => encodeFactoryWorkerLaunch(lease, command, { ...prepared.env, ...FACTORY_LEASE_FIXED_ENV }))
      .toThrow("factory_worker_lease_invalid");
    const openDuplexChannel = vi.fn(async (_input: unknown) => { throw new FactoryWorkerBusyError(); });
    const owner = new NativeSshForegroundOwner({ directory, runId: lease.runId, runnerInstanceId,
      ownershipError: () => new Error("ownership-held") });
    const processLauncher = owner.createLauncher({ runner: { openDuplexChannel }, remoteBinary: command[0],
      remoteCwd: lease.workspaceRoot, diagnosticsDirectory: lease.diagnosticsDirectory, ensureArtifact: async () => {},
      createWorkerAdmission: async () => ({ workerLease: lease, providerAdmission: {
        schema: "factory.provider-worker-binding.v2", provider: "codex", admissionId: randomUUID(), capabilityId: randomUUID(),
        normalizedSessionId: lease.sessionId, runnerInstanceId, workerPlanSha256: "a".repeat(64),
        authorization: { schema: "factory.direct-board-wakeup.v1", actorType: "user", actorId: "synthetic-user",
          actorEmail: "synthetic@example.invalid", wakeupRequestId: randomUUID(), agentId: randomUUID(), requestedAtUnixMs: Date.now() - 1 } },
        revalidateProviderAdmission: async () => {} }) });
    const handle = spawnRunner({ connectUrl: "wss://factory.mereka.io/api/runner/v1/connect/" + lease.runId,
      stateDirectory: lease.stateDirectory, identity: { runId: lease.runId, environmentLeaseId: lease.leaseId,
        normalizedSessionId: lease.sessionId, runnerInstanceId, turnId: randomUUID(), itemId: randomUUID() },
      ticket: "bootstrap_" + randomUUID(), runnerBinaryPath: command[0], runnerVersion: "fixture",
      runnerDigest: "sha256:" + "a".repeat(64), maxOutboxBytes: 1048576, p0ReserveBytes: 262144,
      environment: buildFactoryWorkerEnvironment(prepared.env), processLauncher });
    await expect(handle.completion).rejects.toBeInstanceOf(FactoryWorkerBusyError);
    expect(openDuplexChannel).toHaveBeenCalledOnce();
    expect(openDuplexChannel.mock.calls[0]?.[0]).toMatchObject({ environment: {
      PATH: "/usr/local/bin:/usr/bin:/bin", HTTPS_PROXY: "http://factory-gateway:3128" } });
  });
});
