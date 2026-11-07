import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareWebRuntimeDirectories} from '../jenkins/instance-package.mjs';
import {createCandidateSupervisor} from '../upgrade/candidate-supervisor.mjs';
import {roleMounts} from '../upgrade/production-role-adapter.mjs';
import {command} from '../upgrade/artifacts.mjs';
import {treeManifest,atomicJson} from '../upgrade/io.mjs';
import {digest} from '../upgrade/trust.mjs';

async function folder(t) {
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'upgrade-web-cache-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
test('native tar preserves the writable Web cache through an older Supervisor copy without changing reused file identity',async t=>{
  const root=await folder(t),built=join(root,'built');
  await fs.mkdir(join(built,'web'),{recursive:true});
  await fs.writeFile(join(built,'web/server.js'),'export const web=true');
  const immutable=await treeManifest(built);
  await prepareWebRuntimeDirectories(built);
  assert.deepEqual(await treeManifest(built),immutable);
  const archive=join(root,'instance.tgz'),unpacked=join(root,'unpacked');await fs.mkdir(unpacked);
  await command('tar',['-czf',archive,'-C',built,'.']);
  await command('tar',['-xzf',archive,'-C',unpacked]);
  const copy=join(root,'process-code/web');
  // This is the installed legacy Supervisor's recursive copy, with no mkdir.
  await fs.cp(join(unpacked,'web'),copy,{recursive:true,dereference:false,verbatimSymlinks:true});
  const mounts=roleMounts({root},{kind:'web',cwd:copy,artifactRoot:unpacked,env:{}});
  const cache=mounts.find(x=>x.destination===join(copy,'.next/cache'));
  assert.equal(cache.rw,true);assert.equal((await fs.lstat(cache.source)).isDirectory(),true);
  assert.deepEqual(await treeManifest(unpacked),immutable);
  await fs.rm(join(built,'web/.next/cache'),{recursive:true});
  await fs.symlink(join(root,'outside-cache'),join(built,'web/.next/cache'));
  await assert.rejects(prepareWebRuntimeDirectories(built));
});

test('current Supervisor starts an older immutable Web artifact without a cache and gives its adapter an existing writable mount',async t=>{
  const root=await folder(t),pkg='sha256:'+'a'.repeat(64),id='66666666-6666-4666-8666-666666666666',artifact=join(root,'artifacts',pkg.slice(7));
  await fs.mkdir(join(artifact,'web'),{recursive:true});await fs.writeFile(join(artifact,'web/server.js'),'export const web=true');
  const files=await treeManifest(artifact),part={artifactDigest:digest(files),inputFingerprint:pkg,sourceRevision:'a'.repeat(40),protocol:{min:1,max:1}},components={web:part};
  await atomicJson(join(artifact,'upgrade-artifact.json'),{components,files,treeDigest:digest(files)});
  await atomicJson(join(artifact,'installed.json'),{packageDigest:pkg,components});
  const reservation=net.createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const webPort=reservation.address().port;await new Promise(ok=>reservation.close(ok));
  let launches=0;
  const launchAdapter={launch:async spec=>{launches++;const cache=roleMounts({root},spec).find(x=>x.destination===join(spec.cwd,'.next/cache'));assert.equal(cache.rw,true);assert.equal((await fs.lstat(cache.source)).isDirectory(),true);assert.deepEqual((await treeManifest(artifact)).filter(x=>!['installed.json','upgrade-artifact.json'].includes(x.path)),files);return {containerId:'b'.repeat(64),pid:1};}};
  const coordinator={assertFence:async()=>{},snapshot:async()=>({attempt:{instanceId:'cache-test',actorId:'administrator',requestId:'explicit-intent'},plan:{package:{digest:pkg},steps:[{kind:'web'}]},manifest:{components}})};
  const supervisor=await createCandidateSupervisor({root,instanceId:'cache-test',key:'s'.repeat(32),coordinator,controlEnv:{PLATFORM_CONTROL_RPC_KEY:'c'.repeat(32)},webPort,launchAdapter});t.after(()=>supervisor.close());
  const record=await supervisor.start(id,1,'web');assert.equal(record.state,'started');assert.equal(launches,1);
});
