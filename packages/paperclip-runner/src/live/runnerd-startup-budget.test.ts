import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

it("allows sequential provider startup requests beyond one request timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-budget-"));
  const provider = join(root, "slow-provider.cjs");
  await writeFile(provider, `#!/usr/bin/env node
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
input.on('line', async line => {
  const message=JSON.parse(line);
  if(message.id===undefined)return;
  if(['initialize','thread/start'].includes(message.method))await new Promise(r=>setTimeout(r,16000));
  const result=message.method==='initialize'?{}:{thread:{id:'startup-budget-thread',turns:[]}};
  process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
});
input.on('close',()=>process.exit(0));
`);
  await chmod(provider, 0o755);
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary(),
    stateDirectory: root,
    codexCommand: provider,
    codexArgs: [],
  });
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: root, dynamicTools: [] });
    expect(opened).toMatchObject({ thread: { id: "startup-budget-thread" } });
    expect(bundle.evidence().codexPid).toBeGreaterThan(0);
  } finally {
    await bundle.transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 75_000);

it("surfaces provider rejection without waiting for the combined startup allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-reject-"));
  const provider = join(root, "rejected-provider.cjs");
  await writeFile(provider, `#!/usr/bin/env node
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  const message=JSON.parse(line);
  if(message.id!==undefined)process.stdout.write(JSON.stringify({id:message.id,error:{code:-32001,message:'fixture initialization rejected'}})+'\\n');
});
input.on('close',()=>process.exit(0));
`);
  await chmod(provider, 0o755);
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary(),
    stateDirectory: root,
    codexCommand: provider,
    codexArgs: [],
  });
  try {
    await expect(bundle.transport.request("thread/start", { cwd: root, dynamicTools: [] }))
      .rejects.toThrow("fixture initialization rejected");
  } finally {
    // Startup rejection does not establish a durable provider checkpoint.
    // Preserve that failure classification while proving our runner exited.
    const runnerPid = bundle.evidence().runnerPid;
    await expect(bundle.transport.close()).rejects.toBeInstanceOf(NativeSessionCloseUnrecoverableError);
    expect(runnerPid).toBeGreaterThan(0);
    expect(() => process.kill(runnerPid!, 0)).toThrow();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
