import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { digest, canonical, signManifest, signQualificationManifest, runInputFingerprint, validateManifest, invariant } from './trust.mjs';
import { treeManifest, fileDigest, atomicJson, secureDirectory, readJson } from './io.mjs';
import { command } from './artifacts.mjs';
import { nativeBuildEnvironment } from './native-build-environment.mjs';
const ENTRY_FILES=['apps/api/dist/roles/coordinator-main.js','apps/api/dist/roles/coordinator-prepared-main.js','apps/api/dist/roles/control-api-main.js','apps/api/dist/roles/runtime-owner-main.js'];
export async function probeProductionControlDependencies(apiRoot,{run=command,node=process.execPath}={}) {
  // The transport main is guarded by require.main===module. Loading it in a
  // separate process checks the actual production dependency closure without
  // importing Coordinator/Owner bootstrap or creating a database/SDK home.
  const script="require('./apps/api/dist/roles/control-api-main.js');process.stdout.write('production-control-dependencies-passed')";
  const result=await run(node,['-e',script],{cwd:resolve(apiRoot),env:{NODE_ENV:'production',PATH:process.env.PATH||'/usr/bin:/bin'}});
  invariant(result.trim()==='production-control-dependencies-passed','PRODUCTION_CONTROL_DEPENDENCIES_FAILED');
  return {kind:'production-dependencies',result:'passed',entry:ENTRY_FILES[2],startsListeners:false,opensDatabase:false,opensSdkHome:false};
}
export async function probeCoordinatorCapabilities(apiRoot,{run=command,node=process.execPath}={}) {
  const root=resolve(apiRoot),base='apps/api/dist/platform/upgrade/';
  const available=[];
  for(const name of ['upgrade-project-projection.js','upgrade-service.js']){
    const stat=await fs.lstat(join(root,base,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(stat){invariant(stat.isFile()&&!stat.isSymbolicLink(),'COORDINATOR_CAPABILITY_FACTORY_INVALID');available.push(name);}
  }
  if(!available.length)return {};
  // Read declarations from the actual deployed closure and require its real DI
  // bindings. Never infer a feature from the checkout/tag or edit old receipts.
  const script=`
    const {createRequire}=require('node:module');
    const base='./apps/api/dist/platform/upgrade/';
    const r=createRequire(require.resolve(base+'upgrade.module.js'));
    r('reflect-metadata');
    const {MODULE_METADATA}=r('@nestjs/common/constants');
    const {UpgradeModule}=require(base+'upgrade.module.js');
    const providers=Reflect.getMetadata(MODULE_METADATA.PROVIDERS,UpgradeModule)||[];
    const capabilities={};
    const checked=(values,allowed)=>{
      if(!Array.isArray(values)||values.some(x=>!allowed.includes(x))||new Set(values).size!==values.length)throw Error('Unsupported capability');
      return values;
    };
    if(${JSON.stringify(available)}.includes('upgrade-project-projection.js')){
      const {PROJECT_READ_PROJECTION}=r('@platform/project');
      const f=require(base+'upgrade-project-projection.js');
      const bound=providers.find(x=>x&&x.provide===PROJECT_READ_PROJECTION);
      if(bound&&bound.useFactory!==f.createUpgradeProjectProjection)throw Error('Capability binding differs');
      if(bound)capabilities.dataFormats=checked(f.UPGRADE_PROJECT_DATA_FORMATS,['project-name-v2-authority']);
    }
    if(${JSON.stringify(available)}.includes('upgrade-service.js')){
      const f=require(base+'upgrade-service.js');
      if(f.UPGRADE_OPERATION_DATA_FORMATS!==undefined){
        const {UpgradeOperationStore}=require(base+'upgrade-operation-store.js');
        const {UpgradeProjection}=require(base+'upgrade-projection.js');
        if(![f.UpgradeService,UpgradeOperationStore,UpgradeProjection].every(x=>typeof x==='function'&&providers.includes(x))||typeof f.UpgradeService.prototype.onApplicationBootstrap!=='function'||typeof f.UpgradeService.prototype.advanceOperation!=='function')throw Error('Upgrade operation driver not bound');
        capabilities.upgradeOperationFormats=checked(f.UPGRADE_OPERATION_DATA_FORMATS,['upgrade-plan-v1']);
      }
    }
    process.stdout.write('production-coordinator-capabilities:'+JSON.stringify(capabilities));
  `;
  const result=await run(node,['-e',script],{cwd:root,env:{NODE_ENV:'production',PATH:process.env.PATH||'/usr/bin:/bin'}});
  invariant(result.startsWith('production-coordinator-capabilities:'),'COORDINATOR_CAPABILITY_PROBE_FAILED');
  return JSON.parse(result.slice('production-coordinator-capabilities:'.length));
}
export async function probeCoordinatorDataFormats(apiRoot,options={}) {
  return (await probeCoordinatorCapabilities(apiRoot,options)).dataFormats||[];
}
export async function probeProductionWebDependencies(webRoot,{run=command,node=process.execPath}={}){
  // Do not require standalone server.js, which binds a listener immediately.
  const script="const{createRequire}=require('node:module');const r=createRequire(process.cwd()+'/server.js');r('next');process.stdout.write('production-web-dependencies-passed')";
  const result=await run(node,['-e',script],{cwd:resolve(webRoot),env:{NODE_ENV:'production',PATH:process.env.PATH||'/usr/bin:/bin'}});invariant(result.trim()==='production-web-dependencies-passed','PRODUCTION_WEB_DEPENDENCIES_FAILED');return {kind:'production-web-dependencies',result:'passed',startsListeners:false};
}
export async function buildNativeBundle({builtRoot,outputRoot,platform,arch,components,releaseId,distributionOrigin,run=command}) {
  nativeBuildEnvironment();
  invariant(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(releaseId),'INVALID_PACKAGE_RELEASE');
  invariant(platform===process.platform&&arch===process.arch&&Number(process.versions.node.split('.')[0])===22,'NATIVE_BUILD_ARCHITECTURE_MISMATCH');
  builtRoot=resolve(builtRoot);outputRoot=await secureDirectory(outputRoot);await treeManifest(builtRoot);
  for(const entry of ENTRY_FILES)invariant((await fs.lstat(join(builtRoot,'api',entry))).isFile(),'THREE_ROLE_BUILD_REQUIRED');
  invariant((await fs.lstat(join(builtRoot,'web/server.js'))).isFile(),'SELF_HOSTED_WEB_REQUIRED');
  const u=new URL(distributionOrigin);invariant(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash,'INVALID_DISTRIBUTION_ORIGIN');
  const stage=await fs.mkdtemp(join(outputRoot,'.bundle-'));
  try {
    // Preserve contained pnpm links: multiple physical copies would give
    // @platform/contracts different Symbol tokens and break Nest DI.
    await fs.cp(builtRoot,stage,{recursive:true,dereference:false,verbatimSymlinks:true});
    const files=await treeManifest(stage);
    const api=files.filter(f=>f.path.startsWith('api/')),web=files.filter(f=>f.path.startsWith('web/'));
    invariant(digest(api)===components.api.artifactDigest&&digest(web)===components.web.artifactDigest&&digest(api)===components.coordinator.artifactDigest&&(!components.owner||digest(api)===components.owner.artifactDigest)&&digest(files.filter(f=>f.path.startsWith('installer/')))===components.installer.artifactDigest,'COMPONENT_TREE_IDENTITY_MISMATCH');
    const apiRoot=join(stage,'api');
    await probeProductionControlDependencies(apiRoot,{run});
    await probeProductionWebDependencies(join(stage,'web'),{run});
    const probe="const{createRequire}=require('node:module');const r=createRequire(process.cwd()+'/package.json');const D=r('better-sqlite3');const db=new D(':memory:');if(db.prepare('select 1 as ok').get().ok!==1)throw Error('SQLite');db.close();if(process.platform!==process.env.EXPECT_PLATFORM||process.arch!==process.env.EXPECT_ARCH)throw Error('Native ABI');const sdk=r('./packages/modules/sandbox/dist/infrastructure/providers/boxlite/boxlite-runtime.js');sdk.assertBoxliteSdkAvailable().then(()=>process.stdout.write('native-abi-passed'),()=>{process.exitCode=1})";
    const result=await run(process.execPath,['-e',probe],{cwd:apiRoot,env:{...process.env,EXPECT_PLATFORM:platform,EXPECT_ARCH:arch}});invariant(result.trim()==='native-abi-passed','NATIVE_ABI_PROBE_FAILED');
    const bundle={schemaVersion:1,releaseId,platform,arch,nodeMajor:22,nodeABI:process.versions.modules,components,treeDigest:digest(files),files};await atomicJson(join(stage,'upgrade-artifact.json'),bundle);
    const name=`agent-platform-${releaseId}-${platform}-${arch}.tgz`,path=join(outputRoot,name);invariant(!(await fs.lstat(path).catch(()=>null)),'IMMUTABLE_PACKAGE_EXISTS');
    await run('tar',['-czf',path,'-C',stage,'.']);await fs.chmod(path,0o600);const hash=await fileDigest(path);
    return {platform,arch,name,url:new URL(releaseId+'/'+name,u.href.endsWith('/')?u.href:u.href+'/').href,...hash,unpackedBytes:files.reduce((n,f)=>n+(f.bytes||0),0),format:'native-tar'};
  }finally{await fs.rm(stage,{recursive:true,force:true});}
}
export async function buildSignedDistribution({manifest,outputRoot,keyId,privateKeyPath,gateReportPaths}) {
  const output=await secureDirectory(outputRoot),s=await fs.lstat(privateKeyPath);invariant(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'INSECURE_RELEASE_SIGNING_KEY');
  invariant(manifest.runInputFingerprint===runInputFingerprint(manifest),'SIGNED_INPUT_FINGERPRINT_MISMATCH');
  const evidence=[];
  for(const path of gateReportPaths){const report=await readJson(path);invariant(report.result==='passed'&&report.skipped===0&&report.substituted!==true&&canonical(report.commits)===canonical(manifest.commits),'NON_CURRENT_RELEASE_GATE');
    invariant(report.inputFingerprint===manifest.runInputFingerprint,'GATE_INPUT_FINGERPRINT_MISMATCH');const actual=await fileDigest(path);evidence.push({...report,reportDigest:actual.digest});
  }
  const fixed={...manifest,evidence};validateManifest(fixed);
  for(const pkg of fixed.packages){const actual=await fileDigest(join(output,pkg.name));invariant(actual.digest===pkg.digest&&actual.bytes===pkg.bytes,'DISTRIBUTION_PACKAGE_CHANGED');}
  const signed=signManifest(fixed,keyId,await fs.readFile(privateKeyPath,'utf8'));const signedPath=join(output,'signed-release.json');
  invariant(!(await fs.lstat(signedPath).catch(()=>null)),'IMMUTABLE_MANIFEST_EXISTS');await atomicJson(signedPath,signed);
  const catalogue={schemaVersion:1,channel:fixed.channel,releases:[{releaseId:fixed.releaseId,manifestDigest:signed.manifestDigest,envelope:signed}]};await atomicJson(join(output,'catalog.json'),catalogue);
  return {state:'published-artifacts',releaseId:fixed.releaseId,manifestDigest:signed.manifestDigest,outputRoot:output,packages:fixed.packages};
}
export async function buildQualificationDistribution({manifest,outputRoot,instanceId,runId}) {
  // This key is never exported to or accepted by the production signing domain.
  const output=await secureDirectory(outputRoot),keyId='qualification-'+runId;
  for(const pkg of manifest.packages){const actual=await fileDigest(join(output,pkg.name));invariant(actual.digest===pkg.digest&&actual.bytes===pkg.bytes,'QUALIFICATION_PACKAGE_CHANGED');}
  const inputFingerprint=runInputFingerprint(manifest),evidence=[];
  for(const kind of ['build','contracts','four-combinations','native-continuity','fault-recovery',...(manifest.upgradePaths.some(p=>p.migrationPlanDigest)?['online-migration']:[])]) {
    const pending={kind,result:'not-run',inputFingerprint,runId,recordedAt:new Date().toISOString(),reason:'Isolated qualification has not yet executed this gate.'};const path=join(output,'qualification-'+kind+'.json');await atomicJson(path,pending);evidence.push({...pending,reportDigest:(await fileDigest(path)).digest});
  }
  for(const plan of manifest.contractPlans||[]){const pending={kind:'semantic-contract',result:'not-run',contractPlanDigest:plan.planDigest,inputFingerprint,runId,recordedAt:new Date().toISOString(),reason:'This independent semantic contract has not yet executed in the isolated installation.'};const path=join(output,'qualification-semantic-contract-'+plan.planDigest.slice(7)+'.json');await atomicJson(path,pending);evidence.push({...pending,reportDigest:(await fileDigest(path)).digest});}
  const keys=generateKeyPairSync('ed25519'),qualified={...manifest,policy:{...manifest.policy,fallbacks:manifest.policy.fallbacks.map(f=>({...f,rehearsed:false}))},purpose:'qualification',qualification:{instanceId,inputFingerprint},runInputFingerprint:inputFingerprint,evidence};
  const envelope=signQualificationManifest(qualified,keyId,keys.privateKey.export({format:'pem',type:'pkcs8'}));
  const trustRoot={schemaVersion:1,purpose:'qualification',qualificationInstanceId:instanceId,channel:qualified.channel,distributionOrigins:[...new Set(qualified.packages.map(p=>new URL(p.url).origin))],keys:[{id:keyId,publicKey:keys.publicKey.export({format:'pem',type:'spki'})}]};
  await atomicJson(join(output,'qualification-trust-root.json'),trustRoot);await atomicJson(join(output,'qualification-catalog.json'),{schemaVersion:1,channel:qualified.channel,releases:[{releaseId:qualified.releaseId,manifestDigest:envelope.manifestDigest,envelope}]});await atomicJson(join(output,'qualification-release.json'),envelope);
  return {purpose:'qualification',instanceId,inputFingerprint,envelope,trustRoot};
}
export async function runtimeFingerprint(apiRoot,rootCheckout,{platform=process.platform,arch=process.arch,nodeMajor=22,builderVersion='node22-pnpm9',behavior={}}={}) {
  const {prepareApiContext}=await import('../containers/api-context.mjs');const context=await prepareApiContext(apiRoot,rootCheckout);
  try {return digest({schemaVersion:1,platform,arch,nodeMajor,builderVersion,behavior,files:(await Promise.all(context.manifest.files.map(async f=>({path:f.path,mode:(await fs.stat(join(context.context,f.path))).mode&0o777,sha256:f.sha256})))).sort((a,b)=>a.path.localeCompare(b.path)),schemaFingerprint:context.manifest.schemaFingerprint});}finally{await fs.rm(context.context,{recursive:true,force:true});}
}
export async function cli(action,configPath) {
  const c=await readJson(configPath);if(action==='qualify')return buildQualificationDistribution(c);if(action==='bundle')return buildNativeBundle(c);if(action==='sign')return buildSignedDistribution(c);throw Error('Only bundle or sign is available; this tool has no instance deployment authority');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli(process.argv[2],process.argv[3]).then(r=>process.stdout.write(JSON.stringify(r)+'\n'),e=>{process.stderr.write((e.code||'DISTRIBUTION_FAILED')+'\n');process.exitCode=1;});
