import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invariant } from '../upgrade/trust.mjs';
import { createPrivateControlRpc } from '../upgrade/control-rpc.mjs';

async function privateJson(path) {
  const stat=await fs.lstat(path);
  invariant(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.size<=262144,'NORMAL_RETIREMENT_PRIVATE_INPUT_REQUIRED');
  return JSON.parse(await fs.readFile(path,'utf8'));
}
/** Uses the installed Agent's existing private capability; no user-facing
 * upgrade secret, Docker access, SDK access or arbitrary process target. */
export async function retireUpgradeCandidate(action,agentConfigPath,input) {
  invariant(['submit','status','reconcile'].includes(action),'NORMAL_RETIREMENT_COMMAND_INVALID');
  const c=await privateJson(resolve(agentConfigPath));
  invariant(Number.isInteger(c.controlPort)&&c.controlPort>0&&c.controlPort<65536,'NORMAL_RETIREMENT_AGENT_CONFIG_REQUIRED');
  const rpc=createPrivateControlRpc({origin:`http://127.0.0.1:${c.controlPort}`,instanceId:c.instanceId,key:c.controllerKey,maxBytes:65536,timeoutMs:2000});
  if(action==='submit')return rpc('/internal/control/retirements',await privateJson(resolve(input)));
  invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input),'NORMAL_RETIREMENT_OPERATION_ID_REQUIRED');
  return rpc('/internal/control/retirements/'+input+(action==='reconcile'?'/reconcile':''),action==='reconcile'?{}:undefined);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  retireUpgradeCandidate(...process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{
    const code=/^[A-Z][A-Z0-9_]{1,99}$/.test(error?.code||error?.message||'')?error.code||error.message:'NORMAL_RETIREMENT_FAILED';
    process.stderr.write(JSON.stringify({error:{code}})+'\n');process.exitCode=1;
  });
}
