#!/usr/bin/env node
/** Focused build/tests. Uses a disposable directory; no SSH/provider contact. */
import {mkdtemp,readFile,writeFile,mkdir,copyFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const packageRequire=createRequire(join(root,'packages/adapter-utils/package.json'));
const tsPackage=packageRequire.resolve('typescript/package.json');
const tsMetadata=JSON.parse(await readFile(tsPackage,'utf8'));
const compiler=resolve(dirname(tsPackage),tsMetadata.bin.tsc);
const typesRoot=process.env.FACTORY_TEST_TYPES_ROOT || dirname(dirname(packageRequire.resolve('@types/node/package.json')));
const scratch=await mkdtemp(join(tmpdir(),'paperclip-ssh-focused-'));
const source=join(scratch,'source'),build=join(scratch,'build');
const modules=[
 'packages/adapter-utils/src/ssh-command.ts',
 'packages/adapter-utils/src/ssh-process-channel.ts',
 'packages/adapter-utils/src/ssh-duplex.ts',
 'packages/adapter-utils/src/factory-worker-lease.ts',
 'packages/adapter-utils/src/factory-worker-lease-channel.ts',
 'server/src/services/native-runtime/native-ssh-foreground-owner.ts',
];
try {
 for(const file of modules){await mkdir(dirname(join(source,file)),{recursive:true});await copyFile(join(root,file),join(source,file));}
 await writeFile(join(source,'package.json'),'{"type":"module"}\n');
 // Extract the ACTUAL interfaces from the checkout, not hand-written relaxed
 // declarations. This does not replace the full package/server typechecks.
 const declarations=[];
 for(const [file,names] of [
  ['packages/adapter-utils/src/command-managed-runtime.ts',['DuplexChannelOpenInput','CommandManagedDuplexChannel']],
  ['packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts',['RunnerProcessResult','RunnerProcessHandle','RunnerProcessLaunchSpec']],
 ]){
  const text=await readFile(join(root,file),'utf8');
  // These source interfaces end at column zero; their nested members are
  // indented. Compile the extracted declarations with the installed CLI so
  // this works with TypeScript 7, which no longer exports the old compiler API.
  for(const name of names){const declaration=text.match(new RegExp(`^export interface ${name} \\{[\\s\\S]*?^\\}`, 'm'));if(!declaration)throw Error('Missing integration contract: '+name);declarations.push(declaration[0].replaceAll('./factory-worker-lease.js','./packages/adapter-utils/src/factory-worker-lease.js'));}
 }
 await writeFile(join(source,'contracts.ts'),declarations.join('\n')+`
import {openDedicatedSshDuplex} from './packages/adapter-utils/src/ssh-duplex.js';
import {NativeSshForegroundOwner} from './server/src/services/native-runtime/native-ssh-foreground-owner.js';
declare const owner: NativeSshForegroundOwner;
declare const launcherInput: Parameters<NativeSshForegroundOwner['createLauncher']>[0];
const launcher: (input: RunnerProcessLaunchSpec) => RunnerProcessHandle = owner.createLauncher(launcherInput);
const opener: (input: DuplexChannelOpenInput) => Promise<CommandManagedDuplexChannel> =
  input => openDedicatedSshDuplex({host:'fixture.invalid',port:2222,username:'node',remoteCwd:'/workspace',privateKey:'fixture-only',knownHosts:'fixture-only',strictHostKeyChecking:true},input);
void launcher; void opener;
`);
 const config={compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noUnusedLocals:true,noUnusedParameters:true,skipLibCheck:true,noEmitOnError:true,types:['node'],typeRoots:[typesRoot],paths:{'@paperclipai/adapter-utils/*':[join(source,'packages/adapter-utils/src/*.ts')]},rootDir:source,outDir:build},include:[...modules.map(p=>join(source,p)),join(source,'contracts.ts')]};
 const configPath=join(scratch,'tsconfig.json');
 await writeFile(configPath,JSON.stringify(config));
 const compilation=spawnSync(process.execPath,[compiler,'--project',configPath],{stdio:'inherit'});
 if(compilation.status!==0){process.exitCode=compilation.status ?? 1;}
 else {
  await writeFile(join(build,'package.json'),'{"type":"module"}\n');
  const packageDir=join(build,'node_modules/@paperclipai/adapter-utils');
  await mkdir(packageDir,{recursive:true});
  await symlink('../../../packages/adapter-utils/src',join(packageDir,'src'),'dir');
  await writeFile(join(packageDir,'package.json'),'{"name":"@paperclipai/adapter-utils","type":"module","exports":{"./*":"./src/*.js"}}\n');
  const testsDir=join(root,'scripts/tests/native-ssh-foreground');
  const tests=(await readdir(testsDir)).filter(p=>p.endsWith('.test.mjs')).sort().map(p=>join(testsDir,p));
  console.log(`Focused compiler: TypeScript ${tsMetadata.version}; Node ${process.version}. Not a whole-repository typecheck.`);
  const result=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit',env:{...process.env,FACTORY_SSH_TEST_BUILD:build}});
  process.exitCode=result.status ?? 1;
 }
} finally {
 if(process.env.FACTORY_TEST_RETAIN_BUILD==='1')console.log('Retained focused build:',scratch);
 else await rm(scratch,{recursive:true,force:true});
}
