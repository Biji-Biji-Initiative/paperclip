import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFactoryClaudeAccessHandoff, factoryClaudeAccessBootstrap, type FactoryClaudeAccessPolicy } from "./factory-claude-access.js";

const TOKEN = "synthetic-claude-access-canary-0123456789abcdef";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Factory Claude access pipe and native SDK spawn boundary", () => {
  let root: string;
  let policy: FactoryClaudeAccessPolicy;
  let environment: NodeJS.ProcessEnv;
  let processStarts: number;
  beforeEach(async () => {
    root = await mkdtemp("/data/tmp/factory-claude-access-test-"); roots.push(root);
    processStarts = 0;
    const runtimeRoot = join(root, "runtime"); const workspaceRoot = join(root, "workspace");
    await mkdir(runtimeRoot, { mode: 0o700 }); await mkdir(workspaceRoot, { mode: 0o700 });
    environment = { PATH: "/usr/bin:/bin", CLAUDE_CODE_EXECUTABLE: process.execPath };
    for (const [name, directory] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", CLAUDE_CONFIG_DIR: "claude" })) {
      environment[name] = join(runtimeRoot, directory); await mkdir(environment[name]!, { mode: 0o700 });
    }
    await writeFile(join(environment.CLAUDE_CONFIG_DIR!, "settings.json"), JSON.stringify({ model: "explicit-model", availableModels: ["explicit-model"], permissions: { allow: ["mcp__paperclip__report_progress"] } }), { mode: 0o600 });
    policy = { provider: "claude", admissionId: "admission-1", capabilityId: "capability-1", workerPlanSha256: "a".repeat(64), runId: "run-1", normalizedSessionId: "native-1", environmentLeaseId: "lease-1", runnerInstanceId: "runner-1", deadlineAtMs: Date.now() + 15_000, runtimeRoot, workspaceRoot,
      bridgeUrl: "http://127.0.0.1:41234/mcp", allowedMcpTools: ["mcp__paperclip__report_progress"] };
  });
  function frame(overrides: Record<string, unknown> = {}) {
    return { schema: "paperclip.factory-claude-access.v1", provider: "claude", admissionId: policy.admissionId, capabilityId: policy.capabilityId, workerPlanSha256: policy.workerPlanSha256, runId: policy.runId, normalizedSessionId: policy.normalizedSessionId,
      environmentLeaseId: policy.environmentLeaseId, runnerInstanceId: policy.runnerInstanceId, expiresAtMs: policy.deadlineAtMs, accessToken: TOKEN, ...overrides };
  }
  async function run(body: string, value = frame(), env = environment, holdInput = false) {
    const program = `const originalPipeIdentity=require("node:fs").fstatSync(3).ino;${factoryClaudeAccessBootstrap(3, policy)}.then(async()=>{${body}}).catch(()=>{process.stderr.write("factory_claude_access_unverified");process.exitCode=1});`;
    processStarts++;
    const child = spawn(process.execPath, ["--eval", program], { cwd: policy.workspaceRoot, env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
    // Early policy refusal can close the inherited pipe before its writer.
    (child.stdio[3] as import("node:stream").Writable).on("error", () => undefined);
    if (!holdInput) (child.stdio[3] as import("node:stream").Writable).end(JSON.stringify(value));
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout, stderr };
  }
  const configure = `const configure=globalThis[Symbol.for("paperclip.factoryClaudeAccess.v1")];const options=configure({paperclip:{type:"http",url:${JSON.stringify("http://127.0.0.1:41234/mcp")}}});`;

  it("retires a held-open capability pipe at the two second deadline", async () => {
    const result = await run('process.stdout.write("unexpected-provider-import");', frame(), environment, true);
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("factory_claude_access_unverified");
  }, 10_000);

  it("consumes a real inherited pipe and gives only a separate token FD to the native child", async () => {
    const native = `const fs=require("node:fs");const separate=fs.fstatSync(3).ino!==Number(process.argv[1]);const value=fs.readFileSync(3,"utf8").trim();fs.closeSync(3);process.stdout.write(JSON.stringify({fd:process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR,scrub:process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,bearer:process.env.CLAUDE_CODE_OAUTH_TOKEN??null,api:process.env.ANTHROPIC_API_KEY??null,length:value.length,separate,argvClean:!process.argv.join(" ").includes(value)}));`;
    const result = await run(`${configure}const child=options.spawnClaudeCodeProcess({command:process.execPath,args:["-e",${JSON.stringify(native)},String(originalPipeIdentity)],cwd:process.cwd(),env:process.env});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);`);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ fd: "3", scrub: "1", bearer: null, api: null, length: TOKEN.length, separate: true, argvClean: true });
    expect(result.stderr).toBe(""); expect(result.stdout).not.toContain(TOKEN);
  });
  it("redacts token bytes across stdout and stderr chunks", async () => {
    const native = `const value=require("node:fs").readFileSync(3,"utf8").trim();process.stdout.write(value.slice(0,15));setTimeout(()=>{process.stdout.write(value.slice(15));process.stderr.write(value)},20);`;
    const result = await run(`${configure}const child=options.spawnClaudeCodeProcess({command:process.execPath,args:["-e",${JSON.stringify(native)}],cwd:process.cwd(),env:process.env});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);`);
    expect(result.code).toBe(0); expect(result.stdout).toBe("[REDACTED]"); expect(result.stderr).toBe("[REDACTED]");
  });
  it("redacts bounded encoded variants split across stream chunks", async () => {
    const native = `const value=require("node:fs").readFileSync(3,"utf8").trim();const buffer=Buffer.from(value);const variants=[value,buffer.toString("base64"),buffer.toString("base64url"),buffer.toString("base64").replace(/=+$/,""),buffer.toString("hex"),buffer.toString("hex").toUpperCase()];let index=0;const next=()=>{if(index===variants.length)return;const text=variants[index++];const half=Math.floor(text.length/2);process.stdout.write(text.slice(0,half));setTimeout(()=>{process.stdout.write(text.slice(half)+"\\n");process.stderr.write(text+"\\n");next()},10)};next();`;
    const result = await run(`${configure}const child=options.spawnClaudeCodeProcess({command:process.execPath,args:["-e",${JSON.stringify(native)}],cwd:process.cwd(),env:process.env});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);`);
    expect(result.code).toBe(0); expect(result.stdout).toBe("[REDACTED]\n".repeat(6)); expect(result.stderr).toBe("[REDACTED]\n".repeat(6));
  });
  it("emits persistent SDK handshake lines and split UTF8 without waiting for process exit", async () => {
    const native = `require("node:fs").readFileSync(3);const text=Buffer.from('{"handshake":"🙂"}\\n');const split=text.indexOf(0xf0)+1;process.stdout.write(text.subarray(0,split));setTimeout(()=>process.stdout.write(text.subarray(split)),10);process.stdin.once("data",()=>process.exit(0));process.stdin.resume();`;
    const result = await run(`${configure}const child=options.spawnClaudeCodeProcess({command:process.execPath,args:["-e",${JSON.stringify(native)}],cwd:process.cwd(),env:process.env});let output="";const timer=setTimeout(()=>{process.exitCode=1;child.kill()},2000);child.stdout.on("data",data=>{output+=data;if(output.includes("\\n")){clearTimeout(timer);child.stdin.end("done")}});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);`);
    expect(result.code).toBe(0); expect(result.stdout).toBe('{"handshake":"🙂"}\n');
  });
  it("rejects a policy extending beyond the worker's 300 second lease", async () => {
    policy.deadlineAtMs = Date.now() + 600_000;
    await expect(run('process.stdout.write("unexpected_start")')).rejects.toThrow("factory_claude_access_unverified");
    expect(processStarts).toBe(0);
  });
  it("rejects extra credential properties before cloning, argv construction or spawn", async () => {
    Object.assign(policy, { accessToken: TOKEN });
    expect(() => createFactoryClaudeAccessHandoff(3, policy)).toThrow("factory_claude_access_unverified");
    expect(() => factoryClaudeAccessBootstrap(3, policy)).toThrow("factory_claude_access_unverified");
    await expect(run('process.stdout.write("unexpected_start")')).rejects.toThrow("factory_claude_access_unverified");
    expect(processStarts).toBe(0);
  });
  it("rejects nested secret objects and policy serialization hooks without invoking them", () => {
    const serialize = vi.fn(() => ({ accessToken: TOKEN }));
    const get = vi.fn(() => TOKEN);
    const variants = [
      { ...policy, allowedMcpTools: [{ accessToken: TOKEN }] },
      Object.assign([...policy.allowedMcpTools], { toJSON: serialize }),
    ];
    expect(() => factoryClaudeAccessBootstrap(3, variants[0] as unknown as FactoryClaudeAccessPolicy)).toThrow("factory_claude_access_unverified");
    expect(() => factoryClaudeAccessBootstrap(3, { ...policy, allowedMcpTools: variants[1] } as FactoryClaudeAccessPolicy)).toThrow("factory_claude_access_unverified");
    expect(() => factoryClaudeAccessBootstrap(3, { ...policy, toJSON: serialize } as FactoryClaudeAccessPolicy)).toThrow("factory_claude_access_unverified");
    Object.defineProperty(policy, "runId", { get });
    expect(() => factoryClaudeAccessBootstrap(3, policy)).toThrow("factory_claude_access_unverified");
    expect(serialize).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it("has no builtin tools, refuses unknown MCP/Read/Shell and removes alternate SDK sources", async () => {
    const result = await run(`${configure}const denied=await Promise.all(["Read","Bash","Write","mcp__unknown__report_progress","mcp__paperclip__unknown_tool","mcp__paperclip_assigned__report_progress"].map(name=>options.canUseTool(name,{})));const allowed=await options.canUseTool("mcp__paperclip__report_progress",{status:"ok"});process.stdout.write(JSON.stringify({tools:options.tools,allowedTools:options.allowedTools,denied:denied.map(value=>value.behavior),allowed:allowed.behavior,bypass:options.allowDangerouslySkipPermissions,extraArgs:options.extraArgs,plugins:options.plugins,settings:options.settings}));`);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ tools: [], allowedTools: policy.allowedMcpTools, denied: ["deny", "deny", "deny", "deny", "deny", "deny"], allowed: "allow", bypass: false, extraArgs: {}, plugins: [], settings: {} });
  });
  it.each([{ provider: "codex" }, { admissionId: "different" }, { capabilityId: "different" }, { workerPlanSha256: "b".repeat(64) }, { runId: "different" }, { normalizedSessionId: "different" }, { environmentLeaseId: "different" }, { runnerInstanceId: "different" }, { expiresAtMs: 0 }, { extra: true }, { accessToken: "short" }])("rejects invalid or foreign binding before installing tools %#", async invalid => {
    const result = await run('process.stdout.write("unexpected_start")', frame(invalid));
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("factory_claude_access_unverified");
  });
  it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_HOST_CREDS_FILE"])("refuses ambient %s instead of falling back", async name => {
    const result = await run('process.stdout.write("unexpected_start")', frame(), { ...environment, [name]: "synthetic-alternate" });
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("factory_claude_access_unverified");
  });
  it("rejects a retained OAuth credential and unsafe settings", async () => {
    await writeFile(join(environment.CLAUDE_CONFIG_DIR!, ".credentials.json"), "{}", { mode: 0o600 });
    const result = await run('process.stdout.write("unexpected_start")');
    expect(result.code).toBe(1); expect(result.stdout).toBe("");
  });
  it("consumes a capability once even if the SDK tries another spawn", async () => {
    const result = await run(`${configure}const input={command:process.execPath,args:["-e","require('node:fs').readFileSync(3);"],cwd:process.cwd(),env:process.env};const first=options.spawnClaudeCodeProcess(input);try{options.spawnClaudeCodeProcess(input);process.stdout.write("unexpected")}catch{process.stdout.write("second_spawn_rejected")}first.stdout.resume();first.stderr.resume();`);
    expect(result.code).toBe(0); expect(result.stdout).toBe("second_spawn_rejected");
  });
  it("retires the owned ACP process at access expiry", async () => {
    policy.deadlineAtMs = Date.now() + 2_000;
    const result = await run("setInterval(()=>{},1000)");
    expect(result.signal).toBe("SIGTERM"); expect(result.stdout).toBe("");
  });
});
