import { readFile,lstat } from 'node:fs/promises';
import { invariant } from './trust.mjs';
export function createCoordinatorClient({ origin, instanceId, key, fetcher = fetch, timeoutMs = 5000, bindingPath=null }) {
  const url = new URL(origin); invariant(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && key?.length>=32,'UNSAFE_COORDINATOR_CONFIG');
  let observedOrigin=url.origin,observedGeneration=0;
  async function actualOrigin({allowQuiescing=false,attemptId=null,fence=null}={}){if(!bindingPath)return observedOrigin;const deadline=Date.now()+2000;while(true){const stat=await lstat(bindingPath);invariant(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o022)===0,'INSECURE_COORDINATOR_BINDING');const binding=JSON.parse(await readFile(bindingPath,'utf8'));invariant(binding.instanceId===instanceId&&Number.isSafeInteger(binding.generation)&&binding.generation>=observedGeneration&&['ready','quiescing'].includes(binding.state),'COORDINATOR_BINDING_UNKNOWN');if(binding.state==='ready'||(allowQuiescing&&binding.attemptId===attemptId&&binding.fence===fence)){const next=new URL(binding.origin);invariant(next.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(next.hostname)&&next.pathname==='/'&&!next.username&&!next.password&&!next.search&&!next.hash,'UNSAFE_COORDINATOR_BINDING');observedOrigin=next.origin;observedGeneration=binding.generation;return observedOrigin;}invariant(Date.now()<deadline,'COORDINATOR_HANDOFF_WAIT_EXCEEDED');await new Promise(ok=>setTimeout(ok,10));}}
  function preparationOptions(body,options) {
    if(options?.timeoutMs===undefined)return undefined;
    invariant(body?.action==='prepare','PREPARATION_TIMEOUT_NOT_ALLOWED');
    invariant(Number.isSafeInteger(options.timeoutMs)&&options.timeoutMs>0&&options.timeoutMs<=120000,'INVALID_PREPARATION_TIMEOUT');
    return {timeoutMs:options.timeoutMs};
  }
  function migrationOptions(body,options) {
    if(options?.timeoutMs===undefined)return undefined;
    invariant(['prepare','status'].includes(body?.action),'MIGRATION_TIMEOUT_NOT_ALLOWED');
    invariant(Number.isSafeInteger(options.timeoutMs)&&options.timeoutMs>0&&options.timeoutMs<=120000,'INVALID_MIGRATION_TIMEOUT');
    return {timeoutMs:options.timeoutMs};
  }
  async function rpc(path,body,selection,requestOptions) {
    const activeOrigin=await actualOrigin(selection);
    const r=await fetcher(activeOrigin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-platform-internal-key':key,'x-platform-instance-id':instanceId},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(requestOptions?.timeoutMs??timeoutMs)});
    const result=await r.json();if(!r.ok)throw Object.assign(new Error(result.error?.code||result.code||'COORDINATOR_RPC_FAILED'),{code:result.error?.code||result.code||'COORDINATOR_RPC_FAILED',status:r.status});
    return result.data ?? result;
  }
  const prefix=id=>'/internal/upgrades/'+encodeURIComponent(id);
  return {
    get origin(){return observedOrigin;},instanceId,
    pending:()=>rpc('/internal/upgrades/pending'),
    claim:(id,body)=>rpc(prefix(id)+'/claim',body),
    renew:(id,body)=>rpc(prefix(id)+'/renew',body),
    commit:(id,body)=>rpc(prefix(id)+'/commit',body),
    step:(id,stepId)=>rpc(prefix(id)+'/steps/'+encodeURIComponent(stepId)),
    snapshot:id=>rpc(prefix(id)),
    assertFence:(id,fence)=>rpc(prefix(id)+'/renew',{fence,controllerId:null,checkOnly:true},{allowQuiescing:true,attemptId:id,fence}),
    migration:(id,body,requestOptions)=>rpc(prefix(id)+'/migration',body,undefined,migrationOptions(body,requestOptions)),
    observation:(id,body)=>rpc('/internal/upgrades/observation?attemptId='+encodeURIComponent(id)+'&fence='+body.fence+'&weight='+body.weight),
    continuity:(id,body)=>rpc('/internal/upgrades/continuity?attemptId='+encodeURIComponent(id)+'&fence='+body.fence),
    validateSwitch:(id,body)=>rpc(prefix(id)+'/validate-switch',body),
    fallbackEligibility:(id,body)=>rpc(prefix(id)+'/fallback-eligibility',body),
    controllerHandoff:(id,body)=>rpc(prefix(id)+'/controller-handoff',body),
    coordinatorHandoff:async(id,body,requestOptions)=>rpc(prefix(id)+'/coordinator-handoff',body,{allowQuiescing:true,attemptId:id,fence:body.fence},preparationOptions(body,requestOptions)),
    ownerCandidate:async(id,body,requestOptions)=>rpc(prefix(id)+'/owner-candidate',body,undefined,preparationOptions(body,requestOptions)),
    coordinatorRecovery:(id,body)=>rpc(prefix(id)+'/coordinator-recovery',body),
    processObserve:body=>rpc('/internal/upgrades/process-observe',body),
    contractSnapshot:id=>rpc('/internal/contracts/'+encodeURIComponent(id)),
    assertContractFence:(id,fence)=>rpc('/internal/contracts/'+encodeURIComponent(id)+'/check',{fence}),
  };
}
