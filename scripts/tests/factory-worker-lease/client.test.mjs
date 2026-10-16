import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const base=process.env.FACTORY_LEASE_TEST_BUILD;
const api=await import(pathToFileURL(join(base,'packages/adapter-utils/src/factory-worker-lease.js')));
const {admitFactoryWorkerLease}=await import(pathToFileURL(join(base,'packages/adapter-utils/src/factory-worker-lease-channel.js')));
const {NativeSshForegroundOwner}=await import(pathToFileURL(join(base,'server/src/services/native-runtime/native-ssh-foreground-owner.js')));
function desc(changes={}){
 const workspaceId=randomUUID(),workspaceRoot=`/workspace/${api.FACTORY_COMPANY_ID}/${workspaceId}`;
 return api.createFactoryWorkerLeaseDescriptor({companyId:api.FACTORY_COMPANY_ID,runId:randomUUID(),leaseId:randomUUID(),workspaceId,
  workspaceRoot,sessionId:'session:'+randomUUID(),deadlineUnixMs:Date.now()+120000,...changes});
}
const command=d=>[d.workspaceRoot+'/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd','--ticket','synthetic-bootstrap-only'];
function fakeRaw(){
 let data,err,exit,queued=[],observed,stops=0,closes=0,writes=[];
 return {
  write(x){writes.push(Buffer.from(x));},async writeInput(x){writes.push(Buffer.from(x));},endInput(){},
  onData(fn){data=fn;for(const x of queued.splice(0))fn(x);},onStderr(fn){err=fn;},
  onExit(fn){exit=fn;if(observed)fn(observed);},stop(){stops++;},async close(){closes++;},
  send(x){const b=Buffer.from(x);if(data)data(b);else queued.push(b);},
  stderr(x){err?.(Buffer.from(x));},finish(x){observed=x;exit?.(x);},
  get stops(){return stops;},get closes(){return closes;},get writes(){return writes;},
 };
}
const ack=(d,status='accepted')=>JSON.stringify({protocol:api.FACTORY_WORKER_MARKER,type:'admission',status,
 companyId:d.companyId,runId:d.runId,leaseId:d.leaseId,sessionId:d.sessionId,
 dispatchAttempted:status==='accepted',...(status==='busy'?{code:'busy'}:{})})+'\n';
const pause=ms=>new Promise(r=>setTimeout(r,ms));

test('descriptor and UTF8 argv serialize without shell interpolation',()=>{
 const d=desc(),args=[...command(d),'','x\ny',"a'\"$(false);",'λ'];
 const bytes=api.encodeFactoryWorkerLaunch(d,args,{HOME:d.filesystemDirectory+'/codex-home'});
 const parsed=JSON.parse(bytes);
 assert.deepEqual(parsed.command,args);assert.equal(bytes.at(-1),10);
 assert.equal(parsed.sessionRoot,d.workspaceRoot+'/.paperclip-runtime/paperclip-runner/sessions/'+createHash('sha256').update(d.sessionId).digest('hex'));
});
test('reject foreign, expired, traversal, untyped boolean and extra descriptor fields',()=>{
 const d=desc();
 for(const bad of [{...d,companyId:randomUUID()},{...d,deadlineUnixMs:0},{...d,deadlineUnixMs:true},
  {...d,workspaceRoot:'/workspace/x/../y'},{...d,sessionRoot:'/tmp'},{...d,extra:1}])assert.throws(()=>api.encodeFactoryWorkerLaunch(bad,command(d)));
});
test('reject secrets/config override and lone surrogate or NUL argument',()=>{
 const d=desc();
 for(const env of [{OPENAI_API_KEY:'synthetic'},{NODE_OPTIONS:'--require=x'},{HTTPS_PROXY:'http://evil'}, {HOME:'/home/operator'}])
  assert.throws(()=>api.encodeFactoryWorkerLaunch(d,command(d),env));
 for(const value of ['\ud800','x\0y'])assert.throws(()=>api.encodeFactoryWorkerLaunch(d,[...command(d),value]));
 assert.throws(()=>api.encodeFactoryWorkerLaunch(d,['/bin/sh','-c','true']));
});
test('header byte bound includes all arguments',()=>{
 const d=desc();assert.throws(()=>api.encodeFactoryWorkerLaunch(d,[...command(d),...Array(100).fill('x'.repeat(1000))]));
});
test('admission handles split first line and preserves trailing bytes',async()=>{
 const d=desc(),raw=fakeRaw();const opening=admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d)));
 const line=ack(d);raw.send(line.slice(0,10));raw.send(line.slice(10)+'tail');
 const channel=await opening;let tail='';channel.onData(b=>tail+=b.toString());assert.equal(tail,'tail');
 assert.equal(raw.writes.length,1);assert.equal(JSON.parse(raw.writes[0]).leaseId,d.leaseId);
 assert.throws(()=>channel.write(Buffer.from('not-PRP')));await assert.rejects(channel.writeInput(Buffer.from('payload')));
});
test('exit before listener is replayed exactly once',async()=>{
 const d=desc(),raw=fakeRaw();raw.send(ack(d));raw.finish({exitCode:0});
 const channel=await admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d)));
 let count=0;const fn=e=>{count++;assert.equal(e.exitCode,0);};channel.onExit(fn);channel.onExit(fn);assert.equal(count,1);
});
test('busy requires matching receipt, real 75 and successful cleanup',async()=>{
 const d=desc(),raw=fakeRaw();raw.send(ack(d,'busy'));raw.finish({exitCode:75});
 await assert.rejects(admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d))),api.FactoryWorkerBusyError);
 assert.equal(raw.closes,1);
});
test('bare 75, busy with transport loss, foreign ack and failed cleanup are not retryable busy',async()=>{
 for(const variant of ['bare','loss','foreign','cleanup']){
  const d=desc(),raw=fakeRaw();
  if(variant!=='bare')raw.send(ack(variant==='foreign'?desc():d,'busy'));
  if(variant==='cleanup')raw.close=async()=>{throw Error('synthetic cleanup failure');};
  raw.finish(variant==='loss'?{exitCode:null,transportClosed:true}:{exitCode:75});
  await assert.rejects(admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d))),error=>!(error instanceof api.FactoryWorkerBusyError));
 }
});
test('an admitted runner exit 75 remains a real runner failure, not busy',async()=>{
 const d=desc(),raw=fakeRaw();raw.send(ack(d));raw.finish({exitCode:75});
 const channel=await admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d)));
 let result;channel.onExit(x=>result=x);assert.equal(result.exitCode,75);
});
test('transport close without admission does not become a real exit',async()=>{
 const d=desc(),raw=fakeRaw();raw.finish({exitCode:null,transportClosed:true});
 await assert.rejects(admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d))));
});
test('admission timeout is bounded even if busy never receives exit',async()=>{
 const d=desc(),raw=fakeRaw();raw.send(ack(d,'busy'));
 const start=Date.now();await assert.rejects(admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d)),40));
 assert.ok(Date.now()-start<1000);assert.ok(raw.stops>0);
});
test('oversize response and raw diagnostic never leak into exception',async()=>{
 const d=desc(),raw=fakeRaw();const opening=admitFactoryWorkerLease(raw,d,api.encodeFactoryWorkerLaunch(d,command(d)),100);
 raw.stderr('sensitive-marker');raw.send('x'.repeat(5000));
 await assert.rejects(opening,e=>!e.message.includes('sensitive-marker'));
});
async function ownerFixture(t){
 const root=await mkdtemp(join(tmpdir(),'factory-owner-lease-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const d=desc();const options={directory:root,runId:d.runId,runnerInstanceId:'runner-fixture',ownershipError:()=>Error('native_execution_ownership_unverified'),cleanupTimeoutMs:1000};
 return {root,d,owner:new NativeSshForegroundOwner(options),options};
}
function launch(owner,d,runner,extra={}){return owner.createLauncher({runner,remoteBinary:command(d)[0],remoteCwd:d.workspaceRoot,
 diagnosticsDirectory:d.diagnosticsDirectory,workerLease:d,ensureArtifact:async()=>{},...extra});}
const spec=d=>({command:'/unused/controller/path',args:['--ticket','synthetic-bootstrap-only'],cwd:d.workspaceRoot,environment:{HOME:d.filesystemDirectory+'/codex-home'}});
function channel(exit={exitCode:0}){return {write(){},onData(){},onStderr(){},onExit(fn){fn(exit);},stop(){},async close(){}};}

test('owner sends runner argv and environment in typed lease seam after staging',async t=>{
 const {root,d,owner}=await ownerFixture(t);let seen,release;const stage=new Promise(r=>release=r);
 const handle=launch(owner,d,{async openDuplexChannel(x){seen=x;return channel();}},{ensureArtifact:()=>stage})(spec(d));
 await pause(5);assert.equal(seen,undefined);release();await handle.completion;
 assert.equal(seen.command[0],command(d)[0]);assert.equal(seen.workerLease.runId,d.runId);
 assert.deepEqual(seen.command.slice(1),['--ticket','synthetic-bootstrap-only','--diagnostics-directory',d.diagnosticsDirectory]);
 assert.equal(seen.environment.HOME,d.filesystemDirectory+'/codex-home');
 await owner.checkpoint('settled',async()=>{});
 for(const f of await readdir(root))assert.ok(!(await readFile(join(root,f),'utf8')).includes('synthetic-bootstrap-only'));
});
test('verified worker busy releases only unsubmitted local owner and preserves typed error',async t=>{
 const {root,d,owner}=await ownerFixture(t);
 const handle=launch(owner,d,{async openDuplexChannel(){throw new api.FactoryWorkerBusyError();}})(spec(d));
 await assert.rejects(handle.completion,api.FactoryWorkerBusyError);owner.assertAvailable();
 const records=await readdir(root);assert.ok(records.some(x=>x.startsWith('ssh-foreground-last-')));
});
test('busy cannot report safe release when the local owner record changed',async t=>{
 const {root,d,owner,options}=await ownerFixture(t);
 const handle=launch(owner,d,{async openDuplexChannel(){
  const file=join(root,'ssh-foreground-owner.json');
  const record=JSON.parse(await readFile(file,'utf8'));record.token='changed-owner';
  await writeFile(file,JSON.stringify(record));
  throw new api.FactoryWorkerBusyError();
 }})(spec(d));
 await assert.rejects(handle.completion,e=>!(e instanceof api.FactoryWorkerBusyError) && /ownership_unverified/.test(e.message));
 assert.throws(()=>new NativeSshForegroundOwner(options).assertAvailable());
});
test('unverified worker failure holds across new owner object',async t=>{
 const {d,owner,options}=await ownerFixture(t);
 const handle=launch(owner,d,{async openDuplexChannel(){throw Error('transportlost');}})(spec(d));
 await assert.rejects(handle.completion,/ownership_unverified/);
 assert.throws(()=>new NativeSshForegroundOwner(options).assertAvailable());
});
test('foreign owner/run metadata rejected before staging',async t=>{
 const {d,owner}=await ownerFixture(t);assert.throws(()=>launch(owner,{...d,runId:randomUUID()},{async openDuplexChannel(){throw Error('must not call');}}));
});
test('stop before completed staging never opens worker channel',async t=>{
 const {d,owner}=await ownerFixture(t);let finish,opens=0;const stage=new Promise(r=>finish=r);
 const handle=launch(owner,d,{async openDuplexChannel(){opens++;return channel();}},{ensureArtifact:()=>stage})(spec(d));
 handle.child.kill();finish();await assert.rejects(handle.completion,/cancelled_before_dispatch/);assert.equal(opens,0);owner.assertAvailable();
});

test('TypeScript header is accepted byte-for-byte by the production Python parser',()=>{
 const d=desc(),args=[...command(d),'',"quotes'\" and \n newline",'λ'];
 const header=api.encodeFactoryWorkerLaunch(d,args,{HOME:d.filesystemDirectory+'/codex-home'});
 const code="import sys,json;sys.path.insert(0,sys.argv[1]);from lease_protocol import parse_launch;r=parse_launch(sys.stdin.buffer.read());print(json.dumps({'command':list(r.command),'sessionRoot':r.session_root,'leaseId':r.lease_id}))";
 const result=spawnSync('python3',['-c',code,process.env.FACTORY_LEASE_TEST_WORKER_MODULES || join(process.env.FACTORY_LEASE_TEST_ROOT,'runtime/factory-worker')],{input:header,encoding:'utf8'});
 // In the app-only checkout this cross-repository fixture is run by pointing
 // FACTORY_LEASE_TEST_WORKER_MODULES at the reviewed worker files.
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{command:args,sessionRoot:d.sessionRoot,leaseId:d.leaseId});
});
