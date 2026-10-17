import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { join,isAbsolute } from 'node:path';
import { command } from '../../deploy/upgrade/artifacts.mjs';
import { buildQualificationDistribution } from '../../deploy/upgrade/build-distribution.mjs';
import { secureDirectory,readJson,atomicJson,fileDigest,treeManifest } from '../../deploy/upgrade/io.mjs';
import { invariant,digest,canonical,runInputFingerprint } from '../../deploy/upgrade/trust.mjs';
import { createInstallerFilesystem, createBusinessDatabaseFilesystem } from './installer-filesystem.mjs';
import { cleanupQualificationSdkImages } from './qualification-sdk-cache.mjs';

/** Dedicated test trust domain, actual TLS transport and immutable signed bytes. */
export async function createUpgradeFixture(input) {
  invariant(input.isolated!==false&&/^upgrade-acceptance-[a-zA-Z0-9._-]+$/.test(input.instanceId)&&['root','initialRoot','archiveRoot'].every(k=>isAbsolute(input[k]||'')),'ISOLATED_FIXTURE_INPUT_REQUIRED');
  invariant(input.cleanupSdkImagesOnSuccess===undefined||typeof input.cleanupSdkImagesOnSuccess==='boolean','EXPLICIT_SDK_CACHE_CLEANUP_OPTION_REQUIRED');
  const root=await secureDirectory(input.root),fixtureRoot=await secureDirectory(join(root,'qualification-distribution'));
  invariant(!(await fs.lstat(join(fixtureRoot,'fixture.json')).catch(()=>null)),'FIXTURE_ALREADY_CREATED');
  const installerFilesystem=input.installerFilesystem?await createInstallerFilesystem({...input,root}):null;
  invariant(!input.businessDatabaseFilesystem||input.cleanupSdkImagesOnSuccess===true,'DATABASE_FILESYSTEM_CLEANUP_PROOF_OPTION_REQUIRED');
  const businessDatabaseFilesystem=input.businessDatabaseFilesystem?await createBusinessDatabaseFilesystem({...input,root}):null;
  const target=structuredClone(input.targetManifest?.manifest||input.targetManifest||await readJson(input.targetManifestPath));
  const originalFingerprint=runInputFingerprint(target);const files=new Map();
  for(const pkg of target.packages){invariant(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(pkg.name),'FIXTURE_PACKAGE_NAME_INVALID');const path=join(input.archiveRoot,pkg.name),hash=await fileDigest(path);invariant(hash.digest===pkg.digest&&hash.bytes===pkg.bytes,'FIXTURE_PACKAGE_CHANGED');const copy=join(fixtureRoot,pkg.name);await fs.copyFile(path,copy,fs.constants.COPYFILE_EXCL);await fs.chmod(copy,0o400);files.set('/packages/'+pkg.name,{path:copy,...hash});}
  const caRoot=await secureDirectory(join(fixtureRoot,'tls'));
  await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-keyout',join(caRoot,'ca.key'),'-out',join(caRoot,'ca.crt'),'-subj','/CN='+input.instanceId+' qualification CA']);
  await command('openssl',['req','-newkey','rsa:2048','-nodes','-sha256','-keyout',join(caRoot,'server.key'),'-out',join(caRoot,'server.csr'),'-subj','/CN=localhost']);
  await fs.writeFile(join(caRoot,'san.cnf'),'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n',{mode:0o600});
  await command('openssl',['x509','-req','-sha256','-days','2','-in',join(caRoot,'server.csr'),'-CA',join(caRoot,'ca.crt'),'-CAkey',join(caRoot,'ca.key'),'-CAcreateserial','-out',join(caRoot,'server.crt'),'-extfile',join(caRoot,'san.cnf')]);
  await fs.chmod(join(caRoot,'ca.key'),0o600);await fs.chmod(join(caRoot,'server.key'),0o600);
  const requests=[];
  let packageDownloadFault=null;
  const server=https.createServer({key:await fs.readFile(join(caRoot,'server.key')),cert:await fs.readFile(join(caRoot,'server.crt'))},(req,res)=>{
    const url=new URL(req.url,'https://localhost'),file=files.get(url.pathname);if(req.method!=='GET'||!file||url.search){res.writeHead(404);res.end();return;}
    let offset=0;if(req.headers.range){const match=/^bytes=(\d+)-$/.exec(req.headers.range);if(!match||Number(match[1])>=file.bytes){res.writeHead(416,{'content-range':'bytes */'+file.bytes});res.end();return;}offset=Number(match[1]);}
    const record={path:url.pathname,range:req.headers.range||null,status:packageDownloadFault?503:offset?206:200,bytesSent:0,startedAt:new Date().toISOString(),completed:false,...(packageDownloadFault?{fault:packageDownloadFault.kind}: {})};requests.push(record);
    if(packageDownloadFault){res.on('finish',()=>{record.completed=true;record.completedAt=new Date().toISOString();});res.writeHead(503,{'content-length':'0','cache-control':'no-store'});res.end();return;}
    res.writeHead(record.status,{'content-type':'application/octet-stream','content-length':file.bytes-offset,'accept-ranges':'bytes','cache-control':'no-store',...(offset?{'content-range':`bytes ${offset}-${file.bytes-1}/${file.bytes}`}:{})});
    const stream=createReadStream(file.path,{start:offset});stream.on('data',chunk=>{record.bytesSent+=chunk.length;});stream.on('error',()=>res.destroy());res.on('finish',()=>{record.completed=true;record.completedAt=new Date().toISOString();});res.on('close',()=>stream.destroy());stream.pipe(res);
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(input.distributionPort||0,'127.0.0.1',ok);});
  const origin='https://127.0.0.1:'+server.address().port;
  for(const pkg of target.packages)pkg.url=origin+'/packages/'+pkg.name;
  invariant(runInputFingerprint(target)===originalFingerprint,'QUALIFICATION_RUNTIME_INPUTS_CHANGED');
  let qualified;
  try{qualified=await buildQualificationDistribution({manifest:target,outputRoot:fixtureRoot,instanceId:input.instanceId,runId:input.runId||('native-'+randomBytes(8).toString('hex'))});}catch(error){server.close();throw error;}
  const rootsPath=join(fixtureRoot,'qualification-trust-root.json'),catalogPath=join(fixtureRoot,'qualification-catalog.json'),manifestPath=join(fixtureRoot,'qualification-release.json');
  const proofPath=join(fixtureRoot,'installation-proof.json');await atomicJson(proofPath,{purpose:'qualification',instanceId:input.instanceId,trustRootDigest:digest(qualified.trustRoot),isolatedRoot:root,caDigest:(await fileDigest(join(caRoot,'ca.crt'))).digest});
  const keys={...input.keys};for(const name of ['owner','control','controller','entry','sticky','supervisor','cookie','upgradeSession'])keys[name]||=randomBytes(32).toString('hex');invariant(new Set(Object.values(keys)).size===Object.values(keys).length,'FIXTURE_KEYS_MUST_DIFFER');
  const initialBundle=await readJson(join(input.initialRoot,'upgrade-artifact.json')),payload=(await treeManifest(input.initialRoot)).filter(f=>!['installed.json','upgrade-artifact.json'].includes(f.path));invariant(canonical(payload)===canonical(initialBundle.files)&&digest(payload)===initialBundle.treeDigest,'INITIAL_FIXTURE_ARTIFACT_CHANGED');
  let schema=input.initialRelease?.schema;if(schema===undefined){const journal=await readJson(join(input.initialRoot,'api/drizzle/meta/_journal.json'));schema=journal.entries.length;}
  const initialRelease={...input.initialRelease,schema,channel:target.channel,components:initialBundle.components,commits:input.initialRelease?.commits||target.commits,activationGeneration:input.initialRelease?.activationGeneration||1,activatedAt:input.initialRelease?.activatedAt||new Date().toISOString(),releaseId:input.initialRelease?.releaseId||initialBundle.releaseId};
  const config={...input,isolated:true,root,keys,initialRelease,initialTreeDigest:initialBundle.treeDigest,...(installerFilesystem?{installerFilesystemEvidence:installerFilesystem.evidence}:{}),...(businessDatabaseFilesystem?{businessDatabaseFilesystemEvidence:businessDatabaseFilesystem.evidence,businessDatabasePath:join(root,'business/db/platform.sqlite')}:{}),trustRootPath:rootsPath,catalogFile:catalogPath,targetManifestPath:manifestPath,qualificationInstallationPath:proofPath,runtimeEnv:{...input.runtimeEnv,NODE_EXTRA_CA_CERTS:join(caRoot,'ca.crt')},authEnv:{ACCESS_PASSCODE:input.authEnv?.ACCESS_PASSCODE||randomBytes(16).toString('hex'),PASSCODE_COOKIE_SECRET:keys.cookie,PASSCODE_COOKIE_SECURE:'false',ACCESS_PASSCODE_AUTO_GENERATE:'false',ACCESS_PASSCODE_ALLOW_LOOPBACK:'false',...input.authEnv},qualification:{purpose:'qualification',inputFingerprint:originalFingerprint,distributionOrigin:origin,runtimeCredentialConfigured:Boolean(input.runtimeCredential)}};
  const configPath=join(fixtureRoot,'acceptance-config.json');await atomicJson(configPath,config);await atomicJson(join(fixtureRoot,'fixture.json'),{purpose:'qualification',instanceId:input.instanceId,inputFingerprint:originalFingerprint,manifestDigest:qualified.envelope.manifestDigest,configPath,distributionOrigin:origin,createdAt:new Date().toISOString()});
  invariant(typeof tls.setDefaultCACertificates==='function'&&typeof tls.getCACertificates==='function','NODE22_PRIVATE_CA_API_REQUIRED');tls.setDefaultCACertificates([...tls.getCACertificates('default'),await fs.readFile(join(caRoot,'ca.crt'),'utf8')]);
  const helpers={setPackageDownloadFault(kind){
    invariant(input.isolated===true&&qualified.envelope.manifest.purpose==='qualification'&&qualified.envelope.manifest.qualification.instanceId===input.instanceId&&kind==='http-503','EXPLICIT_QUALIFICATION_PACKAGE_DOWNLOAD_FAULT_REQUIRED');
    invariant(requests.length===0&&packageDownloadFault===null,'PACKAGE_DOWNLOAD_FAULT_MUST_PRECEDE_DOWNLOADS');
    packageDownloadFault={kind,instanceId:input.instanceId,distributionOrigin:origin,armedAt:new Date().toISOString()};
    return structuredClone(packageDownloadFault);
  },requestLog:()=>structuredClone(requests),installerFilesystemEvidence:installerFilesystem?.evidence||null,businessDatabaseFilesystemEvidence:businessDatabaseFilesystem?.evidence||null,async close({resourcesCleaned=false}={}){await atomicJson(join(fixtureRoot,'download-requests.json'),requests);server.closeAllConnections();await new Promise(ok=>server.close(ok));const sdkCacheCleanup=await cleanupQualificationSdkImages(config,{resourcesCleaned});const businessDatabaseFilesystemCleanup=businessDatabaseFilesystem?await businessDatabaseFilesystem.close({resourcesCleaned,businessCleanupReceipt:sdkCacheCleanup}):null;const installerFilesystemCleanup=installerFilesystem?await installerFilesystem.close({resourcesCleaned}):null;return {sdkCacheCleanup,businessDatabaseFilesystemCleanup,installerFilesystemCleanup};}};
  return {config,configPath,envelope:qualified.envelope,manifestPath,trustRootPath:rootsPath,installationProofPath:proofPath,helpers,requestLog:helpers.requestLog,close:helpers.close};
}
