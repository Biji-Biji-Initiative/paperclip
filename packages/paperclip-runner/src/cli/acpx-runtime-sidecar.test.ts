import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";

import { deliverAcpxResponse } from "../drivers/acpx/response-delivery.js";
import { enqueueAcpxSidecarInput } from "./acpx-sidecar-input.js";

import { normalizeAcpxPermission } from "../drivers/acpx/acp-permission-adapter.js";
import { ACPX_CAPABILITY_PROFILES } from "../drivers/acpx/capability-profiles.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/sidecar-protocol.js";
import { canonicalProviderEventsFromAcpxRuntimeEvent } from "../provider-events.js";
import {
  awaitSidecarCleanupWithin,
  closeActiveSidecarHostWithin,
  closeSidecarHostForCommand,
  combineSidecarAdmissionCleanups,
  combineSidecarHostCleanups,
  hasSidecarSessionOwnership,
  observeSidecarCleanupWithin,
  parseAcpxRunAttachment,
  readSidecarHostStatusWithin,
  recoverAndCombineSidecarHostCleanup,
  recoverSidecarHostCleanup,
  reportAuthoritativeSidecarHostCleanupFailure,
  requireSidecarCommandHost,
  verifyOpenedAcpxSidecarHost,
} from "./acpx-sidecar-lifecycle.js";

const children = new Set<SidecarProcess>();

afterEach(async () => {
  await Promise.all([...children].map((child) => child.close()));
  children.clear();
});

describe("qualified ACPX runtime sidecar", () => {
  it.each(["pi", "copilot", "cursor", "codex", "claude"])("offers verified session permission grants only for %s", async agent => {
    const source = readFileSync(fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)), "utf8");
    const start = source.indexOf("  const { signal } = context;", source.indexOf("async function waitForPermission"));
    const end = source.indexOf("\nasync function waitForInput", start);
    expect(start).toBeGreaterThan(0);
    const permissions = new Map<string, unknown>();
    const emitted: Array<{ choices: Array<{ key: string }> }> = [];
    const wait = new Function("permissions", "openParams", "normalizeAcpxPermission", "emit", "verifyFactoryClaudeAdmission", "factoryClaudeAccess", "runId",
      `let turnId = "turn-1", requestSequence = 0; const MAX_PENDING_INPUTS = 512;
       const stableRequestId = () => "request-1"; const requireAcpxResponseDelivery = c => c.responseDelivery;
       return async function(activeTurnId, request, context) { ${source.slice(start, end)}`)(
      permissions, { agent }, normalizeAcpxPermission, (_event: string, payload: { choices: Array<{ key: string }> }) => emitted.push(payload),
      () => undefined, undefined, "test-run",
    );
    const abort = new AbortController();
    const pending = wait("turn-1", { sessionId: "session", inferredKind: "edit", raw: {
      sessionId: "session", toolCall: { toolCallId: "call", title: "Edit file" },
      options: ["allow_once", "allow_always", "reject_once"].map(kind => ({ kind, optionId: kind, name: kind })),
    } }, { signal: abort.signal, responseDelivery: Promise.resolve() });
    expect(emitted[0]!.choices.some(choice => choice.key === "accept_for_session")).toBe(agent === "pi" || agent === "copilot");
    abort.abort();
    await expect(pending).resolves.toEqual({ outcome: "cancel" });
    expect(permissions.size).toBe(0);
  });
  it("preserves ACP input presence through the bounded sidecar handoff", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("function boundRuntimeEventForNormalization");
    const end = source.indexOf("\nfunction sanitizeRuntimeEvent", start);
    if (start < 0 || end < 0) throw new Error("sidecar normalization source not found");
    const functionSource = source
      .slice(start, end)
      .replace(
        /function boundRuntimeEventForNormalization\(\n  event: AcpRuntimeEvent,\n\): AcpRuntimeEvent \{/,
        "function boundRuntimeEventForNormalization(event) {",
      )
      .replace("  } as BoundedRuntimeToolEvent;", "  };");
    const bound = new Function(
      "boundedOptionalText", "stableProviderIdentity", "safeAcpxLocations", "openParams", "safeOutput",
      `return (${functionSource});`,
    )(
      (value: unknown, fallback: string, max: number) => typeof value === "string" ? value.slice(0, max) : fallback,
      (value: string) => value,
      () => [],
      null,
      () => ({ output: null, outputBytes: 0, outputTruncated: false, outputDigest: null }),
    ) as (event: Record<string, unknown>) => Record<string, unknown>;
    const bounded = bound({
      type: "tool_call", toolCallId: "provider-tool", title: "search", kind: "other",
      status: "pending", rawInput: { secret: "must not cross" }, rawOutput: null,
    });
    expect(bounded.inputUpdated).toBe(true);
    expect(bounded).not.toHaveProperty("rawInput");
    const canonical = canonicalProviderEventsFromAcpxRuntimeEvent(bounded as never, "fallback")[0]!;
    expect(canonical.payload).toMatchObject({ inputUpdated: true });
    expect(JSON.stringify(canonical.payload)).not.toContain("must not cross");
    expect(source).toContain("? boundedTool.inputUpdated");
  });

  it.each(["paperclip_finish", "paperclip_block"])(
    "bounds pending %s calls before reserved handling and resumes admission",
    async (operationId) => {
      const tools = new Map<string, unknown>();
      for (let index = 0; index < 512; index++) tools.set(`pending-${index}`, {});
      const emitted: unknown[] = [];
      const waitForTool = loadWaitForTool({ tools, emitted });
      const signal = new AbortController();
      await expect(waitForTool({
        callId: `${operationId}-at-capacity`, tool: operationId,
        arguments: operationId === "paperclip_block" ? { reportedWorkDisposition: "blocked" } : { reportedWorkDisposition: "done" },
        signal: signal.signal,
      })).rejects.toThrow("ACPX pending tool limit reached");
      expect(emitted).toEqual([]);
      expect(tools.size).toBe(512);

      tools.delete("pending-0");
      const admitted = waitForTool({
        callId: `${operationId}-after-release`, tool: operationId,
        arguments: operationId === "paperclip_block" ? { reportedWorkDisposition: "blocked" } : { reportedWorkDisposition: "done" },
        signal: signal.signal,
      });
      await Promise.resolve();
      expect(tools.has(`${operationId}-after-release`)).toBe(true);
      signal.abort();
      await expect(admitted).rejects.toThrow("ACPX tool call was cancelled");
      expect(tools.size).toBe(511);
    },
  );

  it("shuts down without using readline after stdin closes", async () => {
    const sidecar = startSidecar();
    sidecar.write(initializeRequest(1, "codex"));
    await expect(
      sidecar.next((frame) => frame.id === 1),
    ).resolves.toMatchObject({
      id: 1,
      ok: true,
    });

    await sidecar.close();

    expect(sidecar.stderr()).not.toContain("ERR_USE_AFTER_CLOSE");
  });

  it("keeps session admission closed while any cleanup owner remains", () => {
    const cleanup = Promise.resolve();

    expect(hasSidecarSessionOwnership(null, null, null)).toBe(false);
    expect(hasSidecarSessionOwnership({}, null, null)).toBe(true);
    expect(hasSidecarSessionOwnership(null, cleanup, null)).toBe(true);
    expect(hasSidecarSessionOwnership(null, null, cleanup)).toBe(true);
  });

  it("allows only an explicit cleanup retry to reach a retained host", () => {
    const host = { identity: () => ({ kind: "acpx" }) };
    const cleanup = new Promise<void>(() => undefined);

    expect(() => requireSidecarCommandHost(host, cleanup)).toThrow(
      "cleanup is in progress",
    );
    expect(
      requireSidecarCommandHost(host, cleanup, { allowCleanupRetry: true }),
    ).toBe(host);
    expect(() =>
      requireSidecarCommandHost(null, cleanup, { allowCleanupRetry: true }),
    ).toThrow("session is not open");
  });

  it("closes an opened host when post-open verification fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn().mockRejectedValue(new Error("status failed")),
      close,
    };

    await expect(verifyOpenedAcpxSidecarHost(host, () => ({}))).rejects.toThrow(
      "status failed",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({
      reason: "ACPX session open verification failed",
    });
  });

  it("bounds failed-admission cleanup when the host does not settle", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn().mockRejectedValue(new Error("status failed")),
      close,
    };

    await expect(
      verifyOpenedAcpxSidecarHost(host, () => ({}), 1, retainCleanup),
    ).rejects.toThrow("verification and provider cleanup failed");
    expect(close).toHaveBeenCalledOnce();
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);
    finishCleanup();
    await cleanup;
  });

  it("bounds shutdown waiting without releasing retained cleanup ownership", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    await expect(awaitSidecarCleanupWithin(cleanup, 1)).resolves.toBe(
      "deferred",
    );
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    finishCleanup();
    await cleanup;
    expect(settled).toBe(true);
    await expect(awaitSidecarCleanupWithin(cleanup, 1)).resolves.toBe(
      "settled",
    );
  });

  it("preserves retained cleanup failure for shutdown accounting", async () => {
    const failure = new Error("provider cleanup failed");
    await expect(
      observeSidecarCleanupWithin(Promise.reject(failure), 1),
    ).resolves.toEqual({ status: "failed", error: failure });
    await expect(
      observeSidecarCleanupWithin(new Promise<void>(() => undefined), 1),
    ).resolves.toEqual({ status: "deferred" });
  });

  it("preserves failed-admission rejection until every cleanup settles", async () => {
    let finishCleanup!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const retained = combineSidecarAdmissionCleanups([
      Promise.reject(new Error("provider survived termination")),
      pending,
    ]);
    let settled = false;
    void retained.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    finishCleanup();
    await expect(retained).rejects.toThrow(
      "did not release provider ownership",
    );
  });

  it("bounds active-host cleanup during sidecar shutdown", async () => {
    const cleanup = new Promise<void>(() => undefined);
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();

    await expect(
      closeActiveSidecarHostWithin({ close }, "SIGTERM", 1, retainCleanup),
    ).resolves.toBe("deferred");
    expect(close).toHaveBeenCalledWith({ reason: "SIGTERM" });
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);
  });

  it("bounds command cleanup without replacing its exact owner", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();

    await expect(
      closeSidecarHostForCommand({ close }, "session close", 1, retainCleanup),
    ).rejects.toThrow("cleanup exceeded its command timeout");
    expect(close).toHaveBeenCalledOnce();
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);

    finishCleanup();
    await cleanup;
  });

  it("preserves a settled command cleanup failure", async () => {
    const cleanup = Promise.reject(new Error("runtime close failed"));
    await expect(
      closeSidecarHostForCommand({ close: () => cleanup }, "session close", 10),
    ).rejects.toThrow("runtime close failed");
  });

  it("recovers a rejected active-host cleanup sequentially", async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first close failed"))
      .mockResolvedValue(undefined);
    const host = { close };
    const initialCleanup = host.close();

    await expect(
      recoverSidecarHostCleanup(host, initialCleanup),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated active-host cleanup failures", async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("close failed"));
    const host = { close };
    const initialCleanup = host.close();

    await expect(
      recoverSidecarHostCleanup(host, initialCleanup),
    ).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("retains a pending cleanup owner after a command retry succeeds", async () => {
    let finishPending!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishPending = resolve;
    });
    const successfulRetry = Promise.resolve();
    const owner = combineSidecarHostCleanups([pending, successfulRetry]);
    let settled = false;
    void owner.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishPending();
    await expect(owner).resolves.toBeUndefined();
  });

  it("accepts a coalesced rejection after sequential recovery succeeds", async () => {
    let rejectCoalesced!: (error: unknown) => void;
    const coalesced = new Promise<void>((_resolve, reject) => {
      rejectCoalesced = reject;
    });
    const close = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(coalesced)
      .mockReturnValueOnce(coalesced)
      .mockResolvedValue(undefined);
    const host = { close };
    const recoveredPrior = recoverSidecarHostCleanup(host, host.close());
    const owner = recoverAndCombineSidecarHostCleanup(
      host,
      host.close(),
      recoveredPrior,
    );
    let settled = false;
    void owner
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await Promise.resolve();
    expect(settled).toBe(false);
    rejectCoalesced(new Error("coalesced close failed before recovery"));
    await expect(owner).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("rejects when every active-host cleanup owner fails", async () => {
    const owner = combineSidecarHostCleanups([
      Promise.reject(new Error("recovery exhausted")),
      Promise.reject(new Error("retry failed")),
    ]);

    await expect(owner).rejects.toThrow("did not release provider ownership");
  });

  it("accepts a later recovery after an older owner exhausts", async () => {
    await expect(
      combineSidecarHostCleanups([
        Promise.reject(new Error("older recovery exhausted")),
        Promise.resolve(),
      ]),
    ).resolves.toBeUndefined();
  });

  it("does not escalate a superseded cleanup owner failure", async () => {
    let rejectOlder!: (error: unknown) => void;
    const older = new Promise<void>((_resolve, reject) => {
      rejectOlder = reject;
    });
    const replacement = combineSidecarHostCleanups([
      older,
      Promise.resolve(),
    ]);
    const reportFailure = vi.fn();
    void older.catch((error: unknown) => {
      reportAuthoritativeSidecarHostCleanupFailure(
        false,
        replacement,
        older,
        error,
        reportFailure,
      );
    });

    rejectOlder(new Error("older recovery exhausted"));
    await expect(replacement).resolves.toBeUndefined();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("escalates only an authoritative cleanup owner's terminal failure", async () => {
    const owner = combineSidecarHostCleanups([
      Promise.reject(new Error("older recovery exhausted")),
      Promise.reject(new Error("replacement recovery exhausted")),
    ]);
    const reportFailure = vi.fn();

    await owner.catch((error: unknown) => {
      reportAuthoritativeSidecarHostCleanupFailure(
        false,
        owner,
        owner,
        error,
        reportFailure,
      );
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError);

    reportAuthoritativeSidecarHostCleanupFailure(
      true,
      owner,
      owner,
      new Error("shutdown cleanup failed"),
      reportFailure,
    );
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("bounds status verification before cleaning up the opened host", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn(() => new Promise<never>(() => undefined)),
      close,
    };

    await expect(
      verifyOpenedAcpxSidecarHost(host, () => ({}), 1),
    ).rejects.toThrow("status read exceeded its timeout");
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds ordinary status reads so serialized shutdown can proceed", async () => {
    const host = {
      status: vi.fn(() => new Promise<never>(() => undefined)),
    };

    await expect(readSidecarHostStatusWithin(host, 1)).rejects.toThrow(
      "status read exceeded its timeout",
    );
  });

  it("validates a complete run attachment before it can be committed", () => {
    let attachedRunId: string | null = null;
    const attach = (params: Record<string, unknown>) => {
      const attachment = parseAcpxRunAttachment(params);
      attachedRunId = attachment.runId;
      return attachment;
    };

    expect(() => attach({ runId: "run-1", catalogRevision: 0 })).toThrow(
      "catalogRevision must be a positive integer",
    );
    expect(attachedRunId).toBeNull();
    expect(attach({ runId: "run-1", catalogRevision: 2 })).toEqual({
      runId: "run-1",
      catalogRevision: 2,
    });
    expect(attachedRunId).toBe("run-1");
  });

  it("recovers after malformed input and reports its qualified Codex profile", async () => {
    const sidecar = startSidecar();
    sidecar.write({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      id: 1,
      command: "initialize",
      params: {},
      unexpected: true,
    });
    await expect(
      sidecar.next((frame) => frame.eventType === "runtime.diagnostic"),
    ).resolves.toMatchObject({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      eventType: "runtime.diagnostic",
      payload: { code: "malformed_frame" },
    });

    sidecar.write(initializeRequest(2, "codex"));

    await expect(
      sidecar.next((frame) => frame.id === 2),
    ).resolves.toMatchObject({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      id: 2,
      ok: true,
      result: {
        profile: {
          agent: "codex",
          qualificationModel: "gpt-5.6-sol",
        },
        capabilities: {
          persistentSessions: true,
          exactModelVerification: true,
          structuredInput: "paperclip.question_set.v1",
        },
      },
    });
    expect(sidecar.stderr()).toContain("malformed_frame");

    sidecar.write(initializeRequest(3, "codex"));
    await expect(
      sidecar.next((frame) => frame.id === 3),
    ).resolves.toMatchObject({
      id: 3,
      ok: false,
      error: { message: "ACPX sidecar is already initialized" },
    });
  });

  it.each([["claude", "claude-sonnet-5"]])(
    "reports the qualified %s profile",
    async (agent, model) => {
      const sidecar = startSidecar();
      sidecar.write(initializeRequest(1, agent, model));

      await expect(
        sidecar.next((frame) => frame.id === 1),
      ).resolves.toMatchObject({
        id: 1,
        ok: true,
        result: { profile: { agent, qualificationModel: model } },
      });
    },
  );

  it.each([
    ["pi", "openrouter/deepseek/deepseek-v4-flash-0731"],
    ["cursor", "explicit-cursor-model"],
    ["copilot", "explicit-copilot-model"],
  ] as const)("initializes the declared %s candidate without promoting its profile", async (agent, model) => {
    const sidecar = startSidecar();
    sidecar.write(initializeRequest(1, agent, model));
    const frame = await sidecar.next((value) => value.id === 1);
    expect(frame).toMatchObject({ id: 1, ok: true });
    const result = frame.result as Record<string, unknown>;
    expect(result.profile).toEqual(resolveQualifiedAcpxProfile(agent, model));
    expect(result.profile).toMatchObject({ reportedModelId: model });
    expect(ACPX_CAPABILITY_PROFILES[agent].qualification).toBe("pending");
  });

  it("fails closed after an unsupported provider bootstrap", async () => {
    const sidecar = startSidecar();
    sidecar.write(
      initializeRequest(
        1,
        "unknown-provider",
        "openrouter/deepseek/deepseek-v4-flash-0731",
      ),
    );

    await expect(
      sidecar.next((frame) => frame.id === 1),
    ).resolves.toMatchObject({
      id: 1,
      ok: false,
      error: {
        code: "acpx_sidecar_command_failed",
        message: "ACPX agent must be claude, codex, grok, cursor, copilot, or pi",
        retryable: false,
      },
    });

    sidecar.write(initializeRequest(2, "codex"));

    await expect(
      sidecar.next((frame) => frame.id === 2),
    ).resolves.toMatchObject({
      id: 2,
      ok: false,
      error: {
        message: expect.stringContaining(
          "ACPX provider bootstrap failed before initialize",
        ),
        retryable: false,
      },
    });
  });
});

function initializeRequest(
  id: number,
  agent: string,
  model = "gpt-5.6-sol",
): Record<string, unknown> {
  return {
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    id,
    command: "initialize",
    params: { agent, model },
  };
}

function startSidecar(): SidecarProcess {
  const sidecar = new SidecarProcess();
  children.add(sidecar);
  return sidecar;
}

class SidecarProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #frames: Array<Record<string, unknown>> = [];
  readonly #signals: Array<() => void> = [];
  #stderr = "";
  #closed = false;

  constructor() {
    this.#child = spawn(
      fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)),
      [fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        this.#frames.push(JSON.parse(line) as Record<string, unknown>);
        for (const signal of this.#signals.splice(0)) signal();
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
  }

  write(value: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  stderr(): string {
    return this.#stderr;
  }

  async next(
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index >= 0) return this.#frames.splice(index, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for sidecar frame. stderr=${JSON.stringify(this.#stderr)}`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.#signals.indexOf(signal);
          if (index >= 0) this.#signals.splice(index, 1);
          reject(new Error("Timed out waiting for sidecar output"));
        }, remaining);
        const signal = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#signals.push(signal);
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    const exit = new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
    await Promise.race([exit, timeout]);
  }
}

function loadWaitForTool(input: {
  tools: Map<string, unknown>;
  emitted: unknown[];
}): (call: { callId: string; tool: string; arguments: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown> {
  const source = readFileSync(
    fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("async function waitForTool");
  const end = source.indexOf("\nasync function waitForPermission", start);
  if (start < 0 || end < 0) throw new Error("waitForTool source not found");
  const functionSource = source
    .slice(start, end)
    .replace(
      "async function waitForTool(call: RunnerToolCall): Promise<unknown>",
      "async function waitForTool(call)",
    );
  const factory = new Function(
    "boundedIdentity", "tools", "turnId", "emit", "PRP_COMPLETION_TOOL_NAME",
    "PRP_BLOCK_TOOL_NAME", "validatePrpStructuredRunResult", "boundedSidecarValue", "record", "MAX_PENDING_TOOLS",
    "verifyFactoryClaudeAdmission", "factoryClaudeAccess", "runId",
    `return (${functionSource});`,
  );
  return factory(
    (value: string) => value,
    input.tools,
    "test-turn",
    (_eventType: string, payload: unknown) => input.emitted.push(payload),
    "paperclip_finish",
    "paperclip_block",
    (argumentsValue: unknown) => ({
      ok: true,
      result: argumentsValue,
    }),
    (value: unknown) => value,
    (value: unknown) => value,
    512,
    () => undefined, undefined, "test-run",
  );
}


// Execute the production handlers, with provider effects replaced at their boundary.
// Advancing this clock never runs timers: each admission must check expiry itself.
describe("Factory Claude command admission after capability expiry", () => {
  it("rechecks expiry after asynchronous host status before submitting a prompt", async () => {
    const fixture = protectedDispatchFixture();
    let release!: () => void;
    fixture.dependencies.readSidecarHostStatusWithin = () => new Promise<void>(resolve => { release = resolve; });
    const dispatch = fixture.load(null);
    const result = dispatch({ command: "turn.start", params: { turnId: "turn-1", message: "synthetic" } });
    fixture.expire();
    release();
    await expect(result).rejects.toThrow("synthetic capability expired");
    expect(fixture.host.startTurn).not.toHaveBeenCalled();
  });

  it.each(["steer", "queue"])("rejects expired %s before the host receives it", async mode => {
    const fixture = protectedDispatchFixture();
    fixture.expire();
    await expect(fixture.load()({ command: "turn.steer", params: {
      turnId: "turn-1", controlId: "control-1", message: "synthetic", mode,
    } })).rejects.toThrow("synthetic capability expired");
    expect(fixture.host.steerActiveTurn).not.toHaveBeenCalled();
    expect(fixture.host.queueFollowUp).not.toHaveBeenCalled();
  });

  it.each(["steer", "queue"])("preserves a fresh %s request", async mode => {
    const fixture = protectedDispatchFixture();
    await expect(fixture.load()({ command: "turn.steer", params: {
      turnId: "turn-1", controlId: "control-1", message: "synthetic", mode,
    } })).resolves.toMatchObject({ accepted: true, mode });
    expect(mode === "steer" ? fixture.host.steerActiveTurn : fixture.host.queueFollowUp)
      .toHaveBeenCalledWith("synthetic", "run-1:turn-1");
  });

  it.each(["session.goal.set", "session.goal.clear"])("rejects expired %s before goal mutation", async command => {
    const fixture = protectedDispatchFixture();
    fixture.expire();
    await expect(fixture.load()({ command, params: { objective: "synthetic" } }))
      .rejects.toThrow("synthetic capability expired");
    expect(fixture.host.controlGoal).not.toHaveBeenCalled();
  });

  it.each(["permission", "input", "tool"])("holds expired %s responses before preparation or settlement", async kind => {
    const fixture = protectedDispatchFixture();
    fixture.expire();
    await expect(fixture.load()({ command: `${kind}.resolve`, params: {
      requestId: "request-1", callId: "request-1", turnId: "turn-1", resolution: {}, result: {},
    } })).rejects.toThrow("synthetic capability expired");
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.settle).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(1);
  });

  it.each(["permission", "input", "tool"])("preserves fresh %s settlement and delivery receipts", async kind => {
    const fixture = protectedDispatchFixture();
    let release!: () => void;
    fixture.responseDelivery = new Promise<void>(resolve => { release = resolve; });
    const result = fixture.load()({ command: `${kind}.resolve`, params: {
      requestId: "request-1", callId: "request-1", turnId: "turn-1", resolution: {}, result: {},
    } });
    // ACP settlement happens before awaiting the transport receipt; no fabricated await gap.
    expect(fixture.settle).toHaveBeenCalledOnce();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.pending.size).toBe(0);
    release();
    await expect(result).resolves.toEqual({ resolved: true });
  });

  it("starts owned cleanup immediately when callback expiry finds a blocked input queue", async () => {
    let releaseInput!: () => void;
    let releaseClose!: () => void;
    const inputQueue = new Promise<void>(resolve => { releaseInput = resolve; });
    const closeReceipt = new Promise<void>(resolve => { releaseClose = resolve; });
    const close = vi.fn(() => closeReceipt);
    const permissionSettled = vi.fn();
    const toolRejected = vi.fn();
    const inputCancelled = vi.fn();
    const cleanup = vi.fn();
    const dependencyValues = {
      factoryClaudeAccess: {},
      verifyFactoryClaudeSidecarRun: () => { throw new Error("synthetic capability expired"); },
      initialInput: inputQueue, ownedHost: { close },
      permissions: new Map([["permission-1", { turnId: "turn-1", settle: permissionSettled, cleanup }]]),
      tools: new Map([["tool-1", { turnId: "turn-1", reject: toolRejected, cleanup }]]),
      inputs: new Map([["input-1", { turnId: "turn-1", cancel: inputCancelled, cleanup }]]),
      lines: { pause: vi.fn(), close: vi.fn() },
      process: { stdin: { pause: vi.fn() }, exitCode: 0 },
      enqueueAcpxSidecarInput,
      diagnostic: vi.fn(), safeMessage: (error: unknown) => String(error),
      retainActiveHostCleanup: vi.fn(),
      observeSidecarCleanupWithin: async (receipt: Promise<void>) => { await receipt; return { status: "settled" }; },
    };
    const source = [
      productionFunctionSource("verifyFactoryClaudeAdmission", "receiveLine"),
      productionFunctionSource("requestShutdown", "verifyFactoryClaudeAdmission"),
      productionFunctionSource("shutdown", "retainActiveHostCleanup"),
      productionFunctionSource("rejectTurnWaiters", "boundRuntimeEventForNormalization"),
    ].join("\n");
    const compiled = transformSync(source, { loader: "ts", target: "es2022" }).code;
    const actual = new Function(...Object.keys(dependencyValues), `
      let closing = false, shutdownRequested = false, inputClosed = false;
      let pendingInput = initialInput, host = ownedHost, activeHostCleanup = null, failedAdmissionCleanup = null;
      let turnId = "turn-1", runId = "run-1", openParams = {};
      ${compiled};
      return { verifyFactoryClaudeAdmission, drained: () => pendingInput, closing: () => closing };
    `)(...Object.values(dependencyValues)) as {
      verifyFactoryClaudeAdmission: (runId: string) => void;
      drained: () => Promise<void>; closing: () => boolean;
    };
    expect(() => actual.verifyFactoryClaudeAdmission("run-1")).toThrow("synthetic capability expired");
    // Neither the SDK close receipt nor the serial input queue has completed.
    expect(actual.closing()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(permissionSettled).toHaveBeenCalledWith({ outcome: "cancel" });
    expect(toolRejected).toHaveBeenCalledOnce();
    expect(inputCancelled).toHaveBeenCalledOnce();
    releaseClose();
    releaseInput();
    await actual.drained();
    expect(close).toHaveBeenCalledOnce();
    expect(dependencyValues.diagnostic).not.toHaveBeenCalled();
  });

  it.each(["waitForTool", "waitForPermission", "waitForInput", "waitForExtensionInput"])(
    "rejects expired %s before emitting a new provider request", async name => {
      const fixture = protectedDispatchFixture();
      fixture.expire();
      fixture.load();
      const emitted = vi.fn();
      const successors: Record<string, string> = { waitForTool: "waitForPermission", waitForPermission: "waitForInput", waitForInput: "waitForExtensionInput", waitForExtensionInput: "elicitationResponse" };
      const nextName = successors[name];
      if (!nextName) throw new Error("unknown production waiter");
      const wait = loadSidecarProductionFunction(name, nextName, { ...fixture.dependencies, emit: emitted });
      const signal = new AbortController().signal;
      const args = name === "waitForTool" ? [{ signal }] : ["turn-1", {}, { signal }];
      await expect(wait(...args)).rejects.toThrow("synthetic capability expired");
      expect(emitted).not.toHaveBeenCalled();
      expect(fixture.pending.size).toBe(1);
    },
  );
});

function loadSidecarProductionFunction(name: string, nextName: string, dependencies: Record<string, unknown>) {
  const functionSource = productionFunctionSource(name, nextName);
  const compiled = transformSync(functionSource, { loader: "ts", target: "es2022" }).code;
  return new Function(...Object.keys(dependencies), `${compiled}; return ${name};`)(...Object.values(dependencies)) as (...args: unknown[]) => Promise<unknown>;
}

function productionFunctionSource(name: string, nextName: string) {
  const source = readFileSync(fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)), "utf8");
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const remaining = source.slice(start);
  const next = remaining.search(new RegExp(`\\n(?:async )?function ${nextName}\\(`));
  if (start < 0 || next < 0) throw new Error(`production ${name} slice missing`);
  return remaining.slice(0, next);
}

function protectedDispatchFixture() {
  let expired = false;
  const settle = vi.fn();
  const cleanup = vi.fn();
  const prepare = vi.fn(() => settle);
  const pending = new Map<string, unknown>();
  const host = {
    identity: () => ({ backendSessionId: "session-1" }),
    startTurn: vi.fn(), steerActiveTurn: vi.fn(), queueFollowUp: vi.fn(), controlGoal: vi.fn(),
    steeringCapability: () => ({ steering: true, queuedFollowUp: true }),
  };
  const dependencies: Record<string, unknown> = {
    factoryClaudeAccess: {}, runId: "run-1", turnId: "turn-1", host,
    openParams: { agent: "claude", workingDirectory: "/synthetic" },
    requireHost: () => host,
    verifyFactoryClaudeAdmission: () => { if (expired) throw new Error("synthetic capability expired"); },
    boundedIdentity: (value: unknown) => value, boundedText: (value: unknown) => value,
    text: (value: unknown) => typeof value === "string" ? value : "",
    parseAcpxTurnControl: (value: unknown) => value,
    turnControls: { begin: vi.fn(), reserve: vi.fn() },
    bindAcpxExtensionTurn: () => ({}), createAcpxProfileExtensionAdapter: () => ({}),
    readSidecarHostStatusWithin: async () => ({}),
    permissions: pending, inputs: pending, tools: pending,
    parseHarnessRuntimeRequestResolution: () => ({}), deliverAcpxResponse,
  };
  const fixture = {
    host, settle, prepare, cleanup, pending, dependencies,
    responseDelivery: Promise.resolve(),
    expire: () => { expired = true; },
    load: (turnId: string | null = "turn-1") => {
      pending.set("request-1", { turnId: "turn-1", normalized: { resolve: prepare }, prepareResolution: prepare,
        settle, cleanup, responseDelivery: fixture.responseDelivery });
      return loadSidecarProductionFunction("dispatch", "pumpTurn", { ...dependencies, turnId });
    },
  };
  return fixture;
}
