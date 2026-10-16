import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, documents, heartbeatRunEvents, heartbeatRuns, issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildNativeSessionHandoff, createNativeSessionHandoffLoader, NATIVE_HANDOFF_MAX_BYTES, renderNativeSessionHandoff } from "./native-session-handoff.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeModelEnvelope } from "@paperclipai/paperclip-runner";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

describe("bounded fresh-session handoff", () => {
  it("marks omissions and stays within its byte budget for huge Unicode histories", () => {
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: 1, omittedEntriesAtLeast: 1,
      entries: Array.from({ length: 100 }, (_, i) => ({ kind: "message", id: String(i), body: "🦖".repeat(10_000) })),
    });
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(rendered).toContain('"truncated":true');
    expect(rendered).toContain("content omitted");
    expect(rendered).toContain("get_task_history");
    expect(rendered).toContain("Legacy adapters can use the equivalent Paperclip");
  });

  it("restores the handoff on fresh bootstrap and resume failure, without replaying it on resume", () => {
    const input = buildNativeExecutionInput({
      companyId: "company", runId: "run", agentId: "agent", normalizedSessionId: "session", conversationMode: true,
      issue: { id: "task", identifier: "BOT-2", title: "Chat", description: null, workMode: "standard" },
      taskPrompt: "GitHub is connected", freshSessionHandoff: "original goal: build the PR review bot", initialCommunicationGuidance: "Lead with the answer",
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
        revision: "1", objective: "Build bot", criteria: [{ id: "objective", requirement: "Build bot" }],
      } }, runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("original goal");
    const resumed = buildNativeModelEnvelope(input, { resumedSession: true });
    expect("task" in resumed && resumed.task.prompt).not.toContain("original goal");
    // The runtime uses the same full envelope if actual recovery fails.
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("Lead with the answer");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("handoff history scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), boundaryId = randomUUID(), requestId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-handoff-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: "HAND" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dickens", role: "general", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: "user", conversationState: "active", conversationSessionGeneration: 2 });
    await db.insert(issueComments).values([
      { companyId, issueId, body: "OLD TOPIC", authorUserId: "user", createdAt: new Date(1_000) },
      { id: boundaryId, companyId, issueId, body: "/new", authorUserId: "user", createdAt: new Date(2_000) },
      { id: requestId, companyId, issueId, body: "Build a GitHub PR review bot\n" + "x".repeat(6_000) + "\nFinal constraint: require a team review", authorUserId: "user", createdAt: new Date(3_000) },
      { companyId, issueId, body: "Deleted private message", authorUserId: "user", createdAt: new Date(4_000), deletedAt: new Date(5_000) },
      { companyId, issueId, body: "UNTRUSTED BODY", authorAgentId: agentId, createdAt: new Date(5_000),
        sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: issueId } },
      { companyId, issueId, body: "FUTURE MESSAGE", authorUserId: "user", createdAt: new Date(30_000) },
    ]);
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ conversationBoundaryCommentId: boundaryId }).where(eq(issues.id, issueId));
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(6_000), resolvedAt: new Date(7_000),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "Use CODEOWNERS and publish a Storybook per PR" },
    });
    // An activity can start before the wake while its answer arrives later.
    // The answer timestamp, not just the activity's start, fences replay.
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(2_500), resolvedAt: new Date(3_500),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "LATER CUTOFF DECISION" },
    });
    const laterAnswerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterAnswerRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(2_500), finishedAt: new Date(3_600),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "LATER CUTOFF RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: laterAnswerRunId, seq: 1, eventType: "item.completed", createdAt: new Date(3_500),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "LATER CUTOFF REPLY" } } } });
    const runId = randomUUID(), documentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(8_000), finishedAt: new Date(9_500),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "Waiting for GitHub access before configuring PR checks" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(9_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "Repository research complete; next configure PR checks" } } } });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Saved plan: review changed files by CODEOWNERS", updatedAt: new Date(10_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan", createdAt: new Date(10_000) });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, conversationSessionGeneration: 2 },
        resultJson: { summary: "Legacy answer: repository selection is complete" }, createdAt: new Date(12_000), finishedAt: new Date(13_000) },
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId: randomUUID(), conversationSessionGeneration: 2 },
        resultJson: { summary: "UNRELATED TASK ANSWER" }, createdAt: new Date(14_000), finishedAt: new Date(15_000) },
    ]);
  }, 120_000);
  afterAll(async () => database?.cleanup());

  async function microsecondHistory() {
    const taskId = randomUUID(), currentRunId = randomUUID(), priorRunId = randomUUID();
    const ids = Array.from({ length: 7 }, () => randomUUID()).sort();
    const boundary = ids[1]!, cutoff = ids[4]!, artifactId = randomUUID();
    const at = (fraction: string) => sql`${`2026-10-16T00:00:00.${fraction}Z`}::timestamptz`;
    await db.insert(issues).values({ id: taskId, companyId, title: "Exact timestamp history", status: "in_progress",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: taskId,
      conversationState: "active", conversationSessionGeneration: 3 });
    await db.insert(issueComments).values([
      { id: ids[0], companyId, issueId: taskId, authorUserId: "user", body: "OLD BOUNDARY TIE", createdAt: at("000200") },
      { id: boundary, companyId, issueId: taskId, authorUserId: "user", body: "/new PRIVATE RESET", createdAt: at("000200") },
      { id: ids[2], companyId, issueId: taskId, authorUserId: "user", body: "NEW BOUNDARY TIE", createdAt: at("000200") },
      { id: ids[3], companyId, issueId: taskId, authorUserId: "user", body: "EARLIER CUTOFF TIE", createdAt: at("000500") },
      { id: cutoff, companyId, issueId: taskId, authorUserId: "user", body: "EXACT LATEST REQUEST", createdAt: at("000500") },
      { id: ids[5], companyId, issueId: taskId, authorUserId: "user", body: "LATER CUTOFF TIE", createdAt: at("000500") },
      { id: ids[6], companyId, issueId: taskId, authorUserId: "user", body: "AFTER CURRENT RUN", createdAt: at("000900") },
    ]);
    await db.update(issues).set({ conversationBoundaryCommentId: boundary }).where(eq(issues.id, taskId));
    await db.insert(documents).values({ id: artifactId, companyId, latestBody: "MICROSECOND PROPOSAL ARTIFACT",
      createdAt: at("000450"), updatedAt: at("000450") });
    await db.insert(issueDocuments).values({ companyId, issueId: taskId, documentId: artifactId, key: "proposal", createdAt: at("000450") });
    await db.insert(heartbeatRuns).values([
      { id: priorRunId, companyId, agentId, status: "succeeded", nativeIssueId: taskId,
        contextSnapshot: { issueId: taskId, conversationSessionGeneration: 3 }, createdAt: at("000300"), finishedAt: at("000450"),
        runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "MICROSECOND COMPLETED PROPOSAL" } } } },
      { id: currentRunId, companyId, agentId, status: "queued", nativeIssueId: taskId,
        contextSnapshot: { issueId: taskId, conversationSessionGeneration: 3, commentId: cutoff }, createdAt: at("000800") },
    ]);
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, currentRunId));
    expect(current!.createdAt.toISOString()).toBe("2026-10-16T00:00:00.000Z");
    return { taskId, currentRunId, cutoff, artifactId, before: current!.createdAt, futureCommentId: ids[6]! };
  }

  it("keeps exact PostgreSQL microsecond wake and reset tuple boundaries", async () => {
    const f = await microsecondHistory();
    const result = await buildNativeSessionHandoff({ db, companyId, agentId, issueId: f.taskId,
      before: f.before, beforeRunId: f.currentRunId, throughCommentId: f.cutoff });
    expect(result).toContain("NEW BOUNDARY TIE");
    expect(result).toContain("EARLIER CUTOFF TIE");
    expect(result).toContain("EXACT LATEST REQUEST");
    expect(result).toContain("MICROSECOND PROPOSAL ARTIFACT");
    expect(result).toContain(f.artifactId);
    expect(result).toContain("MICROSECOND COMPLETED PROPOSAL");
    expect(result).not.toContain("OLD BOUNDARY TIE");
    expect(result).not.toContain("PRIVATE RESET");
    expect(result).not.toContain("LATER CUTOFF TIE");
    expect(result).not.toContain("AFTER CURRENT RUN");
  }, 60_000);

  it("anchors the exact current-run cutoff and refuses missing or foreign run authority", async () => {
    const f = await microsecondHistory();
    const scope = { db, companyId, agentId, issueId: f.taskId, before: f.before };
    const result = await buildNativeSessionHandoff({ ...scope, beforeRunId: f.currentRunId });
    expect(result).toContain("EXACT LATEST REQUEST");
    expect(result).toContain("LATER CUTOFF TIE");
    expect(result).not.toContain("AFTER CURRENT RUN");
    // Date-only callers retain their explicit millisecond cutoff semantics.
    expect(await buildNativeSessionHandoff(scope)).toBeNull();
    expect(await buildNativeSessionHandoff({ ...scope, beforeRunId: randomUUID() })).toBeNull();
    const foreignRunId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other history owner", adapterType: "paperclip_runner" });
    await db.insert(heartbeatRuns).values({ id: foreignRunId, companyId, agentId: otherAgentId,
      nativeIssueId: f.taskId, status: "queued" });
    expect(await buildNativeSessionHandoff({ ...scope, beforeRunId: foreignRunId })).toBeNull();
    await db.update(heartbeatRuns).set({ agentId, nativeIssueId: issueId }).where(eq(heartbeatRuns.id, foreignRunId));
    expect(await buildNativeSessionHandoff({ ...scope, beforeRunId: foreignRunId })).toBeNull();
  }, 60_000);

  it("includes an accepted wake coalesced into an older queue while excluding newer and current-run history", async () => {
    const f = await microsecondHistory();
    await db.update(heartbeatRuns).set({ createdAt: sql`'2026-10-16T00:00:00.000300Z'::timestamptz`,
      finishedAt: sql`'2026-10-16T00:00:00.000400Z'::timestamptz`, status: "succeeded",
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "CURRENT RUN SUMMARY EXCLUDED" } } },
    }).where(eq(heartbeatRuns.id, f.currentRunId));
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: f.currentRunId, seq: 1,
      eventType: "item.completed", createdAt: sql`'2026-10-16T00:00:00.000400Z'::timestamptz`,
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "CURRENT RUN REPLY EXCLUDED" } } } });
    const scope = { db, companyId, agentId, issueId: f.taskId, before: f.before,
      beforeRunId: f.currentRunId, throughCommentId: f.cutoff };
    const result = await buildNativeSessionHandoff(scope);
    expect(result).toContain("EXACT LATEST REQUEST");
    expect(result).toContain("MICROSECOND PROPOSAL ARTIFACT");
    expect(result).not.toContain("LATER CUTOFF TIE");
    expect(result).not.toContain("AFTER CURRENT RUN");
    expect(result).not.toContain("CURRENT RUN SUMMARY EXCLUDED");
    expect(result).not.toContain("CURRENT RUN REPLY EXCLUDED");
    // A different scoped comment is not authority to extend this run's history.
    expect(await buildNativeSessionHandoff({ ...scope, throughCommentId: f.futureCommentId })).toBeNull();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskId } }).where(eq(heartbeatRuns.id, f.currentRunId));
    expect(await buildNativeSessionHandoff(scope)).toBeNull();
  }, 60_000);
  it("preserves the original goal and prior answer while excluding reset, deleted and future history", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).toContain("Final constraint: require a team review");
    expect(result).toContain('"truncated":true');
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(result).toContain("CODEOWNERS");
    expect(result).toContain("Repository research complete");
    expect(result).toContain("Saved plan");
    expect(result).toContain("Waiting for GitHub access");
    expect(result).toContain("Legacy answer: repository selection is complete");
    expect(result).not.toContain("UNRELATED TASK ANSWER");
    expect(result).not.toContain("OLD TOPIC");
    expect(result).not.toContain("Deleted private message");
    expect(result).not.toContain("FUTURE MESSAGE");
    expect(result).not.toContain("UNTRUSTED BODY");
    expect(result).not.toContain("/new");
    expect(await buildNativeSessionHandoff({ db, companyId: randomUUID(), issueId, agentId, before: new Date(20_000) })).toBeNull();
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId: randomUUID(), before: new Date(20_000) })).toBeNull();
  });
  it("honors the exact wake-comment cutoff when building a fresh replay", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: requestId });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).not.toContain("CODEOWNERS");
    expect(result).not.toContain("Legacy answer");
    expect(result).not.toContain("LATER CUTOFF DECISION");
    expect(result).not.toContain("LATER CUTOFF REPLY");
    expect(result).not.toContain("LATER CUTOFF RUN SUMMARY");
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: randomUUID() })).toBeNull();
  });

  it("loads and redacts history once only when a fresh attempt requests it", async () => {
    const select = vi.spyOn(db, "select");
    try {
      const load = createNativeSessionHandoffLoader({ db, companyId, issueId, agentId, before: new Date(20_000) });
      expect(select).not.toHaveBeenCalled();
      const first = await load();
      const reads = select.mock.calls.length;
      expect(reads).toBeGreaterThan(0);
      expect(await load()).toBe(first);
      expect(select).toHaveBeenCalledTimes(reads);
    } finally { select.mockRestore(); }
  });

  it("retains a prior run's quarantine after the current agent and task use standard policy", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", nativeIssueId: issueId,
      contextSnapshot: { issueId, conversationSessionGeneration: 2, executionPolicy: {
        trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, issueIds: [issueId] } },
      } }, createdAt: new Date(16_000), finishedAt: new Date(18_000),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "QUARANTINED RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(17_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "QUARANTINED RUN REPLY" } } } });
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).not.toContain("QUARANTINED RUN REPLY");
    expect(result).not.toContain("QUARANTINED RUN SUMMARY");
    expect(result).toContain("Quarantined low-trust output omitted");
    expect(result).toContain(runId);
  });
});
