import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { digest, canonical, signManifest, signQualificationManifest, runInputFingerprint, validateManifest, invariant } from './trust.mjs';
import { treeManifest, fileDigest, atomicJson, secureDirectory, readJson } from './io.mjs';
import { command } from './artifacts.mjs';
const ENTRY_FILES=['apps/api/dist/roles/coordinator-main.js','apps/api/dist/roles/coordinator-prepared-main.js','apps/api/dist/roles/control-api-main.js','apps/api/dist/roles/runtime-owner-main.js'];
export async function buildNativeBundle({builtRoot,outputRoot,platform,arch,components,releaseId,distributionOrigin,run=command}) {
  invariant(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(releaseId),'INVALID_PACKAGE_RELEASE');
  invariant(platform===process.platform&&arch===process.arch&&Number(process.versions.node.split('.')[0])===22,'NATIVE_BUILD_ARCHITECTURE_MISMATCH');
  builtRoot=resolve(builtRoot);outputRoot=await secureDirectory(outputRoot);await treeManifest(builtRoot);
  for(const entry of ENTRY_FILES)invariant((await fs.lstat(join(builtRoot,'api',entry))).isFile(),'THREE_ROLE_BUILD_REQUIRED');
  invariant((await fs.lstat(join(builtRoot,'web/server.js'))).isFile(),'SELF_HOSTED_WEB_REQUIRED');
  const u=new URL(distributionOrigin);invariant(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash,'INVALID_DISTRIBUTION_ORIGIN');
  const stage=await fs.mkdtemp(join(outputRoot,'.bundle-'));
  try {
    // Materialize contained pnpm links into plain files. Extraction never accepts links or devices.
    await fs.cp(builtRoot,stage,{recursive:true,dereference:true});
    const files=await treeManifest(stage);invariant(files.every(f=>!f.link),'UNMATERIALIZED_PACKAGE_LINK');
    const api=files.filter(f=>f.path.startsWith('api/')),web=files.filter(f=>f.path.startsWith('web/'));
    invariant(digest(api)===components.api.artifactDigest&&digest(web)===components.web.artifactDigest&&digest(api)===components.coordinator.artifactDigest&&(!components.owner||digest(api)===components.owner.artifactDigest)&&digest(files.filter(f=>f.path.startsWith('installer/')))===components.installer.artifactDigest,'COMPONENT_TREE_IDENTITY_MISMATCH');
    const apiRoot=join(stage,'api');
    const probe="const{createRequire}=require('node:module');const r=createRequire(process.cwd()+'/package.json');const D=r('better-sqlite3');const db=new D(':memory:');if(db.prepare('select 1 as ok').get().ok!==1)throw Error('SQLite');db.close();if(process.platform!==process.env.EXPECT_PLATFORM||process.arch!==process.env.EXPECT_ARCH)throw Error('Native ABI');process.stdout.write('native-abi-passed')";
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
