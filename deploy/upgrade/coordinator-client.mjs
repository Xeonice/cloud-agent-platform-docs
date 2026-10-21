import { readFile,lstat } from 'node:fs/promises';
import { invariant } from './trust.mjs';
import { randomUUID } from 'node:crypto';
export function createCoordinatorClient({ origin, instanceId, key, fetcher = fetch, timeoutMs = 5000, bindingPath=null, requestContext, independentControl=false }) {
  const url = new URL(origin); invariant(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && key?.length>=32,'UNSAFE_COORDINATOR_CONFIG');
  let observedOrigin=url.origin,observedGeneration=0;
  const capabilities = new Map(), attemptGenerations = new Map();
  const bindingKey = () => `${observedOrigin}:${observedGeneration}`;
  function remember(result) {
    const snapshot = result?.snapshot || result;
    if (snapshot?.controllerCapabilities) capabilities.set(bindingKey(), snapshot.controllerCapabilities);
    const id = snapshot?.attempt?.attemptId || result?.attemptId;
    const generation = snapshot?.attempt?.generation ?? result?.generation;
    if (typeof id === 'string' && Number.isSafeInteger(generation)) attemptGenerations.set(id, generation);
    return result;
  }
  async function fastPath(selection) {
    await actualOrigin(selection);
    return capabilities.get(bindingKey())?.controlFastPath === 1;
  }
  async function actualOrigin({allowQuiescing=false,attemptId=null,fence=null}={}) {
    if(!bindingPath)return observedOrigin;
    const context=requestContext?.();
    if(context?.recoveryId && (context.businessAttemptId!==undefined||context.businessFence!==undefined)) {
      invariant(typeof context.businessAttemptId==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(context.businessAttemptId)&&Number.isSafeInteger(context.businessFence)&&context.businessFence>0,'CONTROL_RECOVERY_BINDING_SCOPE_INVALID');
      // This selects the existing quiescing transport only. The RPC remains
      // authorized by the new recovery epoch; the old fence grants no rights.
      allowQuiescing=true;attemptId=context.businessAttemptId;fence=context.businessFence;
    }
    const deadline=Date.now()+2000;
    while(true) {
      const stat=await lstat(bindingPath);invariant(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o022)===0,'INSECURE_COORDINATOR_BINDING');
      const binding=JSON.parse(await readFile(bindingPath,'utf8'));
      invariant(binding.instanceId===instanceId&&Number.isSafeInteger(binding.generation)&&binding.generation>=observedGeneration&&['ready','quiescing'].includes(binding.state),'COORDINATOR_BINDING_UNKNOWN');
      if(binding.state==='ready'||allowQuiescing&&binding.attemptId===attemptId&&binding.fence===fence) {
        const next=new URL(binding.origin);invariant(next.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(next.hostname)&&next.pathname==='/'&&!next.username&&!next.password&&!next.search&&!next.hash,'UNSAFE_COORDINATOR_BINDING');
        observedOrigin=next.origin;observedGeneration=binding.generation;return observedOrigin;
      }
      invariant(Date.now()<deadline,'COORDINATOR_HANDOFF_WAIT_EXCEEDED');await new Promise(ok=>setTimeout(ok,10));
    }
  }
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
  function controlReadOptions(options) {
    if(options?.timeoutMs===undefined)return undefined;
    invariant(Number.isSafeInteger(options.timeoutMs)&&options.timeoutMs>0&&options.timeoutMs<=120000,'INVALID_CONTROL_READ_TIMEOUT');
    return {timeoutMs:options.timeoutMs};
  }
  async function rpc(path,body,selection,requestOptions) {
    const started=Date.now(),monotonicStart=performance.now(),liveContext=requestContext?.();
    const requestTimeoutMs=Math.min(requestOptions?.timeoutMs??timeoutMs,Number.isSafeInteger(liveContext?.deadline)?liveContext.deadline-started:Infinity);
    const requestKind=path.endsWith('/authority-check')||path.endsWith('/renew')&&body?.checkOnly===true?'fence-check':path.endsWith('/lease-renew')||path.endsWith('/renew')?'lease-renew':path.endsWith('/progress-checkpoint')||path.includes('/progress-checkpoint?')?'progress-checkpoint':path.endsWith('/commit')||path.endsWith('/commit-receipt')?'event-commit':'control-read';
    const traceId=randomUUID();let bindingMs=null,serializationMs=null,firstResponseMs=null,decodeMs=null;
    try {
      const activeOrigin=requestOptions?.fixedOrigin??await actualOrigin(selection);
      bindingMs=performance.now()-monotonicStart;
      const serialStart=performance.now(),serialized=body?JSON.stringify(body):undefined;serializationMs=performance.now()-serialStart;
      const context=liveContext,contextHeaders={};
      if(context?.recoveryId){invariant(!context.contractId&&/^[a-f0-9-]{36}$/i.test(context.recoveryId)&&Number.isSafeInteger(context.epoch)&&context.epoch>0,'CONTROL_RECOVERY_CONTEXT_INVALID');contextHeaders['x-platform-recovery-id']=context.recoveryId;contextHeaders['x-platform-recovery-epoch']=String(context.epoch);contextHeaders['x-platform-control-epoch']=String(context.epoch);}
      if(context?.contractId){invariant(!context.recoveryId&&/^[a-f0-9-]{36}$/i.test(context.contractId)&&Number.isSafeInteger(context.epoch)&&context.epoch>0,'CONTROL_CONTRACT_CONTEXT_INVALID');contextHeaders['x-platform-contract-id']=context.contractId;contextHeaders['x-platform-control-epoch']=String(context.epoch);}
      if(context?.commandId||context?.specDigest){invariant(typeof context.commandId==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(context.commandId)&&/^sha256:[a-f0-9]{64}$/.test(context.specDigest),'CONTROL_COMMAND_CONTEXT_INVALID');contextHeaders['x-platform-control-command-id']=context.commandId;contextHeaders['x-platform-control-spec-digest']=context.specDigest;}
      const remaining=Math.ceil(requestTimeoutMs-(performance.now()-monotonicStart));
      if(remaining<=0)throw new DOMException('Control request deadline exceeded','TimeoutError');
      const headersStart=performance.now();
      const r=await fetcher(activeOrigin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-platform-internal-key':key,'x-platform-instance-id':instanceId,'x-platform-control-request-kind':requestKind,'x-platform-control-trace-id':traceId,...contextHeaders},body:serialized,signal:AbortSignal.timeout(remaining)});
      firstResponseMs=performance.now()-headersStart;const bodyStart=performance.now();
      const result=await r.json();decodeMs=performance.now()-bodyStart;if(!r.ok)throw Object.assign(new Error(result.error?.code||result.code||'COORDINATOR_RPC_FAILED'),{code:result.error?.code||result.code||'COORDINATOR_RPC_FAILED',status:r.status});
      return remember(result.data ?? result);
    } catch(error) {
      const failure=error instanceof Error?error:new Error('Coordinator RPC failed',{cause:error});
      const context={path:path.split('?')[0],action:['prepare','status','quiesce','release','adopt','batch'].includes(body?.action)?body.action:null,requestKind,traceId,timeoutMs:requestTimeoutMs,startedAt:new Date(started).toISOString(),elapsedMs:performance.now()-monotonicStart,bindingMs,serializationMs,firstResponseMs,decodeMs};
      // Only fixed routing/timing facts reach the durable fault receipt. Never
      // include origins, headers, body, credentials or query parameter values.
      failure.rpcContext=context;failure.faultEvidence={rpc:context};throw failure;
    }
  }
  const prefix=id=>'/internal/upgrades/'+encodeURIComponent(id);
  return {
    get origin(){return observedOrigin;},instanceId,
    pending:()=>rpc('/internal/upgrades/pending'),
    claim:(id,body)=>rpc(prefix(id)+'/claim',body),
    renew:async(id,body)=>(await fastPath())&&attemptGenerations.has(id)?rpc(prefix(id)+'/lease-renew',{...body,generation:attemptGenerations.get(id)}):rpc(prefix(id)+'/renew',body),
    commit:async(id,body)=>rpc(prefix(id)+(await fastPath()?'/commit-receipt':'/commit'),body),
    step:(id,stepId)=>rpc(prefix(id)+'/steps/'+encodeURIComponent(stepId)),
    snapshot:id=>rpc(prefix(id)),
    assertFence:async(id,fence)=>{
      const selection={allowQuiescing:true,attemptId:id,fence};
      return await fastPath(selection)?rpc(prefix(id)+'/authority-check',{fence,...(attemptGenerations.has(id)&&!requestContext?.()?.recoveryId?{generation:attemptGenerations.get(id)}:{})},selection):rpc(prefix(id)+'/renew',{fence,controllerId:null,checkOnly:true},selection);
    },
    progressCheckpoint:async(id,{fence,generation})=>{
      if(!await fastPath())return null;
      return rpc(prefix(id)+'/progress-checkpoint?fence='+encodeURIComponent(fence)+'&generation='+encodeURIComponent(generation));
    },
    migration:(id,body,requestOptions)=>rpc(prefix(id)+'/migration',body,undefined,migrationOptions(body,requestOptions)),
    observation:(id,body,requestOptions)=>rpc('/internal/upgrades/observation?attemptId='+encodeURIComponent(id)+'&fence='+body.fence+'&weight='+body.weight,undefined,undefined,controlReadOptions(requestOptions)),
    continuity:(id,body)=>rpc('/internal/upgrades/continuity?attemptId='+encodeURIComponent(id)+'&fence='+body.fence),
    validateSwitch:(id,body)=>rpc(prefix(id)+'/validate-switch',body),
    fallbackEligibility:(id,body,requestOptions)=>rpc(prefix(id)+'/fallback-eligibility',body,undefined,controlReadOptions(requestOptions)),
    controllerHandoff:(id,body)=>rpc(prefix(id)+'/controller-handoff',body),
    coordinatorHandoff:async(id,body,requestOptions)=>{
      if(independentControl&&body.action==='adopt') {
        const u=new URL(body.candidate?.managementOrigin??'');
        invariant(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password&&typeof body.candidate?.startIdentity==='string','UNSAFE_PREPARED_COORDINATOR_ORIGIN');
        return rpc('/internal/coordinator/adopt',{instanceId,attemptId:id,fence:body.fence,operationId:body.operationId,planDigest:body.planDigest,startIdentity:body.candidate.startIdentity},undefined,{fixedOrigin:u.origin});
      }
      return rpc(prefix(id)+'/coordinator-handoff',body,{allowQuiescing:true,attemptId:id,fence:body.fence},preparationOptions(body,requestOptions));
    },
    ownerCandidate:async(id,body,requestOptions)=>rpc(prefix(id)+'/owner-candidate',body,undefined,preparationOptions(body,requestOptions)),
    coordinatorRecovery:(id,body)=>rpc(prefix(id)+'/coordinator-recovery',body),
    coordinatorResume:(id,body)=>rpc(prefix(id)+'/coordinator-resume',body,{allowQuiescing:true,attemptId:id,fence:body.fence}),
    recoveryAdmission:(id,body)=>rpc(prefix(id)+'/recovery-admission',body,{allowQuiescing:true,attemptId:id,fence:body.fence}),
    recoveryActions:(id)=>rpc(prefix(id)+'/recovery-actions'),
    inspection:(body,requestOptions)=>rpc('/internal/upgrades/inspection',body,undefined,controlReadOptions(requestOptions)),
    contractBusiness:(body,requestOptions)=>rpc('/internal/upgrades/contract-business',body,undefined,controlReadOptions(requestOptions)),
    stabilizeCurrentWriter:(id,body)=>rpc(prefix(id)+'/stabilize-current-writer',body),
    processObserve:body=>rpc('/internal/upgrades/process-observe',body),
    contractSnapshot:id=>rpc('/internal/contracts/'+encodeURIComponent(id)),
    assertContractFence:(id,fence)=>rpc('/internal/contracts/'+encodeURIComponent(id)+'/check',{fence}),
  };
}
