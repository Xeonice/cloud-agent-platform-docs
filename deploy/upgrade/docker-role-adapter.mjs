import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join,resolve,isAbsolute } from 'node:path';
import { invariant,digest } from './trust.mjs';
import { secureDirectory,atomicJson,readJson,inside } from './io.mjs';
import { captureProcessIdentity } from './supervisor-sampler.mjs';
import { createProtectedRoleLifecycle,fixedRoleName } from './protected-role-lifecycle.mjs';
import { roleMounts } from './production-role-adapter.mjs';
import { roleResourceFlags } from './role-resource-limits.mjs';

async function exec(program,args){return new Promise((ok,fail)=>{const child=spawn(program,args,{shell:false,stdio:['ignore','pipe','pipe']});let output='',bytes=0,settled=false;const reject=()=>{if(!settled){settled=true;fail(Object.assign(Error('Dedicated container operation failed'),{code:'DEDICATED_CONTAINER_OPERATION_FAILED'}));}};const timer=setTimeout(()=>{reject();try{child.kill('SIGKILL');}catch{}},5000);child.stdout.on('data',c=>{bytes+=c.length;if(bytes>4*1024*1024){reject();try{child.kill('SIGKILL');}catch{}}else output+=c;});child.stderr.resume();child.once('error',()=>{clearTimeout(timer);reject();});child.once('close',status=>{clearTimeout(timer);if(!settled){settled=true;status===0?ok(output):fail(Object.assign(Error('Dedicated container operation failed'),{code:'DEDICATED_CONTAINER_OPERATION_FAILED'}));}});});}
/** Installation-owned supervisor capability. Never exported to a Controller RPC. */
export async function createDockerRoleAdapter(c){
  invariant(process.platform==='linux'&&process.arch==='arm64','CONTAINER_ADAPTER_LINUX_ARM64_REQUIRED');
  invariant(c.instanceId&&isAbsolute(c.installationRoot)&&isAbsolute(c.installerRoot)&&isAbsolute(c.businessRoot)&&isAbsolute(c.bindingRoot),'CONTAINER_INSTALLATION_PATHS_REQUIRED');
  invariant(typeof c.image==='string'&&c.image.length>0&&c.dedicated===true&&Array.isArray(c.args)&&c.args.every(v=>typeof v==='string'),'DEDICATED_CONTAINER_DAEMON_REQUIRED');
  invariant(c.node===undefined||c.node==='/usr/local/bin/node'||c.node==='/usr/bin/node','FIXED_CONTAINER_NODE_REQUIRED');
  for(const arg of c.args)invariant(!/\n|\r/.test(arg),'INVALID_DOCKER_OPTION');
  const installationRoot=await secureDirectory(c.installationRoot),registryRoot=await secureDirectory(join(installationRoot,'supervisor-container-records'));
  const cli=c.cli||'docker',docker=args=>exec(cli,[...c.args,...args]);
  const image=JSON.parse(await docker(['image','inspect',c.image]))[0];
  invariant(/^sha256:[a-f0-9]{64}$/.test(image.Id)&&image.Os==='linux'&&image.Architecture==='arm64','FIXED_RUNTIME_IMAGE_REQUIRED');
  for(const value of image.Config.Env||[]){const name=value.split('=',1)[0];invariant(!/KEY|SECRET|TOKEN|PASSWORD|PASSCODE|DATABASE|DATA_ROOT|RUNTIME_OWNER_HOME|PLATFORM_/.test(name),'RUNTIME_IMAGE_CONTAINS_ROLE_AUTHORITY');}
  const imageId=image.Id,owned=new Set();
  async function inspect(containerId){
    invariant(/^[a-f0-9]{64}$/.test(containerId),'INVALID_OWNED_CONTAINER');
    const row=JSON.parse(await docker(['inspect',containerId]))[0];
    invariant(row.Config.Labels['agent-platform.instance']===c.instanceId&&row.Config.Labels['agent-platform.installation']===digest(installationRoot)&&row.Image===imageId,'CONTAINER_IDENTITY_SCOPE_MISMATCH');
    const cgroup=null;
    let birth={};if(row.State.Running)try{birth=await captureProcessIdentity({hostPid:row.State.Pid,containerId:row.Id,procRoot:c.procRoot||'/proc'});}catch{}
    return {...birth,artifactDigest:row.Config.Labels['agent-platform.artifact']||null,attemptId:row.Config.Labels['agent-platform.attempt']||null,operationId:row.Config.Labels['agent-platform.operation']||null,commandId:row.Config.Labels['agent-platform.command']||null,paused:row.State.Paused??null,restartPolicy:row.HostConfig.RestartPolicy?.Name||'no',restartCount:row.RestartCount??null,oomKilled:row.State.OOMKilled??null,exitCode:row.State.ExitCode??null,containerId:row.Id,imageDigest:row.Image,pid:1,hostPid:row.State.Pid,startIdentity:row.Config.Labels['agent-platform.start'],role:row.Config.Labels['agent-platform.role'],entrypoint:row.Config.Entrypoint,command:row.Config.Cmd,environmentNames:(row.Config.Env||[]).map(e=>e.split('=',1)[0]),workingDirectory:row.Config.WorkingDir,startedAt:row.State.StartedAt,running:row.State.Running,pidNamespace:row.HostConfig.PidMode||'private',network:row.HostConfig.NetworkMode,privileged:row.HostConfig.Privileged,cgroup,mounts:row.Mounts.map(m=>({type:m.Type,source:m.Source,destination:m.Destination,rw:m.RW})),capabilities:row.HostConfig.CapAdd||[]};
  }
  async function launch({kind,args,entry,env,cwd,artifactRoot,processRoot,ownerHome,record,assertBeforeDispatch,stableBootstrap,resources}){
    invariant(['api','web','coordinator','owner','installer','control-agent','control-entry','control-supervisor'].includes(kind),'FIXED_CONTAINER_ROLE_REQUIRED');
    invariant(isAbsolute(entry)&&isAbsolute(cwd)&&Array.isArray(args)&&args[0]===entry&&args.length===(['installer','control-agent','control-entry','control-supervisor'].includes(kind)?2:1),'FIXED_CONTAINER_ENTRY_REQUIRED');
    invariant(inside(artifactRoot,entry)||(kind==='web'&&inside(installationRoot,entry)),'CONTAINER_ENTRY_OUTSIDE_ARTIFACT');
    invariant(record.startIdentity,'CONTAINER_START_IDENTITY_REQUIRED');
    if(['control-entry','control-supervisor'].includes(kind)){const mode=kind==='control-entry'?'entry':'supervisor',expected=c.controlFoundationEntries?.[mode];invariant(expected&&stableBootstrap===true&&record.commandId&&record.startIdentity===expected.startIdentity&&artifactRoot===c.controlArtifactRoot&&entry===join(artifactRoot,'installer/control-foundation.mjs')&&args[1]===expected.configPath&&env.PLATFORM_PROCESS_ROLE==='control-foundation','CONTROL_FOUNDATION_BOOTSTRAP_IDENTITY_REQUIRED');}
    else if(kind==='control-agent')invariant(record.startIdentity===c.controlAgentStartIdentity&&artifactRoot===c.controlAgentArtifactRoot&&stableBootstrap===true,'CONTROL_AGENT_BOOTSTRAP_IDENTITY_REQUIRED');
    else if(c.stableControl)invariant(kind!=='installer'&&record.commandId&&typeof assertBeforeDispatch==='function','STABLE_ROLE_FIXED_COMMAND_REQUIRED');
    const mounts=new Map();const mount=(path,rw=false)=>{if(!path)return;invariant(isAbsolute(path)&&!path.includes(','),'FIXED_CONTAINER_MOUNT_REQUIRED');mounts.set(resolve(path),Boolean(rw));};
    let foundationMounts=[];
    if(['control-entry','control-supervisor'].includes(kind))foundationMounts=roleMounts({...c,root:installationRoot,businessHostPath:c.businessRoot},{kind,artifactRoot,cwd,env});
    else if(kind==='control-agent'){invariant(c.controlAgentArtifactRoot===artifactRoot&&c.controlPrivateRoot&&c.controlLedgerRoot&&c.controlPrivateRoot&&!inside(c.controlPrivateRoot,c.controlLedgerRoot)&&!inside(c.controlLedgerRoot,c.controlPrivateRoot)&&!inside(c.controlPrivateRoot,c.businessRoot)&&!inside(c.businessRoot,c.controlPrivateRoot)&&!inside(c.installerRoot,artifactRoot),'CONTROL_AGENT_MOUNT_SCOPE_REQUIRED');invariant(Array.isArray(c.runtimeRoots)&&c.runtimeRoots.length>0&&c.runtimeRoots.length<=128&&c.runtimeRoots.every(isAbsolute),'CONTROL_AGENT_RUNTIME_ROOTS_REQUIRED');const controlPaths=[artifactRoot,c.controlPrivateRoot,c.controlLedgerRoot,c.controlDownloadRoot],protectedPaths=[c.businessRoot,...c.runtimeRoots,'/var/run/docker.sock'];invariant(controlPaths.every(path=>isAbsolute(path)&&protectedPaths.every(protectedPath=>!inside(path,protectedPath)&&!inside(protectedPath,path)))&&controlPaths.every((path,i)=>controlPaths.every((other,j)=>i===j||!inside(path,other)))&&[artifactRoot,c.controlPrivateRoot,c.controlLedgerRoot].every(path=>!inside(path,c.installerRoot)&&!inside(c.installerRoot,path)),'CONTROL_AGENT_EXCESS_MOUNT');invariant(c.controlDownloadRoot===join(c.installerRoot,'downloads')&&[artifactRoot,c.controlPrivateRoot,c.controlLedgerRoot].every(path=>!inside(path,c.controlDownloadRoot)&&!inside(c.controlDownloadRoot,path)),'CONTROL_DOWNLOAD_MOUNT_SCOPE_REQUIRED');invariant(isAbsolute(c.capacityStateRoot)&&[...controlPaths,...protectedPaths].every(path=>!inside(path,c.capacityStateRoot)&&!inside(c.capacityStateRoot,path)),'CONTROL_CAPACITY_STATE_MOUNT_SCOPE_REQUIRED');mount(c.capacityStateRoot);mount(c.controlDownloadRoot,true);mount(artifactRoot);mount(c.controlPrivateRoot,true);mount(c.controlLedgerRoot,true);mount(c.bindingRoot);mount(c.trustRootPath);for(const key of Object.keys(env))invariant(!/^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|BOXLITE_RUNTIME_DIR|RUNTIME_OWNER_HOME)$/.test(key),'CONTROL_AGENT_EXCESS_AUTHORITY');}
    else if(kind==='installer'){
      mount(join(artifactRoot,'installer'));mount(c.installerRoot);mount(await secureDirectory(join(c.installerRoot,'journals')),true);mount(await secureDirectory(join(c.installerRoot,'downloads')),true);mount(c.bindingRoot);mount(c.trustRootPath);
      for(const key of Object.keys(env))invariant(!/^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_LEGACY_AUTH_CONTINUITY_KEY|UPGRADE_SESSION_SECRET)$/.test(key),'CONTROLLER_CONTAINER_EXCESS_AUTHORITY');
    }else if(kind==='web'){
      const webRoot=cwd;invariant(inside(artifactRoot,webRoot)||inside(installationRoot,webRoot),'WEB_ROOT_OUTSIDE_INSTALLATION');mount(webRoot);mount(await secureDirectory(join(webRoot,'.next','cache')),true);
      for(const key of Object.keys(env))invariant(!/KEY|SECRET|DATABASE|DATA_ROOT|BOXLITE|RUNTIME_OWNER_HOME|UPGRADE_/.test(key),'WEB_CONTAINER_EXCESS_AUTHORITY');
    }else{
      mount(artifactRoot);
      if(kind==='api'){mount(c.bindingRoot);for(const key of Object.keys(env))invariant(!/^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROLLER_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_LEGACY_AUTH_CONTINUITY_KEY|UPGRADE_SESSION_SECRET|ACCESS_PASSCODE|PASSCODE_COOKIE_SECRET)$/.test(key),'CONTROL_CONTAINER_EXCESS_AUTHORITY');}
      if(kind==='coordinator'){
        if(env.UPGRADE_CONTROL_DATABASE_PATH){const ledger=c.stableControl?.controlDbPath;invariant(ledger===env.UPGRADE_CONTROL_DATABASE_PATH&&c.controlLedgerRoot&&join(c.controlLedgerRoot,'control.db')===ledger&&c.controlPrivateRoot&&!inside(c.controlPrivateRoot,c.controlLedgerRoot)&&!inside(c.controlLedgerRoot,c.controlPrivateRoot),'CONTROL_LEDGER_MOUNT_SCOPE_REQUIRED');mount(c.controlLedgerRoot);}
        mount(c.businessRoot,true);mount(c.bindingRoot,true);mount(join(c.installerRoot,'artifacts'));mount(c.trustRootPath);mount(env.UPGRADE_CATALOG_FILE);mount(env.UPGRADE_QUALIFICATION_INSTALLATION_PATH);
      }
      if(kind==='owner'){
        invariant(isAbsolute(ownerHome)&&inside(installationRoot,ownerHome)&&!inside(c.installerRoot,ownerHome)&&!inside(c.businessRoot,ownerHome),'OWNER_HOME_ISOLATION_REQUIRED');mount(ownerHome,true);
        const workspaces=await secureDirectory(join(c.businessRoot,'workspaces'));mount(workspaces,true);
        for(const key of Object.keys(env))invariant(!/^(?:DATA_ROOT|DATABASE_URL|PLATFORM_CONTROLLER_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_LEGACY_AUTH_CONTINUITY_KEY|UPGRADE_SESSION_SECRET)$/.test(key),'OWNER_CONTAINER_EXCESS_AUTHORITY');
      }
    }
    mount(env.NODE_EXTRA_CA_CERTS);
    mount(env.SSL_CERT_FILE);mount(env.SSL_CERT_DIR);
    for(const path of [...mounts.keys(),...foundationMounts.map(m=>m.source)])invariant((await fs.lstat(path).catch(()=>null)),'FIXED_CONTAINER_MOUNT_MISSING');
    const uid=c.uid??process.getuid(),gid=c.gid??process.getgid();invariant(Number.isSafeInteger(uid)&&uid>=0&&Number.isSafeInteger(gid)&&gid>=0,'FIXED_CONTAINER_USER_REQUIRED');
    const name=fixedRoleName(c.instanceId,{...record,kind}),argv=['run','--detach','--name',name,'--network','host','--read-only','--user',uid+':'+gid,'--label','agent-platform.instance='+c.instanceId,'--label','agent-platform.installation='+digest(installationRoot),'--label','agent-platform.start='+record.startIdentity,'--label','agent-platform.role='+kind,'--label','agent-platform.artifact='+record.artifactDigest,'--label','agent-platform.attempt='+record.attemptId,...(record.commandId?['--label','agent-platform.command='+record.commandId,'--label','agent-platform.operation='+record.operationId]:[]),'--tmpfs','/tmp:rw,nosuid,nodev,size=256m','--workdir',cwd];
    if(['control-agent','control-entry','control-supervisor'].includes(kind)){const resources=kind==='control-agent'?c.controlAgentResources:c.controlFoundationEntries[kind==='control-entry'?'entry':'supervisor'].resources;invariant(resources&&Number.isSafeInteger(resources.memoryBytes)&&resources.memoryBytes>=64*1024*1024&&Number.isSafeInteger(resources.cpuMilliCores)&&resources.cpuMilliCores>0&&Number.isSafeInteger(resources.pidsLimit)&&resources.pidsLimit>0&&resources.pidsLimit<=65536,'CONTROL_ROLE_RESOURCE_LIMITS_REQUIRED');argv.push(...roleResourceFlags({resources,pidsLimit:resources.pidsLimit,ioDevices:c.capacityIoDevices}));}
    else if(c.stableControl)argv.push(...roleResourceFlags({resources,pidsLimit:c.rolePidsLimits?.[kind],ioDevices:c.capacityIoDevices}));
    // Each role receives its own PID namespace. Only RuntimeOwner may access KVM.
    if(kind==='owner'){invariant((await fs.stat('/dev/kvm')).isCharacterDevice(),'OWNER_KVM_REQUIRED');argv.push('--device','/dev/kvm','--privileged');}
    else argv.push('--cap-drop','ALL','--security-opt','no-new-privileges');
    if(kind!=='owner')for(const value of image.Config.Env||[]){const name=value.split('=',1)[0];if(/^BOXLITE_/.test(name))argv.push('--env',name+'=');}
    for(const [path,rw]of mounts)argv.push('--mount',`type=bind,src=${path},dst=${path}${rw?'':',readonly'}`);
    for(const m of foundationMounts)argv.push('--mount',`type=bind,src=${m.source},dst=${m.destination}${m.rw?'':',readonly'}`);
    // Private env file is only read by the privileged supervisor and removed after
    // Docker has copied its values. Its path is never a Controller capability.
    const envPath=join(registryRoot,name+'.env');await fs.writeFile(envPath,Object.entries(env).map(([key,value])=>{invariant(/^[A-Z_][A-Z0-9_]*$/.test(key)&&typeof value==='string'&&!/[\r\n]/.test(value),'INVALID_FIXED_ROLE_ENV');return key+'='+value;}).join('\n')+'\n',{mode:0o600,flag:'wx'});
    argv.push('--env-file',envPath,'--entrypoint',c.node||'/usr/local/bin/node',imageId,...args);
    let containerId;try{if(record.commandId)await lifecycle.prepareStart(record);if(assertBeforeDispatch)await assertBeforeDispatch();containerId=(await docker(argv)).trim();}finally{await fs.rm(envPath,{force:true});}
    owned.add(containerId);const proof=await inspect(containerId);invariant(proof.running&&proof.pidNamespace==='private'&&proof.network==='host'&&proof.startIdentity===record.startIdentity,'CONTAINER_NOT_ISOLATED');
    await atomicJson(join(registryRoot,containerId+'.json'),{...proof,kind,instanceId:c.instanceId});await lifecycle.completeStart(record,proof);return proof;
  }
  async function signal(containerId,signal='SIGTERM'){
    invariant(signal==='SIGTERM','FIXED_OWNED_SIGNAL_REQUIRED');
    const receipt=await readJson(join(registryRoot,containerId+'.json'),null);invariant(owned.has(containerId)||receipt?.instanceId===c.instanceId,'CONTAINER_NOT_OWNED');const proof=await inspect(containerId);if(c.stableControl)invariant(!['owner','control-agent','control-entry','control-supervisor'].includes(proof.role),'PROTECTED_ROLE_STOP_FORBIDDEN');
    if(!proof.running)return proof;
    await docker(['kill','--signal',signal,containerId]);
    // Sending a signal is not evidence of absence. In particular, parking an
    // Installer and immediately starting the same owned container must wait for
    // the previous Node process to exit. Never escalate or signal it a second time.
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const row=JSON.parse(await docker(['inspect',containerId]))[0];
      invariant(row.Id===containerId&&row.Image===imageId&&row.Config.Labels['agent-platform.instance']===c.instanceId&&row.Config.Labels['agent-platform.installation']===digest(installationRoot)&&row.Config.Labels['agent-platform.start']===proof.startIdentity&&row.State.StartedAt===proof.startedAt,'CONTAINER_INCARNATION_CHANGED');
      if(row.State.Running===false&&row.State.Pid===0)return inspect(containerId);
      await new Promise(ok=>setTimeout(ok,50));
    }
    throw Object.assign(Error('The owned process has not been physically confirmed stopped'),{code:'OWNED_CONTAINER_STOP_UNCONFIRMED'});
  }
  async function restartInstaller(containerId){
    const receipt=await readJson(join(registryRoot,containerId+'.json'));invariant(receipt.instanceId===c.instanceId&&receipt.kind==='installer','ONLY_OWNED_INSTALLER_MAY_RESTART');
    const before=await inspect(containerId);invariant(before.running===false&&before.startIdentity===receipt.startIdentity,'INSTALLER_STILL_RUNNING');
    await docker(['start',containerId]);const proof=await inspect(containerId);invariant(proof.running&&proof.startIdentity===receipt.startIdentity&&proof.imageDigest===receipt.imageDigest,'INSTALLER_RESTART_IDENTITY_MISMATCH');
    owned.add(containerId);await atomicJson(join(registryRoot,containerId+'.json'),{...receipt,...proof});return proof;
  }
  const lifecycle=createProtectedRoleLifecycle({instanceId:c.instanceId,registryRoot,inspect,signalTerm:signal,findByName:async name=>{const ids=(await docker(['ps','--all','--no-trunc','--filter','name=^/'+name+'$','--format','{{.ID}}'])).trim().split(/\s+/).filter(Boolean);invariant(ids.length<=1&&ids.every(id=>/^[a-f0-9]{64}$/.test(id)),'ROLE_START_LOOKUP_UNKNOWN');return ids[0]||null;}});
  return {...lifecycle,launchControlAgent:spec=>launch({...spec,kind:'control-agent',stableBootstrap:true}),launchIndependentFoundation:spec=>{invariant(['entry','supervisor'].includes(spec.mode),'CONTROL_FOUNDATION_MODE_INVALID');return launch({...spec,kind:'control-'+spec.mode,stableBootstrap:true});},procRoot:c.procRoot||'/proc',cgroupRoot:c.cgroupRoot||'/sys/fs/cgroup',launch,inspect,signal,restartInstaller,imageDigest:imageId,isolation:'containers',ownedContainers:()=>[...owned]};
}
