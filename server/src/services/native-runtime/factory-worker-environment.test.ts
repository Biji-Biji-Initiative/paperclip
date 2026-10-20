import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FACTORY_COMPANY_ID, createFactoryWorkerLeaseDescriptor, encodeFactoryWorkerLaunch } from "@paperclipai/adapter-utils/factory-worker-lease";
import { buildFactoryWorkerEnvironment } from "./factory-worker-runtime.js";

function fixture() {
  const workspaceId = randomUUID();
  const workspaceRoot = `/workspace/${FACTORY_COMPANY_ID}/${workspaceId}`;
  const lease = createFactoryWorkerLeaseDescriptor({ companyId: FACTORY_COMPANY_ID,
    workspaceId, workspaceRoot, runId: randomUUID(), leaseId: randomUUID(),
    sessionId: randomUUID(), deadlineUnixMs: Date.now() + 60_000 });
  const command = [workspaceRoot + "/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd"];
  return { lease, command };
}

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

  it("keeps unknown launch variables subject to the closed receiver contract", () => {
    const { lease, command } = fixture();
    expect(() => encodeFactoryWorkerLaunch(lease, command, buildFactoryWorkerEnvironment({ SHELL: "/bin/sh" })))
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
});
