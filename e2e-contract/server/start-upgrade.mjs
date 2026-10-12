import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createStableEntry } from '../../deploy/upgrade/stable-entry.mjs';
import { createCandidateSupervisor } from '../../deploy/upgrade/candidate-supervisor.mjs';
import { createCoordinatorClient } from '../../deploy/upgrade/coordinator-client.mjs';
import { atomicJson, secureDirectory, readJson } from '../../deploy/upgrade/io.mjs';
import { invariant } from '../../deploy/upgrade/trust.mjs';
import { createDockerRoleAdapter } from '../../deploy/upgrade/docker-role-adapter.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port; await new Promise(ok => server.close(ok)); return port;
}
export async function waitFor(origin, path, headers = {}, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(origin + path, { headers, signal: AbortSignal.timeout(2000) }); if (r.ok) return r; } catch {}
    await new Promise(ok => setTimeout(ok, 100));
  }
  throw Object.assign(new Error('Acceptance role readiness timed out'), { code: 'ROLE_NOT_READY' });
}
/** Fresh real installation. Every process runs immutable package entrypoints. */
export async function startUpgradeHarness(config) {
  invariant(Number(process.versions.node.split('.')[0]) === 22, 'NODE22_REQUIRED');
  invariant(isAbsolute(config.root) && isAbsolute(config.initialRoot), 'ABSOLUTE_TEST_ROOT_REQUIRED');
  invariant(config.isolated === true && /^upgrade-acceptance-[a-zA-Z0-9._-]+$/.test(config.instanceId), 'ISOLATED_INSTANCE_REQUIRED');
  const root = await secureDirectory(config.root);
  invariant(!(await fs.lstat(join(root, 'harness.json')).catch(() => null)), 'ACCEPTANCE_HOME_ALREADY_USED');
  // Failed startup retains its Owner and SDK home. It must not become an
  // invitation to launch a second Owner against the same installation.
  const startup=await fs.open(join(root,'startup-intent.json'),'wx',0o600).catch(error=>{if(error.code==='EEXIST')throw Object.assign(Error('Acceptance home has already begun startup'),{code:'ACCEPTANCE_HOME_ALREADY_USED'});throw error;});
  await startup.writeFile(JSON.stringify({instanceId:config.instanceId,initialRoot:config.initialRoot,startedAt:new Date().toISOString()})+'\n');await startup.sync();await startup.close();
  const keys = config.keys;
  invariant(keys && ['owner','control','controller','entry','sticky','upgrade','supervisor','upgradeSession'].every(k => typeof keys[k] === 'string' && keys[k].length >= 32), 'SEPARATE_TEST_KEYS_REQUIRED');
  invariant(new Set(Object.values(keys)).size === Object.values(keys).length, 'ROLE_KEYS_MUST_DIFFER');
  const ports = {};
  for (const role of ['owner','coordinator','apiA','webA','apiB','webB','coordinatorB','coordinatorAppB','ownerB','installerB','controllerMetadata','supervisor','entry','entryControl']) ports[role] = config.ports?.[role] ?? await freePort();
  invariant(new Set(Object.values(ports)).size === Object.values(ports).length, 'ROLE_PORTS_MUST_DIFFER');
  const origin = role => `http://127.0.0.1:${ports[role]}`;
  const paths = {};
  for (const [name, folder] of Object.entries({data:'business',owner:'original-owner',futureOwners:'future-owners',installer:'installer',bindings:'bindings',logs:'logs',web:'initial-web-code'})) paths[name] = await secureDirectory(join(root,folder));
  await secureDirectory(join(paths.installer,'artifacts'));
  const bindingPath=join(paths.bindings,'coordinator.json'), ownerBindingPath=join(paths.bindings,'owners.json');
  const release = {...config.initialRelease,productionWebBinding:config.initialRelease.productionWebBinding||origin('entry')};
  invariant(release.components.coordinator && release.components.installer && release.components.web.webRevision,'INITIAL_COMPONENT_IDENTITIES_REQUIRED');
  const startIds=Object.fromEntries(['owner','coordinator','apiA','webA'].map(k=>[k,randomUUID()]));
  await atomicJson(bindingPath,{instanceId:config.instanceId,state:'ready',origin:origin('coordinator'),generation:1,artifactDigest:release.components.coordinator.artifactDigest});
  await atomicJson(ownerBindingPath,{instanceId:config.instanceId,activeOwnerId:'original-owner',owners:[{ownerId:'original-owner',endpoint:origin('owner'),artifactDigest:release.components.owner?.artifactDigest||release.components.api.artifactDigest,inputFingerprint:release.components.owner?.inputFingerprint||release.components.api.inputFingerprint}]});
  const initialReleasePath=join(paths.bindings,'installed-release.json');
  await atomicJson(initialReleasePath,{release,artifactRoot:config.initialRoot});
  const apiRoot=join(config.initialRoot,'api'), roles=join(apiRoot,'apps/api/dist/roles');
  const common={NODE_ENV:'production',PATH:process.env.PATH||'/usr/bin:/bin',PLATFORM_INSTANCE_ID:config.instanceId,HOST:'127.0.0.1',...config.runtimeEnv};
  for(const k of Object.keys(config.runtimeEnv||{}))invariant(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','NODE_USE_ENV_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','LANG','TZ'].includes(k),'FORBIDDEN_COMMON_ROLE_ENV');
  for(const k of ['DATABASE_URL','DATA_ROOT','BOXLITE_HOME','RUNTIME_OWNER_HOME','PLATFORM_COORDINATOR_RPC_KEY','PLATFORM_CONTROL_RPC_KEY','PLATFORM_CONTROLLER_RPC_KEY','UPGRADE_ADMIN_KEY','UPGRADE_SESSION_SECRET']) invariant(!(k in (config.runtimeEnv||{})),'FORBIDDEN_COMMON_ROLE_ENV');
  const network={API_ALLOWED_ORIGINS:origin('entry')};
  const controlEnv={...network,PLATFORM_INSTANCE_ID:config.instanceId,PLATFORM_CONTROL_RPC_KEY:keys.control,COORDINATOR_RPC_URL:origin('coordinator'),PLATFORM_COORDINATOR_BINDING_PATH:bindingPath,...(common.NODE_EXTRA_CA_CERTS?{NODE_EXTRA_CA_CERTS:common.NODE_EXTRA_CA_CERTS}:{})};
  const ownerEnv={PLATFORM_INSTANCE_ID:config.instanceId,PLATFORM_COORDINATOR_RPC_KEY:keys.owner,SANDBOX_DEFAULT_PROVIDER:config.provider||'boxlite',...(common.NODE_EXTRA_CA_CERTS?{NODE_EXTRA_CA_CERTS:common.NODE_EXTRA_CA_CERTS}:{}),...config.ownerEnv};
  const coordinatorEnv={...config.authEnv,...config.coordinatorEnv,...network,PLATFORM_INSTANCE_ID:config.instanceId,PLATFORM_CONTROL_RPC_KEY:keys.control,PLATFORM_CONTROLLER_RPC_KEY:keys.controller,PLATFORM_COORDINATOR_RPC_KEY:keys.owner,PLATFORM_COORDINATOR_BINDING_PATH:bindingPath,PLATFORM_RUNTIME_OWNER_BINDING_PATH:ownerBindingPath,COORDINATOR_RPC_URL:origin('coordinator'),RUNTIME_OWNER_RPC_URL:origin('owner'),DATA_ROOT:paths.data,DATABASE_URL:join(paths.data,'platform.sqlite'),MIGRATIONS_DIR:join(apiRoot,'drizzle'),UPGRADE_ADMIN_KEY:keys.upgrade,UPGRADE_SESSION_SECRET:keys.upgradeSession,UPGRADE_TRUST_ROOT_PATH:config.trustRootPath,UPGRADE_CATALOG_FILE:config.catalogFile,UPGRADE_INITIAL_RELEASE_PATH:initialReleasePath,UPGRADE_INITIAL_ARTIFACT_ROOT:config.initialRoot,UPGRADE_QUALIFICATION_INSTALLATION_PATH:config.qualificationInstallationPath,UPGRADE_INSTALLER_ROOT:paths.installer,PLATFORM_ENTRY_ORIGIN:origin('entry'),PLATFORM_ENTRY_CONTROL_ORIGIN:origin('entryControl'),PLATFORM_ENTRY_CONTROL_KEY:keys.entry,PLATFORM_INSTALLER_SUPERVISOR_ORIGIN:origin('supervisor'),PLATFORM_INSTALLER_SUPERVISOR_KEY:keys.supervisor,SANDBOX_DEFAULT_PROVIDER:config.provider||'boxlite',...(common.NODE_EXTRA_CA_CERTS?{NODE_EXTRA_CA_CERTS:common.NODE_EXTRA_CA_CERTS}:{})};
  for(const k of Object.keys(coordinatorEnv)) if(coordinatorEnv[k]===undefined)delete coordinatorEnv[k];
  const coordinator=createCoordinatorClient({origin:origin('coordinator'),instanceId:config.instanceId,key:keys.controller,bindingPath});
  const controllerConfig={root:paths.installer,instanceId:config.instanceId,controllerId:'acceptance-controller',trustRootPath:config.trustRootPath,coordinatorOrigin:origin('coordinator'),coordinatorBindingPath:bindingPath,controllerKey:keys.controller,entryOrigin:origin('entryControl'),entryKey:keys.entry,supervisorOrigin:origin('supervisor'),supervisorKey:keys.supervisor,controllerMetadataPort:ports.controllerMetadata};
  const adapter=config.docker?await createDockerRoleAdapter({...config.docker,instanceId:config.instanceId,installationRoot:root,installerRoot:paths.installer,businessRoot:paths.data,bindingRoot:paths.bindings,runtimeOwnerRoot:paths.futureOwners,trustRootPath:config.trustRootPath,qualificationRoot:config.qualificationInstallationPath?resolve(config.qualificationInstallationPath,'..'):null}):null;
  const children=new Map(),roleContainers={};
  async function launch(name,entry,env,cwd=apiRoot,kind=name,extra={}){
    invariant((await fs.lstat(entry)).isFile(),'BUILT_ROLE_ENTRY_REQUIRED');
    const args=[entry,...(extra.args||[])],roleEnv={...common,...env};
    if(adapter){const proof=await adapter.launch({kind,args,entry,env:roleEnv,cwd,artifactRoot:config.initialRoot,processRoot:extra.processRoot||config.initialRoot,record:{kind,startIdentity:env.PLATFORM_PROCESS_START_IDENTITY||extra.startIdentity,...extra.record},ownerHome:extra.ownerHome});roleContainers[name]=proof;children.set(name,{container:true,...proof});return proof;}
    const log=await fs.open(join(paths.logs,name+'.log'),'a',0o600),child=spawn(process.execPath,args,{cwd,env:roleEnv,stdio:['ignore',log.fd,log.fd],shell:false});await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});await log.close();children.set(name,child);return child;
  }
  const supervisor=await createCandidateSupervisor({root:paths.installer,instanceId:config.instanceId,key:keys.supervisor,coordinator,controlEnv,coordinatorEnv,ownerEnv,runtimeEnv:config.runtimeEnv||{},runtimeOwnerRoot:paths.futureOwners,publicationRoot:join(root,'supervisor-publication'),apiPort:ports.apiB,webPort:ports.webB,coordinatorPort:ports.coordinatorB,coordinatorAppPort:ports.coordinatorAppB,ownerPort:ports.ownerB,installerPort:ports.installerB,installerConfig:controllerConfig,initialInstallerOrigin:origin('controllerMetadata'),port:ports.supervisor,launchAdapter:adapter});
  const entry=await createStableEntry({root:join(root,'entry'),instanceId:config.instanceId,controlKey:keys.entry,stickyKey:keys.sticky,port:ports.entry,controlPort:ports.entryControl,verifyFence:({attemptId,fence})=>coordinator.assertFence(attemptId,fence),verifyContractFence:({contractAttemptId,fence})=>coordinator.assertContractFence(contractAttemptId,fence),initialBinding:{instanceId:config.instanceId,fence:1,routeGeneration:1,attemptId:'initial',weight:0,oldApi:{origin:origin('apiA'),digest:release.components.api.artifactDigest},candidateApi:null,web:{origin:origin('webA'),root:join(config.initialRoot,'web'),digest:release.components.web.artifactDigest,treeDigest:config.initialTreeDigest},retainedWeb:[]}});
  await launch('owner',join(roles,'runtime-owner-main.js'),{...ownerEnv,PLATFORM_PROCESS_ROLE:'runtime-owner',PLATFORM_ARTIFACT_DIGEST:release.components.owner?.artifactDigest||release.components.api.artifactDigest,PLATFORM_PROCESS_START_IDENTITY:startIds.owner,RUNTIME_OWNER_ID:'original-owner',RUNTIME_OWNER_PORT:String(ports.owner),RUNTIME_OWNER_HOME:paths.owner,BOXLITE_HOME:join(paths.owner,'boxlite'),HOME:paths.owner},apiRoot,'owner',{ownerHome:paths.owner});
  await waitFor(origin('owner'),'/runtime/metadata',{'x-platform-internal-key':keys.owner,'x-platform-instance-id':config.instanceId});
  await supervisor.registerInstalledRole({...roleContainers.owner,pid:children.get('owner').pid,kind:'owner',instanceId:config.instanceId,startIdentity:startIds.owner,origin:origin('owner'),ownerId:'original-owner',ownerHome:paths.owner,artifactRoot:config.initialRoot,...release.components.owner});
  await launch('coordinator',join(roles,'coordinator-main.js'),{...coordinatorEnv,PLATFORM_PROCESS_ROLE:'coordinator',PORT:String(ports.coordinator),PLATFORM_ARTIFACT_DIGEST:release.components.coordinator.artifactDigest,PLATFORM_PROCESS_START_IDENTITY:startIds.coordinator},apiRoot,'coordinator');
  await waitFor(origin('coordinator'),'/api/health');
  await supervisor.registerInstalledRole({...roleContainers.coordinator,pid:children.get('coordinator').pid,kind:'coordinator',instanceId:config.instanceId,startIdentity:startIds.coordinator,origin:origin('coordinator'),metadataPath:'/internal/application/identity',artifactRoot:config.initialRoot,...release.components.coordinator});
  await launch('apiA',join(roles,'control-api-main.js'),{...controlEnv,PLATFORM_PROCESS_ROLE:'control',PORT:String(ports.apiA),PLATFORM_ARTIFACT_DIGEST:release.components.api.artifactDigest,PLATFORM_PROCESS_START_IDENTITY:startIds.apiA},apiRoot,'api');
  await waitFor(origin('apiA'),'/api/health');
  await fs.cp(join(config.initialRoot,'web'),paths.web,{recursive:true,dereference:false,verbatimSymlinks:true});
  await launch('webA',join(paths.web,'server.js'),{PORT:String(ports.webA),HOSTNAME:'127.0.0.1',PLATFORM_ARTIFACT_DIGEST:release.components.web.artifactDigest,PLATFORM_PROCESS_START_IDENTITY:startIds.webA},paths.web,'web',{record:{artifactRoot:config.initialRoot},processRoot:paths.web});
  await waitFor(origin('webA'),'/web-build');
  const controllerConfigPath=join(paths.installer,'controller-config.json');
  async function startController(){const startIdentity=randomUUID();await atomicJson(controllerConfigPath,{...controllerConfig,startIdentity});const child=await launch('controller',join(config.initialRoot,'installer/controller-main.mjs'),{},join(config.initialRoot,'installer'),'installer',{args:[controllerConfigPath],startIdentity});const r=await waitFor(origin('controllerMetadata'),'/metadata',{'x-platform-internal-key':keys.controller});const identity=await r.json();invariant(identity.instanceId===config.instanceId&&identity.artifactDigest===release.components.installer.artifactDigest&&identity.inputFingerprint===release.components.installer.inputFingerprint&&identity.startIdentity===startIdentity,'INITIAL_CONTROLLER_ACTUAL_IDENTITY_MISMATCH');return child;}
  await startController();
  const bootstrap=await fetch(origin('coordinator')+'/internal/upgrades/bootstrap',{method:'POST',headers:{'x-platform-internal-key':keys.controller,'x-platform-instance-id':config.instanceId},signal:AbortSignal.timeout(120000)});invariant(bootstrap.ok,'INITIAL_PHYSICAL_BOOTSTRAP_FAILED');
  const info={instanceId:config.instanceId,root,entryOrigin:entry.origin,coordinatorOrigin:coordinator.origin,initialRoot:config.initialRoot,ports,pids:Object.fromEntries([...children].map(([n,c])=>[n,c.pid])),native:process.platform==='linux'&&process.arch==='arm64',isolation:adapter?'containers':'processes',roleContainers,bindingPath,ownerBindingPath,controllerConfigPath};
  await atomicJson(join(root,'harness.json'),info);
  async function stopOwned(name,signal){const child=children.get(name);invariant(child,'OWNED_ROLE_REQUIRED');if(child.container){await adapter.signal(child.containerId,signal);return;}if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(ok=>{child.once('exit',ok);child.kill(signal);});}
  async function currentController(){const authority=await readJson(join(paths.installer,'controller-authority.json'),null);if(!authority?.attemptId)return {initial:true,record:children.get('controller')};const record=supervisor.ownedProcesses().find(row=>row.kind==='installer'&&row.startIdentity===authority.startIdentity);invariant(record&&record.artifactDigest===authority.artifactDigest,'CURRENT_CONTROLLER_NOT_OWNED');return {initial:false,record};}
  async function stopCurrentController(signal){const current=await currentController();if(current.initial){await stopOwned('controller',signal);return current;}const record=current.record;if(adapter&&record.containerId)await adapter.signal(record.containerId,signal);else{invariant(Number.isSafeInteger(record.pid)&&record.pid>0,'OWNED_CONTROLLER_PID_REQUIRED');try{process.kill(record.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}const deadline=Date.now()+5000;while(Date.now()<deadline){try{process.kill(record.pid,0);}catch(error){if(error.code==='ESRCH')return current;throw error;}await new Promise(ok=>setTimeout(ok,20));}throw Object.assign(Error('Owned Controller did not exit'),{code:'CONTROLLER_EXIT_TIMEOUT'});}return current;}
  return {...info,entry,coordinator,supervisor,
    runController(){return children.get('controller');},
    async killController(){return stopCurrentController('SIGKILL');},
    async restartController(){const current=await currentController();if(!current.initial){const record=await supervisor.restartCurrentInstaller();const r=await waitFor(record.origin,'/metadata',{'x-platform-internal-key':keys.controller});const identity=await r.json();invariant(identity.instanceId===config.instanceId&&identity.startIdentity===record.startIdentity&&identity.artifactDigest===record.artifactDigest,'RESTART_CONTROLLER_IDENTITY_MISMATCH');return record;}const prior=children.get('controller');if(prior.container){const proof=await adapter.inspect(prior.containerId);invariant(proof.running===false,'CONTROLLER_STILL_RUNNING');}else invariant(prior.exitCode!==null||prior.signalCode!==null,'CONTROLLER_STILL_RUNNING');return startController();},
    async stopControl(name){invariant(['apiA','webA'].includes(name),'ONLY_TEST_CONTROL_ROLE_MAY_STOP');await stopOwned(name,'SIGTERM');},
    async close({resourcesCleaned=false}={}){await stopCurrentController('SIGTERM');await supervisor.close();await entry.close();if(!resourcesCleaned)return;for(const name of [...children.keys()].reverse())if(name!=='controller')await stopOwned(name,'SIGTERM');for(const record of supervisor.ownedProcesses()){if(adapter&&record.containerId)await adapter.signal(record.containerId,'SIGTERM');else if(record.pid)try{process.kill(record.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}}
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const harness=await startUpgradeHarness(await readJson(process.argv[2]));process.stdout.write(JSON.stringify({instanceId:harness.instanceId,entryOrigin:harness.entryOrigin,root:harness.root})+'\n');for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void harness.close().then(()=>process.exit(0));});}
