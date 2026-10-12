import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join,resolve,isAbsolute } from 'node:path';
import { invariant,digest } from './trust.mjs';
import { secureDirectory,atomicJson,readJson,inside } from './io.mjs';

async function exec(program,args){return new Promise((ok,fail)=>{const child=spawn(program,args,{shell:false,stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',c=>{output+=c; if(output.length>4*1024*1024)child.kill();});child.stderr.on('data',c=>{error+=c;if(error.length>16384)error=error.slice(-8192);});child.once('error',fail);child.once('close',code=>code===0?ok(output):fail(Object.assign(Error('Dedicated container operation failed'),{code:'DEDICATED_CONTAINER_OPERATION_FAILED',detail:error})));});}
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
    let cgroup=null;if(row.State.Running)cgroup=(await docker(['exec',containerId,'cat','/proc/1/cgroup'])).trim();
    return {containerId:row.Id,imageDigest:row.Image,pid:1,hostPid:row.State.Pid,startIdentity:row.Config.Labels['agent-platform.start'],role:row.Config.Labels['agent-platform.role'],entrypoint:row.Config.Entrypoint,command:row.Config.Cmd,environmentNames:(row.Config.Env||[]).map(e=>e.split('=',1)[0]),workingDirectory:row.Config.WorkingDir,startedAt:row.State.StartedAt,running:row.State.Running,pidNamespace:row.HostConfig.PidMode||'private',network:row.HostConfig.NetworkMode,privileged:row.HostConfig.Privileged,cgroup,mounts:row.Mounts.map(m=>({type:m.Type,source:m.Source,destination:m.Destination,rw:m.RW})),capabilities:row.HostConfig.CapAdd||[]};
  }
  async function launch({kind,args,entry,env,cwd,artifactRoot,processRoot,ownerHome,record}){
    invariant(['api','web','coordinator','owner','installer'].includes(kind),'FIXED_CONTAINER_ROLE_REQUIRED');
    invariant(isAbsolute(entry)&&isAbsolute(cwd)&&Array.isArray(args)&&args[0]===entry&&args.length===(kind==='installer'?2:1),'FIXED_CONTAINER_ENTRY_REQUIRED');
    invariant(inside(artifactRoot,entry)||(kind==='web'&&inside(installationRoot,entry)),'CONTAINER_ENTRY_OUTSIDE_ARTIFACT');
    invariant(record.startIdentity,'CONTAINER_START_IDENTITY_REQUIRED');
    const mounts=new Map();const mount=(path,rw=false)=>{if(!path)return;invariant(isAbsolute(path)&&!path.includes(','),'FIXED_CONTAINER_MOUNT_REQUIRED');mounts.set(resolve(path),Boolean(rw));};
    if(kind==='installer'){
      mount(join(artifactRoot,'installer'));mount(c.installerRoot);mount(await secureDirectory(join(c.installerRoot,'journals')),true);mount(await secureDirectory(join(c.installerRoot,'downloads')),true);mount(c.bindingRoot);mount(c.trustRootPath);
      for(const key of Object.keys(env))invariant(!/^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_SESSION_SECRET)$/.test(key),'CONTROLLER_CONTAINER_EXCESS_AUTHORITY');
    }else if(kind==='web'){
      const webRoot=cwd;invariant(inside(artifactRoot,webRoot)||inside(installationRoot,webRoot),'WEB_ROOT_OUTSIDE_INSTALLATION');mount(webRoot);mount(await secureDirectory(join(webRoot,'.next','cache')),true);
      for(const key of Object.keys(env))invariant(!/KEY|SECRET|DATABASE|DATA_ROOT|BOXLITE|RUNTIME_OWNER_HOME|UPGRADE_/.test(key),'WEB_CONTAINER_EXCESS_AUTHORITY');
    }else{
      mount(artifactRoot);
      if(kind==='api'){mount(c.bindingRoot);for(const key of Object.keys(env))invariant(!/^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROLLER_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_SESSION_SECRET|ACCESS_PASSCODE|PASSCODE_COOKIE_SECRET)$/.test(key),'CONTROL_CONTAINER_EXCESS_AUTHORITY');}
      if(kind==='coordinator'){
        mount(c.businessRoot,true);mount(c.bindingRoot,true);mount(join(c.installerRoot,'artifacts'));mount(c.trustRootPath);mount(env.UPGRADE_CATALOG_FILE);mount(env.UPGRADE_QUALIFICATION_INSTALLATION_PATH);
      }
      if(kind==='owner'){
        invariant(isAbsolute(ownerHome)&&inside(installationRoot,ownerHome)&&!inside(c.installerRoot,ownerHome)&&!inside(c.businessRoot,ownerHome),'OWNER_HOME_ISOLATION_REQUIRED');mount(ownerHome,true);
        const workspaces=await secureDirectory(join(c.businessRoot,'workspaces'));mount(workspaces,true);
        for(const key of Object.keys(env))invariant(!/^(?:DATA_ROOT|DATABASE_URL|PLATFORM_CONTROLLER_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_SESSION_SECRET)$/.test(key),'OWNER_CONTAINER_EXCESS_AUTHORITY');
      }
    }
    mount(env.NODE_EXTRA_CA_CERTS);
    mount(env.SSL_CERT_FILE);mount(env.SSL_CERT_DIR);
    for(const [path]of mounts)invariant((await fs.lstat(path).catch(()=>null)),'FIXED_CONTAINER_MOUNT_MISSING');
    const uid=c.uid??process.getuid(),gid=c.gid??process.getgid();invariant(Number.isSafeInteger(uid)&&uid>=0&&Number.isSafeInteger(gid)&&gid>=0,'FIXED_CONTAINER_USER_REQUIRED');
    const name='upg-'+digest({instance:c.instanceId,start:record.startIdentity,kind}).slice(7,35),argv=['run','--detach','--name',name,'--network','host','--read-only','--user',uid+':'+gid,'--label','agent-platform.instance='+c.instanceId,'--label','agent-platform.installation='+digest(installationRoot),'--label','agent-platform.start='+record.startIdentity,'--label','agent-platform.role='+kind,'--tmpfs','/tmp:rw,nosuid,nodev,size=256m','--workdir',cwd];
    // Each role receives its own PID namespace. Only RuntimeOwner may access KVM.
    if(kind==='owner'){invariant((await fs.stat('/dev/kvm')).isCharacterDevice(),'OWNER_KVM_REQUIRED');argv.push('--device','/dev/kvm','--privileged');}
    else argv.push('--cap-drop','ALL','--security-opt','no-new-privileges');
    if(kind!=='owner')for(const value of image.Config.Env||[]){const name=value.split('=',1)[0];if(/^BOXLITE_/.test(name))argv.push('--env',name+'=');}
    for(const [path,rw]of mounts)argv.push('--mount',`type=bind,src=${path},dst=${path}${rw?'':',readonly'}`);
    // Private env file is only read by the privileged supervisor and removed after
    // Docker has copied its values. Its path is never a Controller capability.
    const envPath=join(registryRoot,name+'.env');await fs.writeFile(envPath,Object.entries(env).map(([key,value])=>{invariant(/^[A-Z_][A-Z0-9_]*$/.test(key)&&typeof value==='string'&&!/[\r\n]/.test(value),'INVALID_FIXED_ROLE_ENV');return key+'='+value;}).join('\n')+'\n',{mode:0o600,flag:'wx'});
    argv.push('--env-file',envPath,'--entrypoint',c.node||'/usr/local/bin/node',imageId,...args);
    let containerId;try{containerId=(await docker(argv)).trim();}finally{await fs.rm(envPath,{force:true});}
    owned.add(containerId);const proof=await inspect(containerId);invariant(proof.running&&proof.pidNamespace==='private'&&proof.network==='host'&&proof.startIdentity===record.startIdentity,'CONTAINER_NOT_ISOLATED');
    await atomicJson(join(registryRoot,containerId+'.json'),{...proof,kind,instanceId:c.instanceId});return proof;
  }
  async function signal(containerId,signal='SIGTERM'){
    invariant(['SIGTERM','SIGKILL'].includes(signal),'FIXED_OWNED_SIGNAL_REQUIRED');
    const receipt=await readJson(join(registryRoot,containerId+'.json'),null);invariant(owned.has(containerId)||receipt?.instanceId===c.instanceId,'CONTAINER_NOT_OWNED');const proof=await inspect(containerId);if(proof.running)await docker(['kill','--signal',signal,containerId]);
  }
  async function restartInstaller(containerId){
    const receipt=await readJson(join(registryRoot,containerId+'.json'));invariant(receipt.instanceId===c.instanceId&&receipt.kind==='installer','ONLY_OWNED_INSTALLER_MAY_RESTART');
    const before=await inspect(containerId);invariant(before.running===false&&before.startIdentity===receipt.startIdentity,'INSTALLER_STILL_RUNNING');
    await docker(['start',containerId]);const proof=await inspect(containerId);invariant(proof.running&&proof.startIdentity===receipt.startIdentity&&proof.imageDigest===receipt.imageDigest,'INSTALLER_RESTART_IDENTITY_MISMATCH');
    owned.add(containerId);await atomicJson(join(registryRoot,containerId+'.json'),{...receipt,...proof});return proof;
  }
  return {launch,inspect,signal,restartInstaller,imageDigest:imageId,isolation:'containers',ownedContainers:()=>[...owned]};
}
