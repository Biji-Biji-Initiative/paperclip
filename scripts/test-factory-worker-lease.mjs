#!/usr/bin/env node
/** CLI compiler only: compatible with installed TypeScript 7 (no compiler API). */
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm, readdir, access, symlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists=async p=>{try{await access(p);return true;}catch{return false;}};
const compiler=process.env.FACTORY_TSC || (await exists(join(root,'node_modules/.bin/tsc')) ? join(root,'node_modules/.bin/tsc') : 'tsc');
const version=spawnSync(compiler,['--version'],{encoding:'utf8'});
if(version.status!==0)throw Error('An installed TypeScript CLI is required; no packages are downloaded');
const modules=[
 'packages/adapter-utils/src/ssh-command.ts','packages/adapter-utils/src/ssh-process-channel.ts',
 'packages/adapter-utils/src/ssh-duplex.ts','packages/adapter-utils/src/factory-worker-lease.ts',
 'packages/adapter-utils/src/factory-worker-lease-channel.ts',
 'server/src/services/native-runtime/native-ssh-foreground-owner.ts',
];
const scratch=await mkdtemp(join(tmpdir(),'factory-worker-lease-ts-'));
const source=join(scratch,'src'),build=join(scratch,'build');
try {
 const candidates=[process.env.FACTORY_NODE_TYPES];
 try { candidates.push(dirname(createRequire(join(root,'package.json')).resolve('@types/node/package.json'))); }catch{}
 candidates.push(resolve(dirname(process.execPath),'../lib/node_modules/ts-node/node_modules/@types/node'));
 const types=(await Promise.all(candidates.filter(Boolean).map(async p=>await exists(join(p,'index.d.ts'))?p:null))).find(Boolean);
 if(!types)throw Error('Install repository Node types or set FACTORY_NODE_TYPES to its @types/node directory');
 for(const file of modules){await mkdir(dirname(join(source,file)),{recursive:true});await copyFile(join(root,file),join(source,file));}
 await writeFile(join(source,'package.json'),'{"type":"module"}\n');
 await writeFile(join(scratch,'tsconfig.json'),JSON.stringify({compilerOptions:{
   target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,
   noUnusedLocals:true,noUnusedParameters:true,skipLibCheck:true,noEmitOnError:true,
   types:['node'],typeRoots:[dirname(types)],rootDir:source,outDir:build,
   paths:{'@paperclipai/adapter-utils/*':[join(source,'packages/adapter-utils/src/*.ts')]},
 },include:modules.map(p=>join(source,p))},null,2));
 const compile=spawnSync(compiler,['--project',join(scratch,'tsconfig.json'),'--pretty','false'],{stdio:'inherit'});
 if(compile.status!==0){process.exitCode=compile.status||1;}
 else {
  await writeFile(join(build,'package.json'),'{"type":"module"}\n');
  const packageDir=join(build,'node_modules/@paperclipai/adapter-utils');
  await mkdir(packageDir,{recursive:true});
  await symlink('../../../packages/adapter-utils/src',join(packageDir,'src'),'dir');
  await writeFile(join(packageDir,'package.json'),'{"name":"@paperclipai/adapter-utils","type":"module","exports":{"./*":"./src/*.js"}}\n');
  const testDir=join(root,'scripts/tests/factory-worker-lease');
  const tests=(await readdir(testDir)).filter(p=>p.endsWith('.test.mjs')).sort().map(p=>join(testDir,p));
  if(process.env.FACTORY_FOREGROUND_TEST_DIRECTORY){
   const prior=resolve(process.env.FACTORY_FOREGROUND_TEST_DIRECTORY);
   tests.push(...(await readdir(prior)).filter(p=>p.endsWith('.test.mjs')).sort().map(p=>join(prior,p)));
  }
  console.log(`Compiler ${version.stdout.trim()}; Node ${process.version}; focused modules only.`);
  const result=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit',env:{...process.env,FACTORY_LEASE_TEST_BUILD:build,FACTORY_SSH_TEST_BUILD:build,FACTORY_LEASE_TEST_ROOT:root}});
  process.exitCode=result.status??1;
 }
} finally {
 if(process.env.FACTORY_TEST_RETAIN_BUILD==='1')console.log('Retained focused build:',scratch);
 else await rm(scratch,{recursive:true,force:true});
}
