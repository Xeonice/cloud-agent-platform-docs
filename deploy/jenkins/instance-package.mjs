import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { command } from '../upgrade/artifacts.mjs';
import { buildNativeBundle, runtimeFingerprint,probeCoordinatorDataFormats } from '../upgrade/build-distribution.mjs';
import { treeManifest, atomicJson, readJson, secureDirectory,fileDigest } from '../upgrade/io.mjs';
import { digest, invariant,canonical,loadTrustRoot,verifySignedManifest } from '../upgrade/trust.mjs';
import { validateMigrationPlan } from '../upgrade/migration-plan.mjs';
import { nativeBuildEnvironment } from '../upgrade/native-build-environment.mjs';
const SHA=/^[a-f0-9]{40}$/;
const REPOS={project:'cloud-agent-platform-docs',api:'agent-platform-api',web:'agent-platform-web'};
// ssh2 publishes upstream test-only TLS private keys. They are never runtime
// inputs and may not cross the package's private-file boundary.
const runtimeCopyAllowed=path=>!/(?:^|\/)node_modules\/ssh2\/test(?:\/|$)/.test(path);
export async function packagePinnedInstance({workspace,commits,releaseId,channel,distributionOrigin,protocols,previousBundle=null,migrationPlan=null,purpose='release',sourceRepositories=null,sourceBundles=null,run=command}) {
  invariant(['project','api','web'].every(k=>SHA.test(commits[k])),'PINNED_COMMITS_REQUIRED');
  invariant(['release','qualification'].includes(purpose)&&(!(sourceRepositories||sourceBundles)||purpose==='qualification')&&!(sourceRepositories&&sourceBundles),'PRODUCTION_SOURCE_OVERRIDE_FORBIDDEN');
  const builtOn=nativeBuildEnvironment();const root=await secureDirectory(workspace),source=join(root,'source');await fs.mkdir(source,{mode:0o700});
  const sourceWitness={};
  for(const [kind,name]of Object.entries(REPOS)){const cwd=join(source,kind);await fs.mkdir(cwd,{mode:0o700});await run('git',['init'],{cwd});const repository=sourceRepositories?.[kind],bundle=sourceBundles?.[kind];let bundleDigest=null;
    if(bundle){invariant(typeof bundle==='string'&&bundle.startsWith('/'),'QUALIFICATION_GIT_BUNDLE_REQUIRED');const stat=await fs.lstat(bundle);invariant(stat.isFile()&&!stat.isSymbolicLink(),'QUALIFICATION_GIT_BUNDLE_REQUIRED');await run('git',['bundle','verify',bundle],{cwd});const heads=(await run('git',['bundle','list-heads',bundle],{cwd})).trim().split('\n').map(line=>line.split(' '));const advertised=heads.find(([sha,ref])=>sha===commits[kind]&&/^refs\/[a-zA-Z0-9._\/-]+$/.test(ref));invariant(advertised,'QUALIFICATION_COMMIT_NOT_ADVERTISED');await run('git',['fetch',bundle,advertised[1]],{cwd});bundleDigest=(await fileDigest(bundle)).digest;
    }else{if(repository){invariant(typeof repository==='string'&&repository.startsWith('/'),'QUALIFICATION_GIT_SOURCE_REQUIRED');invariant((await run('git',['cat-file','-t',commits[kind]],{cwd:repository})).trim()==='commit','QUALIFICATION_OBJECT_NOT_COMMIT');}await run('git',['fetch','--depth=1',repository||`https://github.com/Xeonice/${name}.git`,commits[kind]],{cwd});}
    await run('git',['checkout','--detach','FETCH_HEAD'],{cwd});invariant((await run('git',['rev-parse','HEAD'],{cwd})).trim()===commits[kind],'PACKAGE_SOURCE_MISMATCH');sourceWitness[kind]={commit:commits[kind],tree:(await run('git',['rev-parse','HEAD^{tree}'],{cwd})).trim(),source:bundle?'qualification-git-bundle':repository?'qualification-git-object':'remote-pinned-commit',...(bundleDigest?{bundleDigest}:{})};}
  const api=join(source,'api'),web=join(source,'web'),project=join(source,'project');
  const webInputs = [];
  for (const name of (await run('git',['ls-files','-z'],{cwd:web})).split('\0').filter(Boolean).sort()) { const file = await fs.readFile(join(web,name)); const mode=(await fs.lstat(join(web,name))).mode&0o777; webInputs.push({path:name,mode,sha256:createHash('sha256').update(file).digest('hex')}); }
  const webFingerprint = digest({platform:process.platform,arch:process.arch,nodeMajor:22,publicApiBase:'',publicWsBase:'',files:webInputs});
  const apiFingerprint=await runtimeFingerprint(api,project,{builderVersion:process.platform==='linux'?'node22-pnpm9-rocky8-glibc228-source':'node22-pnpm9',behavior:{protocols:{api:protocols.api,coordinator:protocols.coordinator||protocols.api,owner:protocols.owner||protocols.api}}});
  let prior=null,reuseApi=false,reuseWeb=false;
  if(previousBundle){const roots=await loadTrustRoot(previousBundle.trustRootPath),envelope=await readJson(previousBundle.manifestPath);if(purpose==='release')invariant((roots.purpose||'release')==='release'&&(envelope.manifest.purpose||'release')==='release','PRODUCTION_QUALIFICATION_REUSE_FORBIDDEN');verifySignedManifest(envelope,roots);const bundle=await readJson(join(previousBundle.root,'upgrade-artifact.json'));const priorFiles=(await treeManifest(previousBundle.root)).filter(f=>!['upgrade-artifact.json','installed.json'].includes(f.path));invariant(bundle.platform===process.platform&&bundle.arch===process.arch&&canonical(bundle.components)===canonical(envelope.manifest.components)&&canonical(priorFiles)===canonical(bundle.files)&&digest(priorFiles)===bundle.treeDigest,'REUSE_ARTIFACT_NOT_VERIFIED');prior={...envelope,root:previousBundle.root};reuseApi=prior.manifest.components.api.inputFingerprint===apiFingerprint;reuseWeb=prior.manifest.components.web.inputFingerprint===webFingerprint;}
  const webRevision = webFingerprint.slice(7,47), builtAt = new Date().toISOString();
  const cleanEnv={...process.env,NEXT_PUBLIC_WEB_REVISION:webRevision,WEB_RELEASE_ID:releaseId,WEB_BUILT_AT:builtAt,NEXT_PUBLIC_API_BASE_URL:'',NEXT_PUBLIC_WS_BASE_URL:'',API_ORIGIN:'http://127.0.0.1:3001'};
  if(process.platform==='linux')cleanEnv.npm_config_build_from_source='true';
  for(const name of ['VIRTUAL_ENV','DATABASE_URL','BOXLITE_HOME','ACCESS_PASSCODE','ACCESS_COOKIE_SECRET','PASSCODE_COOKIE_SECRET','UPGRADE_ACCESS_KEY','PLATFORM_UPGRADE_RPC_KEY','PLATFORM_CONTROLLER_RPC_KEY','PLATFORM_COORDINATOR_RPC_KEY','PLATFORM_CONTROL_RPC_KEY'])delete cleanEnv[name];
  for(const cwd of [...(reuseApi?[]:[api]),...(reuseWeb?[]:[web])]){await run('corepack',['pnpm','install','--frozen-lockfile'],{cwd,env:cleanEnv});await run('corepack',['pnpm','run','build'],{cwd,env:cleanEnv});}
  for(const cwd of [project,api,web])await run('git',['diff','--exit-code','HEAD','--'],{cwd});
  const built=join(root,'built');await fs.mkdir(built,{mode:0o700});await fs.mkdir(join(built,'api'),{mode:0o700});
  if(reuseApi)await fs.cp(join(prior.root,'api'),join(built,'api'),{recursive:true,dereference:false,verbatimSymlinks:true});
  else {
    const production=join(root,'api-production');await run('corepack',['pnpm','--filter','@platform/api','deploy','--prod',production],{cwd:api,env:cleanEnv});
    await fs.cp(production,join(built,'api'),{recursive:true,dereference:false,verbatimSymlinks:true,filter:runtimeCopyAllowed});
    await fs.mkdir(join(built,'api/apps/api'),{recursive:true,mode:0o700});await fs.rename(join(built,'api/dist'),join(built,'api/apps/api/dist'));
    await fs.symlink('apps/api/dist',join(built,'api/dist'));
    // pnpm9 deploy leaves its self-workspace alias pointing at the build
    // checkout. Rebind only that known self alias to the deployed API root.
    const selfAlias=join(built,'api/node_modules/.pnpm/node_modules/@platform/api');if((await fs.lstat(selfAlias).catch(()=>null))?.isSymbolicLink()){await fs.unlink(selfAlias);await fs.symlink('../../../..',selfAlias);}
    await fs.cp(join(api,'drizzle'),join(built,'api/drizzle'),{recursive:true,dereference:false});
    // Keep the canonical introspection paths used by native/compatibility
    // readers, pointing to the same production workspace modules Node loads.
    for(const location of ['shared-kernel','contracts',...(await fs.readdir(join(api,'packages/modules'))).map(name=>'modules/'+name)]){
      const name=location.split('/').at(-1),target=join(built,'api/packages',location);await fs.mkdir(join(target,'..'),{recursive:true,mode:0o700});
      if(await fs.lstat(join(built,'api/node_modules/@platform',name)).catch(()=>null)){const relative=location.startsWith('modules/')?'../../node_modules/@platform/':'../node_modules/@platform/';await fs.symlink(relative+name,target);}
    }
  }
  if(reuseWeb)await fs.cp(join(prior.root,'web'),join(built,'web'),{recursive:true,dereference:false,verbatimSymlinks:true});
  else {await fs.cp(join(web,'.next/standalone'),join(built,'web'),{recursive:true,dereference:false,verbatimSymlinks:true});await fs.cp(join(web,'.next/static'),join(built,'web/_next/static'),{recursive:true,dereference:false,verbatimSymlinks:true});
  await fs.cp(join(web,'public'),join(built,'web/public'),{recursive:true,dereference:false,verbatimSymlinks:true});await fs.cp(join(web,'.next/static'),join(built,'web/.next/static'),{recursive:true,dereference:false,verbatimSymlinks:true});
  }
  await fs.cp(join(project,'deploy/upgrade'),join(built,'installer'),{recursive:true,dereference:true,filter:path=>!path.endsWith('.test.mjs')});
  const migration=migrationPlan?validateMigrationPlan(migrationPlan):null;
  if(migration)await atomicJson(join(built,'upgrade-migration.json'),migration.plan);
  const files=await treeManifest(built),installerFiles=files.filter(f=>f.path.startsWith('installer/'));
  const components={api:{artifactDigest:digest(files.filter(f=>f.path.startsWith('api/'))),inputFingerprint:apiFingerprint,sourceRevision:commits.api,protocol:protocols.api},web:{artifactDigest:digest(files.filter(f=>f.path.startsWith('web/'))),inputFingerprint:webFingerprint,webRevision,sourceRevision:commits.web,protocol:protocols.web},installer:{artifactDigest:digest(installerFiles),inputFingerprint:digest(installerFiles),sourceRevision:commits.project,protocol:protocols.installer}};
  if(reuseApi)components.api={...prior.manifest.components.api};if(reuseWeb)components.web={...prior.manifest.components.web};
  // Conservative role closures include the complete built API tree and its actual runtime inputs.
  // No role is considered reused on a source-tag comparison alone.
  const coordinatorDataFormats=await probeCoordinatorDataFormats(join(built,'api'),{run});components.coordinator={...components.api,protocol:protocols.coordinator||protocols.api,...(coordinatorDataFormats.length?{dataFormats:coordinatorDataFormats}:{})};components.owner={...components.api,protocol:protocols.owner||protocols.api};
  const outputRoot=join(root,'distribution'),pkg=await buildNativeBundle({builtRoot:built,outputRoot,platform:process.platform,arch:process.arch,components,releaseId,distributionOrigin,run});
  const result={purpose,sourceWitness,migrationPlanDigest:migration?.planDigest||null,reuse:{api:reuseApi,web:reuseWeb,sourceManifestDigest:prior?.manifestDigest||null},schemaVersion:1,releaseId,channel,commits,components,package:pkg,builtOn,outputRoot};await atomicJson(join(outputRoot,'bundle-receipt.json'),result);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){readJson(process.argv[2]).then(packagePinnedInstance).then(r=>process.stdout.write(JSON.stringify(r)+'\n'),e=>{process.stderr.write((e.code||'INSTANCE_PACKAGE_FAILED')+'\n');process.exitCode=1;});}
