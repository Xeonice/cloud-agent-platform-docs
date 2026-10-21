pipeline {
  agent { label 'agent-platform-linux-deploy' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 3, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '14', numToKeepStr: '5000', artifactNumToKeepStr: '5000'))
  }
  triggers { cron('H/5 * * * *') }
  environment { NODE22 = '/usr/local/bin/node' }
  stages {
    stage('Observe public StableEntry without instance authority') {
      steps {
        script {
          def code = sh(script: '''"$NODE22" --input-type=module <<'NODE'
// Public HTTP observations only. No deployment/runtime credentials are read.
import * as fs from 'node:fs/promises';
const build=process.env.BUILD_NUMBER;
if(!/^[1-9]\\d*$/.test(build||''))throw Error('Fixed Jenkins build number required');
const directory='runtime-report-'+build;
await fs.mkdir(directory,{mode:0o700});
async function probe(path,kind){
 const url='https://agent-api.douglasdong.com'+path;
 try{
  const r=await fetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'user-agent':'AgentPlatform-Readonly-Service-Monitor/1.0'}});
  const contentType=r.headers.get('content-type')||'';
  if(kind==='html'){await r.body?.cancel();return{path,status:r.status,healthy:r.status===200&&contentType.includes('text/html'),kind};}
  if(r.status!==200||!contentType.includes('application/json')){await r.body?.cancel();return{path,status:r.status,healthy:false,kind,reason:'HTTP_OR_JSON_CONTENT_TYPE'};}
  const reader=r.body.getReader();let size=0,parts=[];
  try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768)throw Error('BODY_TOO_LARGE');parts.push(Buffer.from(value));}}finally{await reader.cancel();}
  const body=JSON.parse(Buffer.concat(parts).toString());
  if(kind==='health'){const value=body.data?.status??body.status;return{path,status:r.status,healthy:value==='ok',kind,healthStatus:value==='ok'?'ok':null};}
  const revision=body.webRevision;
  return{path,status:r.status,healthy:typeof revision==='string'&&/^[a-f0-9]{40}$/.test(revision),kind,webRevision:typeof revision==='string'&&/^[a-f0-9]{40}$/.test(revision)?revision:null};
 }catch{return{path,kind,healthy:false,reason:'PUBLIC_PROBE_FAILED'};}
}
const checks=await Promise.all([probe('/api/health','health'),probe('/web-build','web-build'),probe('/','html')]);
const report={schemaVersion:1,capturedAt:new Date().toISOString(),healthy:checks.every(x=>x.healthy),origin:'https://agent-api.douglasdong.com',scope:'public-http-only',checks,credentialsRead:false,containerLifecycle:false,instanceDeployment:false};
await fs.writeFile(directory+'/report.json',JSON.stringify(report,null,2)+'\\n',{mode:0o600,flag:'wx'});
const escaped=JSON.stringify(report,null,2).replace(/[&<>]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[x]));
await fs.writeFile(directory+'/report.html','<!doctype html><meta charset="utf-8"><title>Service status</title><h1>'+ (report.healthy?'Healthy':'Unhealthy')+'</h1><pre>'+escaped+'</pre>\\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify(report));
if(!report.healthy)process.exitCode=2;
NODE
''', returnStatus: true)
          if (code == 2) { unstable('Public service probe reports an unhealthy endpoint') }
          if (code != 0 && code != 2) { error('Public probe collection failed') }
          currentBuild.description = "Public StableEntry · ${code == 0 ? 'healthy' : 'unhealthy'}"
        }
      }
    }
  }
  post {
    always {
      script {
        def folder = "runtime-report-${env.BUILD_NUMBER}"
        archiveArtifacts artifacts: "${folder}/report.json,${folder}/report.html", allowEmptyArchive: true, fingerprint: true, followSymlinks: false
        publishHTML(target: [allowMissing: true, alwaysLinkToLastBuild: true, keepAll: true, reportDir: folder, reportFiles: 'report.html', reportName: 'Service status'])
      }
    }
  }
}
