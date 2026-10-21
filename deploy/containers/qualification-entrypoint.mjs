import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
const root='/run/qualification-docker',socket=root+'/docker.sock';
if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid()!==0||process.env.JENKINS_AGENT_NAME!=='linux-upgrade-evidence')throw Error('Dedicated qualification worker required');
if(process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw Error('External Docker authority is forbidden');
await fs.mkdir(root,{recursive:true,mode:0o700});await fs.chmod(root,0o710);await fs.chown(root,0,1000);
const daemon=spawn('/usr/local/bin/dockerd',['--host','unix://'+socket,'--data-root','/var/lib/qualification-docker','--exec-root',root+'/exec','--pidfile',root+'/daemon.pid','--bridge','none','--iptables=false','--ip-forward=false','--ip-masq=false','--live-restore','--storage-driver','overlay2'],{stdio:['ignore','inherit','inherit'],shell:false,env:{PATH:'/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}});
await new Promise((ok,fail)=>{daemon.once('spawn',ok);daemon.once('error',fail);});
const deadline=Date.now()+120000;
while(true){const stat=await fs.lstat(socket).catch(()=>null);if(stat?.isSocket()){await fs.chown(socket,0,1000);await fs.chmod(socket,0o660);break;}if(daemon.exitCode!==null||Date.now()>deadline)throw Error('Dedicated qualification daemon did not start');await new Promise(ok=>setTimeout(ok,100));}
// Jenkins and its browser/CLI test runner have authority only over this private
// daemon. The distribution publisher and API build daemon never receive it.
const worker=spawn('/usr/local/bin/node',['/opt/agent-platform/tools/deploy/containers/publication-entrypoint.mjs'],{uid:1000,gid:1000,stdio:'inherit',shell:false,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/jenkins',JENKINS_URL:process.env.JENKINS_URL,JENKINS_AGENT_NAME:'linux-upgrade-evidence',JENKINS_AGENT_SECRET_FILE:'/run/secrets/jenkins_agent_secret'}});
worker.once('error',()=>{process.exitCode=1;});worker.once('exit',code=>{process.exitCode=code??1;});
// The worker is long lived. Its shutdown is an installation operation, never a
// CD post-build cleanup of a failed test's retained Owner/VM resources.
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>worker.kill(signal));
