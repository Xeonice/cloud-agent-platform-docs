import { spawn } from 'node:child_process';
const host='unix:///run/qualification-docker/docker.sock';
const run=args=>new Promise((ok,fail)=>{const child=spawn('docker',['--host',host,...args],{shell:false,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',c=>out+=c);child.stderr.resume();child.once('error',fail);child.once('close',code=>code===0?ok(out):fail(Error('Qualification daemon unavailable')));});
if(process.platform!=='linux'||process.arch!=='arm64')throw Error('Dedicated qualification architecture required');
const ids=(await run(['ps','-q','--filter','label=agent-platform.role=owner'])).trim().split('\n').filter(Boolean);
if(ids.length)throw Error('Retained qualification Owners require explicit resource cleanup before a new workspace may be deleted');
process.stdout.write('Dedicated qualification workspace has no live retained Owner\n');
