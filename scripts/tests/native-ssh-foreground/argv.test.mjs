import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const {buildSshArgvCommand,quoteSshArgument} = await import(pathToFileURL(join(process.env.FACTORY_SSH_TEST_BUILD,'packages/adapter-utils/src/ssh-command.js')));
const {dedicatedSshArgs,dedicatedSshClientEnvironment,validateDedicatedSshTarget} = await import(pathToFileURL(join(process.env.FACTORY_SSH_TEST_BUILD,'packages/adapter-utils/src/ssh-duplex.js')));
const local = input => spawnSync('/bin/sh',['-c',buildSshArgvCommand({cwd:process.cwd(),...input})],{encoding:'utf8',input:input.stdin});
test('full shell argv: $0/$1, empty, multiline, quote and metacharacter bytes',()=>{
 const args=['named-zero','','line1\nline2',"'\" \\ ` $() ; & | < > * ? [ ]",'☃😀'];
 const r=local({command:'/bin/sh',args:['-c','printf "%s\\0" "$0" "$@"',...args]});
 assert.equal(r.status,0);assert.deepEqual(r.stdout.split('\0').slice(0,-1),args);
});
test('non-shell env-prefix executes the executable, not a program called exec',()=>{
 const value="\n'quoted' $HOME; false";
 const r=local({command:process.execPath,args:['-e','process.stdout.write(JSON.stringify({env:process.env.FIXTURE,a:process.argv.slice(1)}))','','x\ny'],env:{FIXTURE:value}});
 assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{env:value,a:['','x\ny']});
});
test('stdin and nonzero shell exit are preserved',()=>{
 const r=local({command:'/bin/sh',args:['-c','cat; exit "$1"','label','37'],stdin:'input\nexact\n'});
 assert.equal(r.status,37);assert.equal(r.stdout,'input\nexact\n');
});
test('actual foreground wrapper preserves runner flags and diagnostics location',()=>{
 const flags=['--runner-id','fixture-runner','--ticket','fixture-not-a-live-ticket','--path','x y',''];
 const command=['/bin/sh','-c','set -eu; umask 077; mkdir -p -- "$1"; cd -- "$2"; shift 2; exec "$@"','paperclip-ssh-foreground','/tmp',process.cwd(),process.execPath,'-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','--',...flags];
 const r=local({command:command[0],args:command.slice(1)});
 assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),flags);
});
test('rejects env-name injection and NUL before execution',()=>{
 for(const name of ['X;touch /tmp/x','-x','A=B','A\nB','1BAD']) assert.throws(()=>buildSshArgvCommand({command:'true',cwd:'/tmp',env:{[name]:'x'}}));
 for(const value of ['a\0b']) {assert.throws(()=>quoteSshArgument(value));assert.throws(()=>buildSshArgvCommand({command:'true',cwd:'/tmp',env:{A:value}}));}
});
const target={host:'fixture.invalid',port:2222,username:'node',remoteCwd:'/workspace',privateKey:'fixture-private-not-a-key',knownHosts:'fixture-host-not-a-key',strictHostKeyChecking:true};
test('native auth has exactly one key and disables operator config, agent, forwarding and alternate trust',()=>{
 const args=dedicatedSshArgs(target,'/private/key','/private/hosts');
 assert.equal(args.filter(x=>x==='-i').length,1);
 for(const value of ['IdentityAgent=none','IdentitiesOnly=yes','StrictHostKeyChecking=yes','GlobalKnownHostsFile=/dev/null','KnownHostsCommand=none','CertificateFile=none','ProxyCommand=none','ProxyJump=none','PermitLocalCommand=no','ClearAllForwardings=yes','ControlMaster=no']) assert.ok(args.includes(value),value);
 assert.deepEqual(args.slice(0,2),['-F','/dev/null']);
 assert.equal(dedicatedSshClientEnvironment().SSH_AUTH_SOCK,undefined);
 assert.equal(dedicatedSshClientEnvironment().LD_PRELOAD,undefined);
});
test('native missing key/pin and option-like targets fail closed',()=>{
 for(const patch of [{privateKey:null},{knownHosts:null},{strictHostKeyChecking:false},{host:'-oProxyCommand=x'},{username:'node -x'},{port:0}]) assert.throws(()=>validateDedicatedSshTarget({...target,...patch}));
});
test('generic relative cwd is not globally prohibited by the serializer',()=>{
 const command=buildSshArgvCommand({command:'/bin/sh',args:['-c','printf ok'],cwd:'.'});
 const r=spawnSync('/bin/sh',['-c',command],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(r.stdout,'ok');
});
