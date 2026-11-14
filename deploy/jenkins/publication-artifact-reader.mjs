import http from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invariant } from '../upgrade/trust.mjs';
import { readJson } from '../upgrade/io.mjs';
const JOBS=new Set(['agent-platform-api','agent-platform-web','agent-platform-contract','agent-platform-instance-package','agent-platform-upgrade-evidence']);
const same=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function fixedArtifactPath(value) {
  invariant(typeof value==='string'&&value.length<=2048&&!/%|\\|[\u0000-\u0020]/.test(value),'INVALID_EVIDENCE_PATH');
  const match=/^\/job\/([a-z-]+)\/([1-9][0-9]{0,8})\/(api\/json\?tree=[A-Za-z0-9_,[\]]+|artifact\/[A-Za-z0-9_./-]+)$/.exec(value);
  invariant(match&&JOBS.has(match[1])&&!match[3].includes('..')&&!match[3].includes('//'),'INVALID_EVIDENCE_PATH');return value;
}
export async function createPublicationArtifactReader({jenkinsOrigin,username,token,readerKey,host='0.0.0.0',port=8020,fetcher=fetch}) {
  const base=new URL(jenkinsOrigin);invariant(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&base.pathname==='/'&&!base.search&&!base.hash&&username&&token&&readerKey?.length>=32,'READER_INSTALLATION_REQUIRED');
  const authorization='Basic '+Buffer.from(username+':'+token).toString('base64');
  const server=http.createServer(async(req,res)=>{try{
    invariant(req.method==='GET'&&same(req.headers['x-publication-reader-key'],readerKey),'READER_FORBIDDEN');const path=fixedArtifactPath(req.url);
    const upstream=await fetcher(base.origin+path,{method:'GET',headers:{authorization},redirect:'error',signal:AbortSignal.timeout(/\.(?:tar\.gz|tgz)$/.test(path)?1_200_000:20_000)});
    invariant(upstream.status===200||upstream.status===404,'EVIDENCE_UPSTREAM_FAILED');const bytes=Number(upstream.headers.get('content-length')||0);invariant(bytes<=1_999_999_999,'EVIDENCE_TOO_LARGE');
    res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/octet-stream','cache-control':'no-store',...(bytes?{'content-length':bytes}:{})});
    if(upstream.body)Readable.fromWeb(upstream.body).pipe(res);else res.end();
  }catch(e){if(!res.headersSent)res.writeHead(e.code==='READER_FORBIDDEN'?403:400,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code||'EVIDENCE_READER_FAILED'}));}});
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);});return {server,origin:`http://${host}:${server.address().port}`,close:()=>new Promise(ok=>server.close(ok))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)readJson(process.argv[2]).then(createPublicationArtifactReader).catch(e=>{process.stderr.write((e.code||'EVIDENCE_READER_FAILED')+'\n');process.exitCode=1;});
