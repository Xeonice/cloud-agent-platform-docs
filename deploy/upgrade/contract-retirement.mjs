import * as fs from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { invariant,digest,canonical,DIGEST } from './trust.mjs';
import { readJson,atomicJson,secureDirectory,treeManifest,inside } from './io.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const loopback=value=>{const u=new URL(value);invariant(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'UNSAFE_REGISTERED_ROLE_ORIGIN');return u.origin;};
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
const exec=promisify(execFile);
async function birth(pid){invariant(Number.isSafeInteger(pid)&&pid>1,'PURE_READER_PID_REQUIRED');if(process.platform!=='linux'){try{const r=await exec('/bin/ps',['-p',String(pid),'-o','lstart=','-o','comm='],{timeout:1000,maxBuffer:4096});return r.stdout.trim()||null;}catch(e){if(e.code===1)return null;throw e;}}try{const text=await fs.readFile('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19];}catch(e){if(e.code==='ENOENT')return null;throw e;}}

/** Installation capability: registrations cannot be written through an HTTP RPC. */
export async function createContractRetirement({directory,instanceId,coordinator,launchAdapter,controlKey,controllerKey,ownerKey,businessRoot}){
  directory=await secureDirectory(directory);const registryPath=join(directory,'installed-roles.json'),operations=await secureDirectory(join(directory,'contract-retirements'));
  let roles=await readJson(registryPath,[]);invariant(Array.isArray(roles)&&roles.every(r=>r.instanceId===instanceId),'INSTALLED_ROLE_REGISTRY_INVALID');
  const locks=new Set(),registrations=new Map();
  async function metadata(r){const owner=r.kind==='owner',management=r.metadataPath==='/internal/coordinator/identity';const path=owner?'/runtime/metadata':r.metadataPath;const response=await fetch(loopback(management?(r.managementOrigin||r.origin):r.origin)+path,{headers:{'x-platform-internal-key':owner?ownerKey:management?controllerKey:controlKey,'x-platform-instance-id':instanceId},signal:AbortSignal.timeout(1500)});invariant(response.ok,'REGISTERED_ROLE_METADATA_UNKNOWN');return response.json();}
  async function physical(r){
    if(r.containerId){invariant(launchAdapter,'REGISTERED_CONTAINER_INSPECTOR_REQUIRED');const p=await launchAdapter.inspect(r.containerId);invariant(p.startIdentity===r.startIdentity&&p.containerId===r.containerId,'REGISTERED_PROCESS_CHANGED');return {...p,definitelyAbsent:p.running===false};}
    invariant(Number.isSafeInteger(r.pid)&&r.pid>1&&r.processBirth,'REGISTERED_PROCESS_BIRTH_REQUIRED');const current=await birth(r.pid);if(current===null){try{process.kill(r.pid,0);}catch(e){if(e.code==='ESRCH')return {pid:r.pid,processBirth:r.processBirth,running:false,definitelyAbsent:true};throw e;}return {pid:r.pid,running:true,definitelyAbsent:false,qualified:false};}
    if(current!==r.processBirth)return {pid:r.pid,originalProcessBirth:r.processBirth,replacementProcessBirth:current,running:false,definitelyAbsent:true,replacementProcessPreserved:true};return {pid:r.pid,processBirth:current,running:true,definitelyAbsent:false};
  }
  async function registerOnce(record){
    invariant(['owner','coordinator'].includes(record.kind)&&record.instanceId===instanceId&&typeof record.startIdentity==='string'&&DIGEST.test(record.artifactDigest)&&DIGEST.test(record.inputFingerprint),'INSTALLED_ROLE_IDENTITY_REQUIRED');
    loopback(record.origin);if(record.managementOrigin)loopback(record.managementOrigin);
    const r={...record,registeredAt:new Date().toISOString(),...(record.kind==='coordinator'?{readerId:'reader-'+digest({instanceId,startIdentity:record.startIdentity}).slice(7,39),metadataPath:record.metadataPath||'/internal/coordinator/identity'}:{})};
    if(!r.containerId)r.processBirth=await birth(r.pid);
    const actual=await metadata(r);invariant(actual.instanceId===instanceId&&actual.startIdentity===r.startIdentity&&actual.artifactDigest===r.artifactDigest&&actual.pid===r.pid&&(record.kind==='owner'?actual.role==='runtime-owner'&&actual.ownerId===r.ownerId:['coordinator','coordinator-prepared'].includes(actual.role)),'INSTALLED_ROLE_METADATA_MISMATCH');
    const installed=await readJson(join(r.artifactRoot,'installed.json')),bundle=await readJson(join(r.artifactRoot,'upgrade-artifact.json')),files=(await treeManifest(r.artifactRoot)).filter(f=>!['installed.json','upgrade-artifact.json'].includes(f.path));invariant(canonical(files)===canonical(bundle.files)&&digest(files)===bundle.treeDigest&&installed.components[record.kind].artifactDigest===r.artifactDigest,'INSTALLED_ROLE_PHYSICAL_TREE_MISMATCH');
    await physical(r);const prior=roles.find(p=>p.startIdentity===r.startIdentity);if(prior){invariant(prior.kind===r.kind&&prior.artifactDigest===r.artifactDigest&&prior.containerId===r.containerId&&prior.pid===r.pid,'REGISTERED_ROLE_CONFLICT');return prior;}
    roles=[...roles,r];await atomicJson(registryPath,roles);return r;
  }
  async function register(record){const pending=registrations.get(record.startIdentity);if(pending)return pending;const promise=registerOnce(record);registrations.set(record.startIdentity,promise);try{return await promise;}finally{registrations.delete(record.startIdentity);}}
  async function readers(){const result=[];for(const r of roles.filter(r=>r.kind==='coordinator')){const receipt=await readJson(join(operations,r.readerId+'.retired.json'),null);if(!receipt){result.push(r);continue;}const current=await physical(r);result.push({...r,retired:current.definitelyAbsent===true,retirementEvidence:{...receipt,qualified:current.definitelyAbsent===true,definitelyAbsent:current.definitelyAbsent===true,observedAt:new Date().toISOString(),after:current}});}return {instanceId,readers:result};}
  async function ownerIsolation(){
    const owners=[];let qualified=Boolean(launchAdapter)&&roles.some(r=>r.kind==='owner');
    for(const r of roles.filter(r=>r.kind==='owner')){let proof;try{const p=await physical(r);const allowed=[resolve(r.artifactRoot),resolve(r.ownerHome),resolve(join(businessRoot,'workspaces'))];const mountsSafe=p.mounts?.every(m=>allowed.includes(resolve(m.source))||(m.rw===false&&!inside(m.source,businessRoot)&&!inside(businessRoot,m.source)&&!inside(m.source,r.ownerHome)&&!inside(r.ownerHome,m.source)));
      const noParentMount=p.mounts?.every(m=>!inside(m.source,businessRoot)&&resolve(m.source)!==resolve(businessRoot));const code=join(r.artifactRoot,'api/apps/api/dist/roles/runtime-owner-main.js');const processSafe=p.entrypoint?.length===1&&['/usr/local/bin/node','/usr/bin/node'].includes(p.entrypoint[0])&&p.command?.length===1&&p.command[0]===code&&p.role==='owner'&&Array.isArray(p.environmentNames)&&!p.environmentNames.some(n=>/^(?:DATABASE_URL|DATA_ROOT|PLATFORM_CONTROLLER_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_LEGACY_AUTH_CONTINUITY_KEY|UPGRADE_SESSION_SECRET)$/.test(n));
      proof={ownerId:r.ownerId,startIdentity:r.startIdentity,artifactDigest:r.artifactDigest,artifactRoot:r.artifactRoot,ownerHome:r.ownerHome,qualified:p.running===true&&p.pidNamespace==='private'&&mountsSafe===true&&noParentMount===true&&processSafe===true,noBusinessDatabaseAccess:mountsSafe===true&&noParentMount===true,...p};}catch(e){proof={ownerId:r.ownerId,startIdentity:r.startIdentity,qualified:false,reason:e.code||'OWNER_PHYSICAL_PROOF_UNKNOWN'};}qualified=qualified&&proof.qualified;owners.push(proof);}
    const facts={instanceId,qualified,ownerIds:owners.map(o=>o.ownerId),owners,observedAt:new Date().toISOString()};return {...facts,evidenceDigest:digest(facts)};
  }
  async function retire(input){
    invariant(input&&Object.keys(input).length===4&&Object.keys(input).every(k=>['contractAttemptId','fence','operationId','readerId'].includes(k))&&UUID.test(input.contractAttemptId)&&Number.isSafeInteger(input.fence)&&input.fence>0&&typeof input.readerId==='string'&&/^reader-[a-f0-9]{32}$/.test(input.readerId)&&input.operationId===input.contractAttemptId+':retire:'+input.readerId,'FIXED_CONTRACT_RETIREMENT_REQUIRED');
    const r=roles.find(r=>r.kind==='coordinator'&&r.readerId===input.readerId);invariant(r,'REGISTERED_PURE_READER_REQUIRED');const path=join(operations,input.readerId+'.retired.json'),intentPath=join(operations,input.readerId+'.intent.json');invariant(!locks.has(input.readerId),'READER_RETIREMENT_BUSY');locks.add(input.readerId);
    try{
      await coordinator.assertContractFence(input.contractAttemptId,input.fence);const snapshot=await coordinator.contractSnapshot(input.contractAttemptId);invariant(snapshot.attempt?.contractAttemptId===input.contractAttemptId&&snapshot.attempt.instanceId===instanceId&&snapshot.fence===input.fence&&snapshot.readers?.some(x=>x.readerId===r.readerId&&x.startIdentity===r.startIdentity&&x.artifactDigest===r.artifactDigest&&x.pid===r.pid),'CONTRACT_READER_NOT_AUTHORIZED');
      const prior=await readJson(path,null);if(prior){const after=await physical(r);invariant(after.definitelyAbsent===true,'RETIRED_READER_PHYSICAL_STATE_UNKNOWN');return {...prior,after,observedAt:new Date().toISOString()};}
      const e=snapshot.eligibility;invariant(e?.allowedRole==='coordinator'&&['windowClosed','newRepresentationComplete','newReadsConfirmed','ownersNoBusinessDB','currentWriterConfirmed'].every(k=>e[k]===true),'CONTRACT_RETIREMENT_INELIGIBLE');
      const isolation=await ownerIsolation();invariant(isolation.qualified===true,'CONTRACT_OWNER_ISOLATION_UNKNOWN');
      const before=await physical(r),intent=await readJson(intentPath,null);
      if(before.definitelyAbsent){invariant(intent?.startIdentity===r.startIdentity&&intent.contractAttemptId===input.contractAttemptId&&intent.operationId===input.operationId,'READER_DISAPPEARED_BEFORE_FIXED_INTENT');}
      else{const actual=await metadata(r);invariant(actual.instanceId===instanceId&&actual.role==='coordinator'&&actual.pid===r.pid&&actual.startIdentity===r.startIdentity&&actual.artifactDigest===r.artifactDigest&&actual.writerFenceValid===false&&['activeTransportConnections','activeRequests','activeStreams','activeMutations'].every(k=>actual[k]===0),'READER_STILL_DEPENDENT');
        await coordinator.assertContractFence(input.contractAttemptId,input.fence);await atomicJson(intentPath,{...input,instanceId,startIdentity:r.startIdentity,before,recordedAt:new Date().toISOString()});await physical(r);
        if(r.containerId)await launchAdapter.signal(r.containerId,'SIGTERM');else process.kill(r.pid,'SIGTERM');
      }
      const deadline=Date.now()+2000;let after;do{after=await physical(r);if(after.definitelyAbsent)break;await sleep(20);}while(Date.now()<deadline);invariant(after.definitelyAbsent===true,'READER_RETIREMENT_RESULT_UNKNOWN');
      const ownerAfter=await ownerIsolation();invariant(ownerAfter.qualified&&canonical(ownerAfter.owners.map(o=>({ownerId:o.ownerId,containerId:o.containerId,startIdentity:o.startIdentity,hostPid:o.hostPid})))===canonical(isolation.owners.map(o=>({ownerId:o.ownerId,containerId:o.containerId,startIdentity:o.startIdentity,hostPid:o.hostPid}))),'CONTRACT_OWNER_CONTINUITY_UNKNOWN');
      const receipt={...input,instanceId,startIdentity:r.startIdentity,artifactDigest:r.artifactDigest,retired:true,qualified:true,definitelyAbsent:true,originalResourcesPreserved:true,lifecycleActions:[],processActions:[{role:'coordinator',signal:'SIGTERM',...(r.containerId?{containerId:r.containerId}:{pid:r.pid,processBirth:r.processBirth})}],retiredRole:'coordinator',before:intent?.before||before,after,ownerBefore:isolation,ownerAfter,ownerIsolationDigest:ownerAfter.evidenceDigest,recordedAt:new Date().toISOString()};await atomicJson(path,receipt);return receipt;
    }finally{locks.delete(input.readerId);}
  }
  return {register,readers,ownerIsolation,retire};
}
