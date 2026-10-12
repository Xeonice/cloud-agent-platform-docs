import http from 'node:http';
import net from 'node:net';
import { createHmac, timingSafeEqual,randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { atomicJson, readJson, inside, secureDirectory } from './io.mjs';
import { invariant, DIGEST, canonical } from './trust.mjs';
import { actualInstallerIdentity } from './installer-identity.mjs';
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
export async function createStableEntry({ root, instanceId, controlKey, stickyKey, verifyFence, verifyContractFence, initialBinding, host = '127.0.0.1', port = 0, controlPort = 0 }) {
  invariant(typeof verifyFence === 'function' && controlKey?.length >= 32 && stickyKey?.length >= 32, 'ENTRY_AUTH_REQUIRED');
  root = await secureDirectory(root); const configPath = join(root,'entry-binding.json'); let binding = await readJson(configPath, null);
  if (!binding) { binding = validateBinding(initialBinding); invariant(binding.instanceId === instanceId, 'WRONG_INSTANCE'); await atomicJson(configPath, binding); }
  validateBinding(binding); invariant(binding.instanceId === instanceId, 'WRONG_INSTANCE');
  const fencePath=join(root,'entry-fence.json');let admission=await readJson(fencePath,{instanceId,attemptId:binding.attemptId,fence:binding.fence});invariant(admission.instanceId===instanceId&&Number.isSafeInteger(admission.fence)&&admission.fence>=binding.fence,'INVALID_ENTRY_ADMISSION');await atomicJson(fencePath,admission);
  const actualGateway={...await actualInstallerIdentity({instanceId,startIdentity:randomUUID()}),role:'gateway',independentFoundation:true,preservesExistingSockets:true};
  const connections = new Map(), httpByDigest = new Map(); let inFlight = 0;
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
      const u = new URL(web.origin); const proxy = http.request({ hostname:u.hostname, port:u.port, method:req.method, path:req.url, headers:req.headers }, upstream => { res.writeHead(upstream.statusCode,{...upstream.headers,'x-platform-web-digest':web.digest}); upstream.pipe(res); }); proxy.once('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(proxy);return;
    }
    const bytes = await readFile(file); const extension = file.split('.').at(-1); const types = { html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',svg:'image/svg+xml',woff2:'font/woff2' };
    res.writeHead(200,{ 'content-type': types[extension] || 'application/octet-stream', 'cache-control': requestPath.startsWith('/_next/') || match ? 'public, max-age=31536000, immutable' : 'no-store', 'x-platform-web-digest': web.digest }); res.end(bytes);
  }
  const server = http.createServer((req,res) => {
    const pathname=new URL(req.url,'http://localhost').pathname;
    const controlPath=['/api','/mcp','/ws','/socket.io'].some(prefix=>pathname===prefix||pathname.startsWith(prefix+'/'));
    if (!controlPath) { staticWeb(req,res).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); }); return; }
    const selected = backend(req), u = new URL(selected.origin); inFlight++; httpByDigest.set(selected.digest,(httpByDigest.get(selected.digest)||0)+1);
    const proxy = http.request({ hostname:u.hostname, port:u.port, method:req.method, path:req.url, headers:{ ...req.headers, 'x-forwarded-host':req.headers.host, 'x-forwarded-proto':'http', 'x-platform-route-generation':String(binding.routeGeneration) } }, upstream => { res.writeHead(upstream.statusCode,upstream.headers); upstream.pipe(res); });
    res.once('close',()=>{ inFlight--; httpByDigest.set(selected.digest,Math.max(0,(httpByDigest.get(selected.digest)||1)-1)); }); proxy.once('error',()=>{ if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  server.on('upgrade',(req,socket,head)=>{
    const selected = backend(req), u = new URL(selected.origin); const target = net.connect({host:u.hostname,port:Number(u.port)}); const id = Symbol(); connections.set(id,{target,socket,digest:selected.digest,openedAt:Date.now()});
    target.once('connect',()=>{ let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`; for (let i=0;i<req.rawHeaders.length;i+=2) headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`; target.write(headers+'\r\n'); if(head.length) target.write(head); socket.pipe(target).pipe(socket); });
    const remove = ()=>connections.delete(id); socket.once('close',remove); target.once('close',remove); target.once('error',()=>socket.destroy()); socket.once('error',()=>target.destroy());
  });
  let applying = false;
  const control = http.createServer(async(req,res)=>{
    let ownsApply=false;
    try {
      invariant(isLoopback(req.socket.remoteAddress) && tokenMatches(req.headers['x-platform-internal-key'],controlKey), 'ENTRY_UNAUTHORIZED');
      if(req.method==='GET'&&req.url==='/metadata'){res.setHeader('content-type','application/json');res.end(JSON.stringify({...actualGateway,observedAt:new Date().toISOString()}));return;}
      if (req.method === 'GET' && req.url === '/binding') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ...binding, inFlight, activeWS:connections.size, httpByDigest:Object.fromEntries(httpByDigest), wsByDigest:[...connections.values()].reduce((a,c)=>{a[c.digest]=(a[c.digest]||0)+1;return a;},{}) })); return; }
      invariant(req.method === 'POST' && ['/binding','/fence','/contract-fence'].includes(req.url) && !applying, 'ENTRY_BUSY_OR_METHOD'); applying = true;ownsApply=true;
      if(req.url==='/fence'||req.url==='/contract-fence') {let text='';for await(const c of req){text+=c;invariant(text.length<=4096,'FENCE_TOO_LARGE');}const next=JSON.parse(text),contract=req.url==='/contract-fence',idKey=contract?'contractAttemptId':'attemptId';invariant(Object.keys(next).every(k=>['instanceId',idKey,'fence'].includes(k))&&next.instanceId===instanceId&&typeof next[idKey]==='string'&&Number.isSafeInteger(next.fence)&&next.fence>=admission.fence,'STALE_ENTRY_FENCE');if(next.fence===admission.fence)invariant(canonical(next)===canonical(admission),'ENTRY_FENCE_CONFLICT');if(contract){invariant(typeof verifyContractFence==='function','CONTRACT_FENCE_VERIFIER_REQUIRED');await verifyContractFence(next);}else await verifyFence(next);await atomicJson(fencePath,next);admission=next;res.setHeader('content-type','application/json');res.end(JSON.stringify(admission));return;}
      let text=''; for await (const c of req) { text += c; invariant(text.length <= 65536,'BINDING_TOO_LARGE'); } const next = validateBinding(JSON.parse(text));
      invariant(next.instanceId === instanceId && next.fence === admission.fence && next.attemptId === admission.attemptId && next.fence >= binding.fence && next.routeGeneration >= binding.routeGeneration, 'STALE_ENTRY_FENCE');
      if (next.routeGeneration === binding.routeGeneration) { invariant(canonical(next) === canonical(binding),'ROUTE_GENERATION_CONFLICT'); res.end(JSON.stringify(binding)); return; }
      await verifyFence({instanceId,fence:next.fence,attemptId:next.attemptId});
      await atomicJson(configPath,next); binding=next; res.setHeader('content-type','application/json'); res.end(JSON.stringify(binding));
    } catch(e) { res.writeHead(e.code === 'ENTRY_UNAUTHORIZED' ? 403 : 409); res.end(JSON.stringify({code:e.code||'ENTRY_FAILED'})); } finally { if(ownsApply)applying=false; }
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);}); await new Promise((ok,fail)=>{control.once('error',fail);control.listen(controlPort,'127.0.0.1',ok);});
  return { server,control, origin:`http://${host}:${server.address().port}`,controlOrigin:`http://127.0.0.1:${control.address().port}`,observe:()=>({...binding,inFlight,activeWS:connections.size,httpByDigest:Object.fromEntries(httpByDigest),wsByDigest:[...connections.values()].reduce((a,c)=>{a[c.digest]=(a[c.digest]||0)+1;return a;},{})}),close:async()=>{for(const c of connections.values()){c.socket.destroy();c.target.destroy();}await Promise.all([new Promise(ok=>server.close(ok)),new Promise(ok=>control.close(ok))]);} };
}
