import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {NativeSshForegroundOwner}=await import(pathToFileURL(join(process.env.FACTORY_SSH_TEST_BUILD,'server/src/services/native-runtime/native-ssh-foreground-owner.js')));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function fake(exit){let listener,stops=0,closes=0;return {write(){},onData(){},onStderr(){},onExit(fn){listener=fn;if(exit)fn(exit);},stop(){stops++;},async close(){closes++;},finish(e){exit=e;listener?.(e);},get stops(){return stops},get closes(){return closes}};}
async function fixture(t,extras={}){const root=await mkdtemp(join(tmpdir(),'native-ssh-owner-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const options={directory:root,runId:'run-fixture',runnerInstanceId:'runner-fixture',ownershipError:()=>Error('native_execution_ownership_unverified'),stageTimeoutMs:1000,openTimeoutMs:100,cleanupTimeoutMs:40,...extras};return {root,owner:new NativeSshForegroundOwner(options),options};}
const spec={command:'/controller/runner',args:['--connect-url','wss://fixture.invalid/prp','--ticket','fixture-ticket','--diagnostics-directory','/old'],cwd:'/ignored',environment:{FIXTURE:"x'\ny"}};
const launch=(owner,runner,extra={})=>owner.createLauncher({runner,remoteBinary:'/worker/runner',remoteCwd:'/workspace/task',diagnosticsDirectory:'/workspace/task/diag',ensureArtifact:async()=>{},...extra});
test('staging precedes dispatch; exact runtime argv survives; checkpoint and real exit both required',async t=>{
 const {owner,root}=await fixture(t);const gate=deferred();let input,dispatched=false;
 const channel=fake({exitCode:0});const runner={async openDuplexChannel(value){input=value;return channel}};
 const handle=launch(owner,runner,{ensureArtifact:()=>gate.promise,onDispatched:()=>dispatched=true})(spec);
 await pause(5);assert.equal(input,undefined);assert.throws(()=>owner.assertAvailable());
 gate.resolve();assert.equal((await handle.completion).code,0);assert.equal(dispatched,true);
 const executableIndex=input.command.indexOf('/worker/runner');assert.ok(executableIndex>0);
 assert.deepEqual(input.command.slice(executableIndex+1),['--connect-url','wss://fixture.invalid/prp','--ticket','fixture-ticket','--diagnostics-directory','/workspace/task/diag']);
 assert.ok(input.command.includes("FIXTURE=x'\ny"));assert.equal(handle.child.pid,undefined);
 assert.throws(()=>owner.assertAvailable());let checkpoints=0;
 await owner.checkpoint('settled',async()=>{checkpoints++});await owner.checkpoint('settled',async()=>{checkpoints++});
 owner.assertAvailable();assert.equal(checkpoints,1);
 const receipts = await readdir(root);
 for (const file of receipts) assert.equal((await readFile(join(root,file),'utf8')).includes('fixture-ticket'),false);
});
test('stop-before-open waits for completed staging and never dispatches',async t=>{
 const {owner}=await fixture(t);const stage=deferred();let opens=0;
 const handle=launch(owner,{async openDuplexChannel(){opens++;return fake({exitCode:0})}},{ensureArtifact:()=>stage.promise})(spec);
 assert.equal(handle.child.kill('SIGTERM'),true);assert.equal(handle.child.kill('SIGTERM'),false);stage.resolve();
 await assert.rejects(handle.completion,/cancelled_before_dispatch/);assert.equal(opens,0);owner.assertAvailable();
});
test('stop during an unresponsive opener is bounded and a late channel is retired',async t=>{
 const {owner}=await fixture(t);const opening=deferred();const channel=fake();
 const handle=launch(owner,{openDuplexChannel:()=>opening.promise})(spec);await pause(5);handle.child.kill();
 await assert.rejects(handle.completion,/ownership_unverified/);assert.throws(()=>owner.assertAvailable());
 opening.resolve(channel);await pause(5);assert.ok(channel.stops>0);assert.ok(channel.closes>0);
});
test('transport close without exit remains a durable hold across controller restart',async t=>{
 const {owner,options}=await fixture(t);const channel=fake({exitCode:null,transportClosed:true});
 const handle=launch(owner,{async openDuplexChannel(){return channel}})(spec);
 await assert.rejects(handle.completion,/ownership_unverified/);
 await assert.rejects(owner.checkpoint('settled',async()=>{}),/ownership_unverified/);
 const successor=new NativeSshForegroundOwner({...options,runId:'successor'});assert.throws(()=>successor.assertAvailable());
 assert.throws(()=>launch(successor,{async openDuplexChannel(){throw Error('must not open')}})(spec));
});
test('controller restart holds an active owner even if remote PID data is absent',async t=>{
 const {owner,options}=await fixture(t);const channel=fake();const h=launch(owner,{async openDuplexChannel(){return channel}})(spec);await pause(5);
 assert.throws(()=>new NativeSshForegroundOwner(options).assertAvailable());
 channel.finish({exitCode:0});await h.completion;await owner.checkpoint('settled',async()=>{});
});
test('settlement/checkpoint failure never enables successor or replays work',async t=>{
 const {owner}=await fixture(t);const h=launch(owner,{async openDuplexChannel(){return fake({exitCode:0})}})(spec);await h.completion;
 await assert.rejects(owner.checkpoint('settled',async()=>{throw Error('checkpoint fixture')}));assert.throws(()=>owner.assertAvailable());
});
test('no implicit detached fallback when duplex capability is absent',async t=>{
 const {owner}=await fixture(t);assert.throws(()=>launch(owner,{}),/channel_required/);owner.assertAvailable();
});
test('staging error does not launch; durable hold survives failure',async t=>{
 const {owner}=await fixture(t);let opens=0;
 const h=launch(owner,{async openDuplexChannel(){opens++;return fake()}},{ensureArtifact:async()=>{throw Error('stage')}})(spec);
 await assert.rejects(h.completion);assert.equal(opens,0);assert.throws(()=>owner.assertAvailable());
});
test('unsettled checkpoint cannot be upgraded by calling shutdown twice',async t=>{
 const {owner}=await fixture(t);const h=launch(owner,{async openDuplexChannel(){return fake({exitCode:0})}})(spec);await h.completion;
 await assert.rejects(owner.checkpoint('unsettled',async()=>{}));await assert.rejects(owner.checkpoint('settled',async()=>{}));assert.throws(()=>owner.assertAvailable());
});
test('stop during never-settling staging is bounded, held, and cannot dispatch later',async t=>{
 const {owner}=await fixture(t);const stage=deferred();let opens=0;
 const h=launch(owner,{async openDuplexChannel(){opens++;return fake()}},{ensureArtifact:()=>stage.promise})(spec);
 h.child.kill();await assert.rejects(h.completion);stage.resolve();await pause(5);assert.equal(opens,0);assert.throws(()=>owner.assertAvailable());
});
test('known exit followed by failed credential cleanup remains held',async t=>{
 const {owner}=await fixture(t);const channel=fake({exitCode:0});channel.close=async()=>{throw Error('cleanup')};
 const h=launch(owner,{async openDuplexChannel(){return channel}})(spec);await assert.rejects(h.completion);assert.throws(()=>owner.assertAvailable());
});
test('a verified settled predecessor permits a new foreground run, never a detached retry',async t=>{
 const {owner}=await fixture(t);let opens=0;const runner={async openDuplexChannel(){opens++;return fake({exitCode:0})}};
 const start=launch(owner,runner);await start(spec).completion;await owner.checkpoint('settled',async()=>{});
 await start(spec).completion;await owner.checkpoint('settled',async()=>{});assert.equal(opens,2);owner.assertAvailable();
});
test('local detached descendant simulation demonstrates why lost transport stays held',async t=>{
 const {owner,options}=await fixture(t);
 const {spawn}=await import('node:child_process');
 const {createSshProcessChannel}=await import(pathToFileURL(join(process.env.FACTORY_SSH_TEST_BUILD,'packages/adapter-utils/src/ssh-process-channel.js')));
 const child=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');c.unref();setInterval(()=>{},1000);`],{stdio:['pipe','pipe','pipe']});
 let descendant;
 const ready=new Promise(resolve=>child.stdout.once('data',b=>{descendant=Number(String(b).trim());resolve()}));
 t.after(()=>{if(descendant)try{process.kill(descendant,'SIGKILL')}catch{};try{child.kill('SIGKILL')}catch{}});
 const channel=createSshProcessChannel(child,{cleanup:async()=>{},termGraceMs:30,killGraceMs:30,cleanupTimeoutMs:50});
 const h=launch(owner,{async openDuplexChannel(){return channel}})(spec);await ready;h.child.kill();
 await h.completion.catch(()=>undefined);
 assert.doesNotThrow(()=>process.kill(descendant,0));
 assert.throws(()=>new NativeSshForegroundOwner(options).assertAvailable());
});
test('malformed numeric channel exit cannot retire ownership',async t=>{
 const {owner}=await fixture(t);const h=launch(owner,{async openDuplexChannel(){return fake({exitCode:NaN})}})(spec);
 await assert.rejects(h.completion,/ownership_unverified/);await assert.rejects(owner.checkpoint('settled',async()=>{}));assert.throws(()=>owner.assertAvailable());
});
