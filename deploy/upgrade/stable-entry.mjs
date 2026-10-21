import http from 'node:http';
import net from 'node:net';
import { createHmac, timingSafeEqual,randomUUID } from 'node:crypto';
import { readFile, stat, open, rename, unlink } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { atomicJson, readJson, inside, secureDirectory } from './io.mjs';
import { invariant, DIGEST, canonical } from './trust.mjs';
import { actualInstallerIdentity } from './installer-identity.mjs';
import { signEntryContext, stripEntryForwardingHeaders, decodeEntryControlContext, persistedEntryBinding, entryBindingDigest } from './control-entry-context.mjs';
const isLoopback = address => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const tokenMatches = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
function origin(value) { const u = new URL(value); invariant(u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash, 'UNSAFE_BACKEND'); return u.origin; }
export function validateBinding(value) {
  invariant(value && typeof value.instanceId === 'string' && Number.isSafeInteger(value.fence) && value.fence > 0 && Number.isSafeInteger(value.routeGeneration) && value.routeGeneration > 0, 'INVALID_BINDING');
  invariant(Number.isInteger(value.weight) && value.weight >= 0 && value.weight <= 100 && value.oldApi && DIGEST.test(value.oldApi.digest), 'INVALID_ROUTE'); origin(value.oldApi.origin);
  if (value.weight) { invariant(value.candidateApi && DIGEST.test(value.candidateApi.digest), 'INVALID_CANDIDATE_ROUTE'); origin(value.candidateApi.origin); }
  if (value.web?.origin) origin(value.web.origin);
  invariant(value.web && DIGEST.test(value.web.digest) && DIGEST.test(value.web.treeDigest) && typeof value.web.root === 'string', 'INVALID_WEB_BINDING');
  invariant(Array.isArray(value.retainedWeb) && value.retainedWeb.every(w => DIGEST.test(w.digest) && typeof w.root === 'string'), 'INVALID_RETAINED_WEB');
  return value;
}
export async function createStableEntry({ root, instanceId, controlKey, observerKey = null, stickyKey, verifyFence, verifyContractFence, initialBinding, host = '127.0.0.1', port = 0, controlPort = 0, controlOrigin = null, privateEntryKey = null, businessProbeKey = null, verifyControlAuthority, clock = Date.now, controlRequestTimeoutMs = 2000, maxControlRequests = 32 }) {
  invariant(typeof verifyFence === 'function' && controlKey?.length >= 32 && stickyKey?.length >= 32, 'ENTRY_AUTH_REQUIRED');
  invariant(observerKey === null || typeof observerKey === 'string' && observerKey.length >= 32 && observerKey !== controlKey && observerKey !== privateEntryKey, 'ENTRY_OBSERVER_KEY_INVALID');
  const independent = controlOrigin !== null || privateEntryKey !== null;
  invariant(!independent || typeof controlOrigin === 'string' && typeof privateEntryKey === 'string' && privateEntryKey.length >= 32 && typeof verifyControlAuthority === 'function', 'ENTRY_CONTROL_CONFIGURATION_REQUIRED');
  invariant(businessProbeKey===null||typeof businessProbeKey==='string'&&businessProbeKey.length>=32,'ENTRY_CONTROL_CONFIGURATION_REQUIRED');
  invariant(Number.isSafeInteger(controlRequestTimeoutMs) && controlRequestTimeoutMs > 0 && controlRequestTimeoutMs <= 2000 && Number.isSafeInteger(maxControlRequests) && maxControlRequests > 0 && maxControlRequests <= 128, 'ENTRY_CONTROL_CONFIGURATION_REQUIRED');
  const agentOrigin = independent ? origin(controlOrigin) : null;
  root = await secureDirectory(root); const configPath = join(root,'entry-binding.json'); let binding = await readJson(configPath, null);
  if (!binding) { binding = validateBinding(initialBinding); invariant(binding.instanceId === instanceId, 'WRONG_INSTANCE'); await atomicJson(configPath, binding); }
  validateBinding(binding); invariant(binding.instanceId === instanceId, 'WRONG_INSTANCE');
  const fencePath=join(root,'entry-fence.json');let admission=await readJson(fencePath,{instanceId,attemptId:binding.attemptId,fence:binding.fence});invariant(admission.instanceId===instanceId&&Number.isSafeInteger(admission.fence)&&admission.fence>=binding.fence,'INVALID_ENTRY_ADMISSION');await atomicJson(fencePath,admission);
  const controlAdmissionPath=join(root,'entry-control-admission.json');
  let controlAdmission=await readJson(controlAdmissionPath,{schemaVersion:1,instanceId,revision:0,epoch:0,operationId:null,executorId:null,kind:null,leaseExpiresAt:0});
  invariant(controlAdmission.schemaVersion===1&&controlAdmission.instanceId===instanceId&&Number.isSafeInteger(controlAdmission.revision)&&controlAdmission.revision>=0&&Number.isSafeInteger(controlAdmission.epoch)&&controlAdmission.epoch>=0&&Number.isSafeInteger(controlAdmission.leaseExpiresAt)&&controlAdmission.leaseExpiresAt>=0,'INVALID_ENTRY_CONTROL_ADMISSION');
  if(controlAdmission.epoch>0)invariant(controlAdmission.revision>0&&typeof controlAdmission.operationId==='string'&&typeof controlAdmission.executorId==='string'&&['upgrade','recovery','maintenance','contract'].includes(controlAdmission.kind)&&(controlAdmission.kind!=='recovery'||typeof controlAdmission.recoveryId==='string'),'INVALID_ENTRY_CONTROL_ADMISSION');
  invariant(independent||controlAdmission.epoch===0,'ENTRY_CONTROL_CONFIGURATION_REQUIRED');
  if(independent)await atomicJson(controlAdmissionPath,controlAdmission);
  const actualGateway={...await actualInstallerIdentity({instanceId,startIdentity:randomUUID()}),role:'gateway',independentFoundation:true,preservesExistingSockets:true};
  const connections = new Map(), httpByDigest = new Map(), httpTransfers = new Set(), ownedSockets = new Set(); let inFlight = 0, controlInFlight = 0, closing = false, closingPromise;
  const publicControlPath=pathname=>pathname!=='/api/system/upgrade/probe'&&(pathname==='/api/system/upgrade'||pathname.startsWith('/api/system/upgrade/')||pathname==='/api/system/access-passcode');
  function forwardedHeaders(req,signed=false){
    if(!independent)return{...req.headers,'x-forwarded-host':req.headers.host,'x-forwarded-proto':'http','x-platform-route-generation':String(binding.routeGeneration)};
    const headers={...stripEntryForwardingHeaders(req.headers),'x-forwarded-host':req.headers.host,'x-forwarded-proto':'http','x-forwarded-for':req.socket.remoteAddress||'unknown'};
    if(new URL(req.url,'http://localhost').pathname==='/api/system/upgrade/probe'&&businessProbeKey!==null&&isLoopback(req.socket.remoteAddress)&&tokenMatches(req.headers['x-platform-internal-key'],businessProbeKey)&&req.headers['x-platform-instance-id']===instanceId){
      headers['x-platform-internal-key']=businessProbeKey;headers['x-platform-instance-id']=instanceId;
      const recoveryId=req.headers['x-platform-recovery-id'],canonicalEpoch=req.headers['x-platform-recovery-epoch'],aliasEpoch=req.headers['x-platform-control-epoch'],epoch=canonicalEpoch??aliasEpoch;
      if(typeof recoveryId==='string'&&/^[a-f0-9-]{36}$/i.test(recoveryId)&&typeof epoch==='string'&&/^[1-9][0-9]{0,14}$/.test(epoch)&&Number.isSafeInteger(Number(epoch))&&(canonicalEpoch===undefined||aliasEpoch===undefined||canonicalEpoch===aliasEpoch)){headers['x-platform-recovery-id']=recoveryId;headers['x-platform-recovery-epoch']=epoch;if(aliasEpoch!==undefined)headers['x-platform-control-epoch']=epoch;}
    }
    return signed?{...headers,...signEntryContext({instanceId,key:privateEntryKey,remoteAddress:req.socket.remoteAddress||null,method:req.method,path:req.url,clock})}:{...headers,'x-platform-route-generation':String(binding.routeGeneration)};
  }
  function trackHTTP(proxy,res) {
    const transfer={request:proxy,response:null};httpTransfers.add(transfer);
    proxy.once('close',()=>httpTransfers.delete(transfer));
    res.once('close',()=>{if(!res.writableEnded){transfer.response?.destroy();proxy.destroy();}httpTransfers.delete(transfer);});
    return transfer;
  }
  function trackSocket(socket){if(closing){socket.destroy();return;}ownedSockets.add(socket);socket.once('close',()=>ownedSockets.delete(socket));}
  function backend(req) {
    // One route per authenticated session; no fan-out, duplicate writes, retries or input replay.
    const identity = String(req.headers.cookie || req.headers.authorization || req.headers['x-operation-id'] || req.socket.remoteAddress);
    const bucket = createHmac('sha256',stickyKey).update(identity).digest().readUInt32BE() % 100;
    return binding.weight > bucket ? binding.candidateApi : binding.oldApi;
  }
  async function staticWeb(req,res) {
    const url = new URL(req.url, 'http://localhost'), match = /^\/_upg\/web\/(sha256-[a-f0-9]{64})\/(.*)$/.exec(url.pathname);
    let web = binding.web, requestPath = decodeURIComponent(url.pathname);
    if (match) { const d = match[1].replace('sha256-','sha256:'); web = [binding.web,...binding.retainedWeb].find(w => w.digest === d); if (!web) { res.writeHead(404); res.end(); return; } requestPath = '/' + match[2]; }
    const webRoot = resolve(web.root), path = resolve(webRoot, '.' + normalize(requestPath)); invariant(inside(webRoot,path), 'WEB_PATH_ESCAPE');
    const info = await stat(path).catch(() => null); let file = info?.isFile() ? path : join(webRoot,'index.html');
    if (requestPath.startsWith('/_next/')) {
      file = info?.isFile() ? path : null;
      if (!file) for (const old of binding.retainedWeb) { const p = resolve(old.root, '.' + normalize(requestPath)); if (inside(old.root,p) && (await stat(p).catch(() => null))?.isFile()) { file = p; break; } }
      if (!file) { res.writeHead(404); res.end(); return; }
    }
    if (web.origin && !match && !requestPath.startsWith('/_next/')) {
      const u = new URL(web.origin); let transfer; const proxy = http.request({ hostname:u.hostname, port:u.port, method:req.method, path:req.url, headers:req.headers }, upstream => { transfer.response=upstream;if(res.destroyed){upstream.destroy();return;}res.writeHead(upstream.statusCode,{...upstream.headers,'x-platform-web-digest':web.digest}); upstream.pipe(res); });transfer=trackHTTP(proxy,res);proxy.once('error',()=>{if(res.destroyed)return;if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(proxy);return;
    }
    const bytes = await readFile(file); const extension = file.split('.').at(-1); const types = { html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',svg:'image/svg+xml',woff2:'font/woff2' };
    res.writeHead(200,{ 'content-type': types[extension] || 'application/octet-stream', 'cache-control': requestPath.startsWith('/_next/') || match ? 'public, max-age=31536000, immutable' : 'no-store', 'x-platform-web-digest': web.digest }); res.end(bytes);
  }
  const server = http.createServer((req,res) => {
    if(closing){res.writeHead(503);res.end();return;}
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(independent&&publicControlPath(pathname)){
      if(controlInFlight>=maxControlRequests){res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({code:'ENTRY_CONTROL_BUSY'}));return;}
      let headers;try{headers=forwardedHeaders(req,true);}catch{res.writeHead(400);res.end();return;}
      controlInFlight++;const u=new URL(agentOrigin);let transfer;
      const proxy=http.request({hostname:u.hostname,port:u.port,method:req.method,path:req.url,headers},upstream=>{transfer.response=upstream;if(res.destroyed){upstream.destroy();return;}res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);});transfer=trackHTTP(proxy,res);
      const deadline=setTimeout(()=>{proxy.destroy();if(!res.destroyed&&!res.writableEnded){if(!res.headersSent)res.writeHead(504,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({code:'ENTRY_CONTROL_TIMEOUT'}));}},controlRequestTimeoutMs);
      res.once('close',()=>{clearTimeout(deadline);controlInFlight--;});proxy.once('error',()=>{if(res.destroyed||res.writableEnded)return;if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(proxy);return;
    }
    const controlPath=['/api','/mcp','/ws','/socket.io'].some(prefix=>pathname===prefix||pathname.startsWith(prefix+'/'));
    if (!controlPath) { staticWeb(req,res).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); }); return; }
    const selected = backend(req), u = new URL(selected.origin); inFlight++; httpByDigest.set(selected.digest,(httpByDigest.get(selected.digest)||0)+1);
    let transfer;const proxy = http.request({ hostname:u.hostname, port:u.port, method:req.method, path:req.url, headers:forwardedHeaders(req) }, upstream => {transfer.response=upstream;if(res.destroyed){upstream.destroy();return;}res.writeHead(upstream.statusCode,upstream.headers); upstream.pipe(res); });transfer=trackHTTP(proxy,res);
    res.once('close',()=>{ inFlight--; httpByDigest.set(selected.digest,Math.max(0,(httpByDigest.get(selected.digest)||1)-1)); }); proxy.once('error',()=>{ if(res.destroyed)return;if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  server.on('connection',trackSocket);
  server.on('upgrade',(req,socket,head)=>{
    if(closing){socket.destroy();return;}
    if(independent&&publicControlPath(new URL(req.url,'http://localhost').pathname)){socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;}
    const selected = backend(req), u = new URL(selected.origin); const target = net.connect({host:u.hostname,port:Number(u.port)}); const id = Symbol(); connections.set(id,{target,socket,digest:selected.digest,openedAt:Date.now()});
    target.once('connect',()=>{ let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;if(independent){for(const[name,value]of Object.entries({...forwardedHeaders(req),connection:'Upgrade',upgrade:req.headers.upgrade}))if(value!==undefined)headers+=`${name}: ${Array.isArray(value)?value.join(', '):value}\r\n`;}else for (let i=0;i<req.rawHeaders.length;i+=2) headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`; target.write(headers+'\r\n'); if(head.length) target.write(head); socket.pipe(target).pipe(socket); });
    const remove = ()=>connections.delete(id); socket.once('close',remove); target.once('close',remove); target.once('error',()=>socket.destroy()); socket.once('error',()=>target.destroy());
  });
  let applying = false;
  function controllerKey(req){invariant(independent&&tokenMatches(req.headers['x-platform-entry-controller-key'],privateEntryKey),'ENTRY_CONTROL_UNAUTHORIZED');}
  function localControl(req,allowedKinds){
    if(controlAdmission.epoch===0){invariant(req.headers['x-platform-entry-control-context']===undefined,'ENTRY_CONTROL_EPOCH_NOT_ADMITTED');return null;}
    controllerKey(req);const context=decodeEntryControlContext(req.headers['x-platform-entry-control-context']);
    invariant(context.epoch===controlAdmission.epoch&&context.operationId===controlAdmission.operationId&&context.executorId===controlAdmission.executorId&&context.kind===controlAdmission.kind&&(context.recoveryId??null)===(controlAdmission.recoveryId??null)&&controlAdmission.leaseExpiresAt>clock()&&allowedKinds.includes(context.kind),'ENTRY_CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');return context;
  }
  async function persistChecked(path,value,check,onApplied){
    const tmp=join(root,'.entry-'+randomUUID());const handle=await open(tmp,'wx',0o600);let applied=false;
    try{await handle.writeFile(canonical(value)+'\n');await handle.sync();check();await rename(tmp,path);applied=true;onApplied();const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}}
    finally{await handle.close();if(!applied)await unlink(tmp).catch(()=>{});}
  }
  async function body(req,maxBytes){let size=0;const chunks=[];let timer;try{await Promise.race([(async()=>{for await(const chunk of req){size+=chunk.length;invariant(size<=maxBytes,'ENTRY_BODY_TOO_LARGE');chunks.push(chunk);}})(),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Object.assign(new Error('Entry body deadline exceeded'),{code:'ENTRY_BODY_TIMEOUT'}));req.destroy();},2000);})]);return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{clearTimeout(timer);}}
  const control = http.createServer(async(req,res)=>{
    if(closing){res.writeHead(503);res.end();return;}
    let ownsApply=false;
    try {
      const writeAuthorized = tokenMatches(req.headers['x-platform-internal-key'],controlKey);
      const readAuthorized = req.method === 'GET' && req.url === '/binding' && tokenMatches(req.headers['x-platform-internal-key'],observerKey);
      invariant(isLoopback(req.socket.remoteAddress) && (writeAuthorized || readAuthorized), 'ENTRY_UNAUTHORIZED');
      if(req.method==='GET'&&req.url==='/metadata'){res.setHeader('content-type','application/json');res.end(JSON.stringify({...actualGateway,observedAt:new Date().toISOString()}));return;}
      if (req.method === 'GET' && req.url === '/binding') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ...binding, inFlight, activeWS:connections.size, httpByDigest:Object.fromEntries(httpByDigest), wsByDigest:[...connections.values()].reduce((a,c)=>{a[c.digest]=(a[c.digest]||0)+1;return a;},{}) })); return; }
      if(req.method==='GET'&&req.url==='/control-epoch'&&independent){res.setHeader('content-type','application/json');res.end(JSON.stringify(controlAdmission));return;}
      invariant(req.method === 'POST' && ['/binding','/fence','/contract-fence',...(independent?['/control-epoch']:[])].includes(req.url) && !applying, 'ENTRY_BUSY_OR_METHOD'); applying = true;ownsApply=true;
      if(req.url==='/control-epoch'){
        controllerKey(req);const next=await body(req,4096),allowed=['instanceId','expectedRevision','epoch','operationId','executorId','kind','leaseExpiresAt','recoveryId'];
        invariant(next&&Object.keys(next).every(key=>allowed.includes(key))&&next.instanceId===instanceId&&next.expectedRevision===controlAdmission.revision&&Number.isSafeInteger(next.epoch)&&next.epoch>0&&next.epoch>=controlAdmission.epoch&&typeof next.operationId==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(next.operationId)&&typeof next.executorId==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(next.executorId)&&['upgrade','recovery','maintenance','contract'].includes(next.kind)&&Number.isSafeInteger(next.leaseExpiresAt)&&next.leaseExpiresAt>clock()&&next.leaseExpiresAt<=clock()+120000&&(next.kind==='recovery'?typeof next.recoveryId==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(next.recoveryId):next.recoveryId===undefined),'ENTRY_CONTROL_CAS_CONFLICT');
        if(next.epoch===controlAdmission.epoch)invariant(next.operationId===controlAdmission.operationId&&next.executorId===controlAdmission.executorId&&next.kind===controlAdmission.kind&&(next.recoveryId??null)===(controlAdmission.recoveryId??null)&&controlAdmission.leaseExpiresAt>clock()&&next.leaseExpiresAt>=controlAdmission.leaseExpiresAt,'ENTRY_CONTROL_STALE_EPOCH');
        const current=controlAdmission,authority=await verifyControlAuthority(next);invariant(authority&&Number.isSafeInteger(authority.leaseExpiresAt)&&next.leaseExpiresAt<=authority.leaseExpiresAt,'ENTRY_CONTROL_LEASE_UNQUALIFIED');
        const persisted={schemaVersion:1,instanceId,revision:current.revision+1,epoch:next.epoch,operationId:next.operationId,executorId:next.executorId,kind:next.kind,leaseExpiresAt:next.leaseExpiresAt,...(next.recoveryId?{recoveryId:next.recoveryId}:{})};
        await persistChecked(controlAdmissionPath,persisted,()=>invariant(controlAdmission===current&&next.leaseExpiresAt>clock(),'ENTRY_CONTROL_CAS_CONFLICT'),()=>{controlAdmission=persisted;});res.setHeader('content-type','application/json');res.end(JSON.stringify(controlAdmission));return;
      }
      if(req.url==='/fence'||req.url==='/contract-fence') {const contract=req.url==='/contract-fence',kinds=[contract?'contract':'upgrade'],context=localControl(req,kinds),next=await body(req,4096),idKey=contract?'contractAttemptId':'attemptId';invariant(Object.keys(next).every(k=>['instanceId',idKey,'fence'].includes(k))&&next.instanceId===instanceId&&typeof next[idKey]==='string'&&Number.isSafeInteger(next.fence)&&next.fence>=admission.fence,'STALE_ENTRY_FENCE');if(context)invariant(context.operationId===next[idKey],'ENTRY_CONTROL_OPERATION_MISMATCH');if(next.fence===admission.fence)invariant(canonical(next)===canonical(admission),'ENTRY_FENCE_CONFLICT');if(context)await verifyControlAuthority({...context,instanceId});if(contract){invariant(typeof verifyContractFence==='function','CONTRACT_FENCE_VERIFIER_REQUIRED');await verifyContractFence(next);}else await verifyFence(next);await persistChecked(fencePath,next,()=>{const current=localControl(req,kinds);invariant(!context||canonical(current)===canonical(context),'ENTRY_CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');},()=>{admission=next;});res.setHeader('content-type','application/json');res.end(JSON.stringify(admission));return;}
      const context=localControl(req,['upgrade','recovery']);const next=validateBinding(independent?persistedEntryBinding(await body(req,65536)):await body(req,65536));
      if(context?.kind==='recovery'){
        invariant(next.instanceId===instanceId&&next.attemptId===binding.attemptId&&next.fence===binding.fence&&next.routeGeneration>=binding.routeGeneration,'ENTRY_RECOVERY_BUSINESS_AUTHORITY_CHANGED');
        if(next.routeGeneration===binding.routeGeneration){invariant(canonical(next)===canonical(binding),'ROUTE_GENERATION_CONFLICT');res.end(JSON.stringify(binding));return;}
        invariant(context.expectedBindingDigest===entryBindingDigest(binding),'ENTRY_CONTROL_BINDING_CHANGED');await verifyControlAuthority({...context,instanceId});
        await persistChecked(configPath,next,()=>{invariant(canonical(localControl(req,['recovery']))===canonical(context)&&context.expectedBindingDigest===entryBindingDigest(binding),'ENTRY_CONTROL_BINDING_CHANGED');},()=>{binding=next;});res.setHeader('content-type','application/json');res.end(JSON.stringify(binding));return;
      }
      invariant(next.instanceId === instanceId && next.fence === admission.fence && next.attemptId === admission.attemptId && next.fence >= binding.fence && next.routeGeneration >= binding.routeGeneration, 'STALE_ENTRY_FENCE');
      if (next.routeGeneration === binding.routeGeneration) { invariant(canonical(next) === canonical(binding),'ROUTE_GENERATION_CONFLICT'); res.end(JSON.stringify(binding)); return; }
      if(context){invariant(context.expectedBindingDigest===entryBindingDigest(binding),'ENTRY_CONTROL_BINDING_CHANGED');await verifyControlAuthority({...context,instanceId});}
      await verifyFence({instanceId,fence:next.fence,attemptId:next.attemptId});
      await persistChecked(configPath,next,()=>{const current=localControl(req,['upgrade']);invariant(!context||canonical(current)===canonical(context)&&context.expectedBindingDigest===entryBindingDigest(binding),'ENTRY_CONTROL_BINDING_CHANGED');},()=>{binding=next;});res.setHeader('content-type','application/json');res.end(JSON.stringify(binding));
    } catch(e) { if(!res.destroyed&&!res.writableEnded){res.writeHead(['ENTRY_UNAUTHORIZED','ENTRY_CONTROL_UNAUTHORIZED'].includes(e.code) ? 403 : 409); res.end(JSON.stringify({code:e.code||'ENTRY_FAILED'}));} } finally { if(ownsApply)applying=false; }
  });
  control.on('connection',trackSocket);
  async function close(){
    if(closingPromise)return closingPromise;closing=true;
    closingPromise=(async()=>{
      // Stop admission before touching this gateway's own transports. Backend
      // servers, RuntimeOwners and jobs are outside this shutdown capability.
      const stopped=[server,control].map(listener=>new Promise((ok,fail)=>listener.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?fail(error):ok())));
      for(const c of connections.values()){c.socket.destroy();c.target.destroy();}
      for(const transfer of httpTransfers){transfer.response?.destroy();transfer.request.destroy();}
      for(const listener of [server,control])listener.closeAllConnections();
      for(const socket of ownedSockets)socket.destroy();
      let timer;try{await Promise.race([Promise.all(stopped),new Promise((_,fail)=>{timer=setTimeout(()=>fail(Object.assign(Error('Owned gateway transports did not close'),{code:'ENTRY_TRANSPORT_CLOSE_UNCONFIRMED'})),5000);})]);}finally{clearTimeout(timer);}
    })();return closingPromise;
  }
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);}); await new Promise((ok,fail)=>{control.once('error',fail);control.listen(controlPort,'127.0.0.1',ok);});
  return { server,control, origin:`http://${host}:${server.address().port}`,controlOrigin:`http://127.0.0.1:${control.address().port}`,observe:()=>({...binding,inFlight,activeWS:connections.size,httpByDigest:Object.fromEntries(httpByDigest),wsByDigest:[...connections.values()].reduce((a,c)=>{a[c.digest]=(a[c.digest]||0)+1;return a;},{})}),close };
}
