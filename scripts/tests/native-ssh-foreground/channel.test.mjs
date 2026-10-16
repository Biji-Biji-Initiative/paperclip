import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const {createSshProcessChannel,classifySshExit} = await import(pathToFileURL(join(process.env.FACTORY_SSH_TEST_BUILD,'packages/adapter-utils/src/ssh-process-channel.js')));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function make(script,options={}){
 let cleanups=0;
 const child=spawn(process.execPath,['-e',script],{stdio:['pipe','pipe','pipe']});
 const channel=createSshProcessChannel(child,{cleanup:async()=>{cleanups++;},termGraceMs:30,killGraceMs:30,cleanupTimeoutMs:50,...options});
 return {child,channel,cleanups:()=>cleanups};
}
const exitOf=channel=>new Promise(resolve=>channel.onExit(resolve));
test('exit-before-listener and output-before-listener are replayed exactly once',async()=>{
 const x=make('process.stdout.write("first");process.stderr.write("detail");process.exitCode=19;');
 await pause(150);
 let out='',err='',exits=0;
 x.channel.onData(b=>out+=Buffer.from(b).toString());x.channel.onStderr(b=>err+=Buffer.from(b).toString());
 const exit=await new Promise(resolve=>x.channel.onExit(e=>{exits++;resolve(e);}));
 assert.equal(out,'first');assert.equal(err,'detail');assert.deepEqual(exit,{exitCode:19});
 await Promise.all([x.channel.close(),x.channel.close()]);assert.equal(exits,1);assert.equal(x.cleanups(),1);
});
test('duplex input preserves binary bytes and explicit EOF',async()=>{
 const x=make('process.stdin.pipe(process.stdout)');let out=[];
 x.channel.onData(b=>out.push(Buffer.from(b)));x.channel.onStderr(()=>{});const done=exitOf(x.channel);
 const data=Buffer.from([0,1,2,255,10,13]);x.channel.write(data);x.channel.endInput();
 assert.deepEqual(await done,{exitCode:0});await x.channel.close();assert.deepEqual(Buffer.concat(out),data);
});
test('transport 255 and signal exit are not real remote-exit receipts',()=>{
 assert.deepEqual(classifySshExit(255,null,false),{exitCode:null,transportClosed:true});
 assert.deepEqual(classifySshExit(null,'SIGKILL',false),{exitCode:null,transportClosed:true});
 assert.deepEqual(classifySshExit(0,null,true),{exitCode:null,transportClosed:true});
 assert.deepEqual(classifySshExit(254,null,false),{exitCode:254});
});
test('TERM-resistant local ssh substitute is killed; close twice stays unverified',async()=>{
 const x=make('process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)',{killGraceMs:2000});
 await new Promise(resolve=>x.channel.onData(()=>resolve()));x.channel.onStderr(()=>{});
 const done=exitOf(x.channel);x.channel.stop();x.channel.stop();
 const first=x.channel.close(),second=x.channel.close();assert.strictEqual(first,second);
 await assert.rejects(first,/native_ssh_transport_unverified/);assert.equal((await done).transportClosed,true);
 assert.throws(()=>process.kill(x.child.pid,0));assert.equal(x.cleanups(),1);
});
test('already-aborted open signal retires the started local substitute',async()=>{
 const abort=new AbortController();abort.abort();
 const x=make('setInterval(()=>{},1000)',{signal:abort.signal});
 assert.equal((await exitOf(x.channel)).transportClosed,true);await assert.rejects(x.channel.close());
});
test('bounded early-output overflow cannot be mistaken for a successful command',async()=>{
 const x=make('process.stdout.write("x".repeat(65536));setInterval(()=>{},1000)',{maxPendingBytes:64});
 assert.equal((await exitOf(x.channel)).transportClosed,true);await assert.rejects(x.channel.close());
});
test('cleanup failure remains observable after a real exit',async()=>{
 const x=make('process.exit(0)',{cleanup:async()=>{throw Error('fixture');}});
 assert.equal((await exitOf(x.channel)).exitCode,0);await assert.rejects(x.channel.close(),/unverified/);
});
test('spawn error before any listener does not become unhandled or exit zero',async()=>{
 const child=spawn('/fixture/does-not-exist',[],{stdio:['pipe','pipe','pipe']});
 const channel=createSshProcessChannel(child,{cleanup:async()=>{}});
 await pause(20);assert.equal((await exitOf(channel)).transportClosed,true);await assert.rejects(channel.close());
});
test('large staging stdin can stream with backpressure without a one-shot buffer overflow',async()=>{
 const x=make('let n=0;process.stdin.on("data",b=>n+=b.length);process.stdin.on("end",()=>process.stdout.write(String(n)))');
 let out='';x.channel.onData(b=>out+=Buffer.from(b).toString());x.channel.onStderr(()=>{});const done=exitOf(x.channel);
 for(let n=0;n<48;n++)await x.channel.writeInput(Buffer.alloc(65536,65));
 x.channel.endInput();assert.equal((await done).exitCode,0);await x.channel.close();assert.equal(out,String(48*65536));
});
