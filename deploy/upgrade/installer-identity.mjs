import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeManifest } from './io.mjs';
import { invariant,digest } from './trust.mjs';
export async function actualInstallerIdentity({instanceId,startIdentity,root=dirname(fileURLToPath(import.meta.url))}) {
  const files=(await treeManifest(root)).filter(f=>f.path.endsWith('.mjs')&&!f.path.endsWith('.test.mjs')).map(f=>({...f,path:'installer/'+f.path}));
  invariant(files.some(f=>f.path==='installer/controller-main.mjs'),'INSTALLER_CODE_MISSING');
  const fingerprint=digest(files);return {instanceId,role:'installer',pid:process.pid,programRoot:root,artifactDigest:fingerprint,inputFingerprint:fingerprint,startIdentity,protocol:{min:1,max:2},loadedAt:new Date().toISOString()};
}
export async function createInstallerIdentityServer({instanceId,startIdentity,key,port=0}) {
  invariant(key?.length>=32,'INSTALLER_METADATA_KEY_REQUIRED');const identity=await actualInstallerIdentity({instanceId,startIdentity});
  const server=http.createServer((req,res)=>{const supplied=req.headers['x-platform-internal-key'];if(req.method!=='GET'||req.url!=='/metadata'||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(key)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(key))){res.writeHead(403);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({...identity,readyForHandoff:true,observedAt:new Date().toISOString()}));});
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});return {identity,origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(ok=>server.close(ok))};
}
