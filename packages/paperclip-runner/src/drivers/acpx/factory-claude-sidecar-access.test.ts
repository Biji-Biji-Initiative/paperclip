import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { Writable } from "node:stream";
import { FACTORY_CLAUDE_SIDECAR_FLAG, parseFactoryClaudeSidecarBinding } from "./factory-claude-sidecar-access.js";

const canary = "synthetic_claude_access_for_local_fd_test_0123456789";
function fixture() {
  const binding = { admissionId: "admission", capabilityId: "capability", workerPlanSha256: "a".repeat(64), runId: "run", normalizedSessionId: "session", environmentLeaseId: "lease", runnerInstanceId: "runner", deadlineAtMs: Date.now() + 120_000 };
  const metadata = { schema: "paperclip.factory-claude-sidecar.v1", provider: "claude", ...binding, runtimeDirectory: "/private/runtime", workingDirectory: "/private/workspace" };
  const { deadlineAtMs, ...ids } = binding;
  const access = { schema: "paperclip.factory-claude-access.v1", provider: "claude", ...ids, expiresAtMs: deadlineAtMs, accessToken: canary };
  const open = { factoryBinding: binding, agent: "claude", permissionMode: "approve-paperclip", normalizedSessionId: binding.normalizedSessionId, runtimeDirectory: metadata.runtimeDirectory, workingDirectory: metadata.workingDirectory };
  return { binding, metadata, access, open };
}

describe("Factory Claude sidecar protected startup", () => {
  let directory: string;
  let program: string;
  let compiledEntrypoint: string;
  let fifoLauncher: string;
  beforeAll(async () => {
    directory = await mkdtemp("/data/tmp/factory-claude-sidecar-");
    program = join(directory, "startup.cjs");
    const source = resolve("src/drivers/acpx/factory-claude-sidecar-access.ts");
    const bundle = await build({ stdin: { contents: `import {initializeFactoryClaudeSidecarAccess,factoryClaudeSidecarAccess,verifyFactoryClaudeSidecarOpen,verifyFactoryClaudeSidecarRun} from ${JSON.stringify(source)};
import {readFileSync,fstatSync} from 'node:fs';
initializeFactoryClaudeSidecarAccess().then(async()=>{const input=JSON.parse(readFileSync(0,'utf8'));const access=factoryClaudeSidecarAccess();if(input.advanceBeforeOpen)Date.now=()=>input.advanceBeforeOpen;if(input.open)verifyFactoryClaudeSidecarOpen(access,input.open);if(input.advanceAfterOpen)Date.now=()=>input.advanceAfterOpen;if(input.runId)verifyFactoryClaudeSidecarRun(access,input.runId);if(input.repeat)verifyFactoryClaudeSidecarOpen(access,input.open);
if(input.host){const {AcpxRuntimeHost}=await import(${JSON.stringify(resolve("src/drivers/acpx/runtime-host.ts"))});const {claimFactoryClaudeAccessHandoff}=await import(${JSON.stringify(resolve("src/drivers/acpx/factory-claude-access.ts"))});let observed;
const host=await AcpxRuntimeHost.open({...input.open,agent:'claude',model:'claude-sonnet-5',factoryClaudeAccess:access,environment:{PATH:'/usr/bin:/bin',...(input.nativeMcp?{PAPERCLIP_NATIVE_MCP_NAME:'paperclip-assigned',PAPERCLIP_NATIVE_MCP_URL:'http://127.0.0.1:3211/mcp',PAPERCLIP_NATIVE_MCP_TOKEN:'synthetic-gateway-token-0123456789'.repeat(2)}:{})},semanticTools:{tools:[{name:'report_progress',inputSchema:{type:'object'}},{name:'unknown_tool',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}],handler:async()=>({})}},
{verifyInstallation:async(profile)=>({commandDigest:profile.commandDigest,agentServerPackageJsonPath:'/unused/package.json',agentRuntimePackageJsonPath:null,openCommand:async()=>({spawn(){throw Error('no_provider_allowed')},close:async()=>{}})}),reportRetainedCleanupFailure:()=>{},openRuntime:async(options)=>{const owned=claimFactoryClaudeAccessHandoff(options.factoryClaudeAccess);observed={buffered:owned.fd===null,allowed:owned.policy.allowedMcpTools,bridge:owned.policy.bridgeUrl===options.mcpServers.find(s=>s.name==='paperclip').url,workspace:owned.policy.workspaceRoot===input.open.workingDirectory,runtime:owned.policy.runtimeRoot.startsWith(input.open.runtimeDirectory+'/'),run:owned.policy.runId,lease:owned.policy.environmentLeaseId,runner:owned.policy.runnerInstanceId};owned.close();return {identity:async()=>({acpxRecordId:'record',backendSessionId:'backend',agentSessionId:'agent'}),getStatus:async()=>({models:{currentModelId:'claude-sonnet-5'}}),startTurn(){throw Error('no_turn_allowed')},close:async()=>{}}}});
await host.close({reason:'synthetic proof complete'});process.stdout.write(JSON.stringify(observed)+'\\n');return;}
let closed=0;for(const fd of [3,4]){try{fstatSync(fd)}catch{closed++}}process.stdout.write(JSON.stringify({guarded:access!==undefined,closed})+'\\n');}).catch(()=>{process.stderr.write('factory_claude_access_unverified\\n');process.exitCode=1;});`, resolveDir: process.cwd() }, bundle: true, format: "cjs", platform: "node", write: false, logLevel: "silent", define: { "import.meta.dirname": "__dirname", "import.meta.url": "__paperclipVerifiedEntrypointUrl" }, banner: { js: "const __paperclipVerifiedEntrypointUrl=require('node:url').pathToFileURL(__filename).href;" } });
    await writeFile(program, bundle.outputFiles[0]!.contents, { mode: 0o600 });
    compiledEntrypoint = join(directory, "entrypoint.cjs");
    const entry = await build({ entryPoints: [resolve("src/cli/acpx-runtime-sidecar-bootstrap.ts")], bundle: true, format: "cjs", platform: "node", target: "node24", write: false, logLevel: "silent", define: { "import.meta.dirname": "__dirname", "import.meta.url": "__paperclipVerifiedEntrypointUrl" }, banner: { js: "const __paperclipVerifiedEntrypointUrl=require('node:url').pathToFileURL(__filename).href;" } });
    await writeFile(compiledEntrypoint, entry.outputFiles[0]!.contents, { mode: 0o600 });
    fifoLauncher = join(directory, "fifo.py");
    await writeFile(fifoLauncher, `import json,os,sys\np=json.load(sys.stdin)\nm,mw=os.pipe()\na,aw=os.pipe()\nc,cw=os.pipe()\nos.write(mw,json.dumps(p['metadata']).encode());os.close(mw)\nos.write(aw,json.dumps(p['access']).encode());os.close(aw)\nos.write(cw,json.dumps(p['commands']).encode());os.close(cw)\nos.dup2(m,3,inheritable=True);os.dup2(a,4,inheritable=True);os.dup2(c,0,inheritable=True)\nos.set_inheritable(3,True);os.set_inheritable(4,True)\nfor fd in [m,a,c]:\n if fd not in [0,3,4]:os.close(fd)\nos.execv(${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},${JSON.stringify(program)},${JSON.stringify(FACTORY_CLAUDE_SIDECAR_FLAG)}])\n`, { mode: 0o600 });
  }, 30_000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  function run(input: { metadata: unknown; access: unknown; commands?: unknown; flag?: boolean; script?: string; holdAccess?: boolean }) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [input.script ?? program, ...(input.flag === false ? [] : [FACTORY_CLAUDE_SIDECAR_FLAG])], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      let stdout = "", stderr = "";
      child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
      for (const index of [3, 4]) (child.stdio[index] as Writable).on("error", () => undefined);
      (child.stdio[3] as Writable).end(typeof input.metadata === "string" ? input.metadata : JSON.stringify(input.metadata));
      if (!input.holdAccess) (child.stdio[4] as Writable).end(typeof input.access === "string" ? input.access : JSON.stringify(input.access));
      child.stdin!.end(JSON.stringify(input.commands ?? {}));
      child.once("error", reject); child.once("close", code => { clearTimeout(deadline); resolveResult({ code, stdout, stderr }); });
    });
  }

  it("consumes two actual inherited pipes before matching session and run; closes both", async () => {
    const f = fixture();
    const result = await run({ metadata: f.metadata, access: f.access, commands: { open: f.open, runId: f.binding.runId } });
    expect(result).toEqual({ code: 0, stdout: '{"guarded":true,"closed":2}\n', stderr: "" });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
  it.each(["open", "run"])("rejects actual token expiry before %s even while its timer is delayed", async stage => {
    const f = fixture();
    f.access.expiresAtMs = Date.now() + 60_000;
    const advanced = f.access.expiresAtMs + 1;
    const commands = { open: f.open, runId: f.binding.runId, ...(stage === "open" ? { advanceBeforeOpen: advanced } : { advanceAfterOpen: advanced }) };
    expect(await run({ metadata: f.metadata, access: f.access, commands })).toEqual({ code: 1, stdout: "", stderr: "factory_claude_access_unverified\n" });
  });
  it("preserves generic absent-mode behavior without interpreting access", async () => {
    expect((await run({ metadata: "invalid", access: "invalid", flag: false })).stdout).toContain('"guarded":false');
  });
  it("refuses a public opt-in binding without the private startup capability", async () => {
    const f = fixture();
    expect(await run({ metadata: "invalid", access: "invalid", flag: false, commands: { open: f.open } })).toEqual({ code: 1, stdout: "", stderr: "factory_claude_access_unverified\n" });
  });
  it("consumes real POSIX FIFOs in addition to Node's Unix socket stdio", async () => {
    const f = fixture();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn("/usr/bin/python3", [fifoLauncher], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      let stdout = "", stderr = "";
      child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
      child.once("error", reject); child.once("close", code => { clearTimeout(deadline); resolveResult({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify({ metadata: f.metadata, access: f.access, commands: { open: f.open, runId: f.binding.runId } }));
    });
    expect(result).toEqual({ code: 0, stdout: '{"guarded":true,"closed":2}\n', stderr: "" });
  });
  it("hands actual runtime roots, authenticated bridge, and assigned catalog to runtime-host", async () => {
    const f = fixture();
    f.metadata.runtimeDirectory = join(directory, "runtime"); f.metadata.workingDirectory = join(directory, "workspace");
    f.open.runtimeDirectory = f.metadata.runtimeDirectory; f.open.workingDirectory = f.metadata.workingDirectory;
    await mkdir(f.metadata.runtimeDirectory, { mode: 0o700 }); await mkdir(f.metadata.workingDirectory, { mode: 0o700 });
    const result = await run({ metadata: f.metadata, access: f.access, commands: { open: f.open, host: true } });
    expect(result.stderr).toBe(""); expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ buffered: true, allowed: ["mcp__paperclip__report_progress", "mcp__paperclip__paperclip_finish", "mcp__paperclip__paperclip_block"], bridge: true, workspace: true, runtime: true, run: "run", lease: "lease", runner: "runner" });
    expect(JSON.stringify(result)).not.toContain(canary);
  }, 15_000);
  it("rejects an additional native MCP gateway before the provider callback", async () => {
    const f = fixture();
    f.metadata.runtimeDirectory = join(directory, "native-mcp-runtime"); f.metadata.workingDirectory = join(directory, "native-mcp-workspace");
    f.open.runtimeDirectory = f.metadata.runtimeDirectory; f.open.workingDirectory = f.metadata.workingDirectory;
    await mkdir(f.metadata.runtimeDirectory, { mode: 0o700 }); await mkdir(f.metadata.workingDirectory, { mode: 0o700 });
    expect(await run({ metadata: f.metadata, access: f.access, commands: { open: f.open, host: true, nativeMcp: true } })).toEqual({ code: 1, stdout: "", stderr: "factory_claude_access_unverified\n" });
  }, 15_000);
  it.each(["runId", "normalizedSessionId", "environmentLeaseId", "runnerInstanceId", "admissionId", "capabilityId", "workerPlanSha256"])("rejects foreign %s in either access or public open binding", async key => {
    const f = fixture();
    for (const source of ["access", "open"] as const) {
      const grant = { ...f.access };
      const open = { ...f.open, factoryBinding: { ...f.binding } };
      if (source === "access") (grant as Record<string, unknown>)[key] = "b".repeat(key === "workerPlanSha256" ? 64 : 5);
      else (open.factoryBinding as Record<string, unknown>)[key] = "b".repeat(key === "workerPlanSha256" ? 64 : 5);
      const result = await run({ metadata: f.metadata, access: grant, commands: { open } });
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("factory_claude_access_unverified\n");
    }
  });
  it.each(["agent", "permissionMode", "runtimeDirectory", "workingDirectory"])("rejects mismatched actual open %s", async key => {
    const f = fixture();
    expect((await run({ metadata: f.metadata, access: f.access, commands: { open: { ...f.open, [key]: "foreign" } } })).code).toBe(1);
  });
  it("rejects reused sidecar admission and a later foreign run", async () => {
    const f = fixture();
    expect((await run({ metadata: f.metadata, access: f.access, commands: { open: f.open, repeat: true } })).code).toBe(1);
    expect((await run({ metadata: f.metadata, access: f.access, commands: { open: f.open, runId: "foreign" } })).code).toBe(1);
  });
  it.each(["extra-metadata", "extra-access", "expired", "oversized", "alternate-provider"])("rejects %s at the actual compiled CLI before runtime initialization", async variant => {
    const f = fixture();
    let metadata: unknown = f.metadata, access: unknown = f.access;
    if (variant === "extra-metadata") metadata = { ...f.metadata, accessToken: canary };
    if (variant === "extra-access") access = { ...f.access, refreshToken: canary };
    if (variant === "expired") access = { ...f.access, expiresAtMs: Date.now() - 1 };
    if (variant === "oversized") access = " ".repeat(16_385);
    if (variant === "alternate-provider") access = { ...f.access, provider: "codex" };
    const result = await run({ metadata, access, script: compiledEntrypoint });
    expect(result).toEqual({ code: 1, stdout: "", stderr: "factory_claude_access_unverified\n" });
  });
  it("times out a non-retired input pipe before importing the actual runtime", async () => {
    const f = fixture();
    expect(await run({ metadata: f.metadata, access: "", holdAccess: true, script: compiledEntrypoint })).toEqual({ code: 1, stdout: "", stderr: "factory_claude_access_unverified\n" });
  }, 5_000);
  it("rejects secret properties and excessive lifetimes in the closed public schema", () => {
    const f = fixture();
    expect(() => parseFactoryClaudeSidecarBinding({ ...f.binding, accessToken: canary })).toThrow("factory_claude_access_unverified");
    expect(() => parseFactoryClaudeSidecarBinding({ ...f.binding, deadlineAtMs: Date.now() + 310_000 })).toThrow("factory_claude_access_unverified");
  });
});
