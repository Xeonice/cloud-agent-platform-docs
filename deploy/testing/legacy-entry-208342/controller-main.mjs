import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, secureDirectory } from './io.mjs';
import { invariant } from './trust.mjs';
import { createCoordinatorClient } from './coordinator-client.mjs';
import { createNativeExecutor } from './native-executor.mjs';
import { createInstallerIdentityServer } from './installer-identity.mjs';
import { createInstanceController } from './instance-controller.mjs';
export async function startController(configPath,{signal,onEvent}={}) {
  const c=await readJson(configPath);invariant(c.instanceId&&c.controllerId&&c.trustRootPath&&c.root,'INSTALLATION_CONFIG_REQUIRED');await secureDirectory(c.root);
  const metadata=await createInstallerIdentityServer({instanceId:c.instanceId,startIdentity:c.startIdentity||c.controllerId,key:c.controllerKey,port:c.controllerMetadataPort||0});
  if(c.handoffMode){invariant(metadata.identity.artifactDigest===c.expectedInstallerDigest&&metadata.identity.inputFingerprint===c.expectedInstallerInputFingerprint,'CONTROLLER_ACTUAL_CODE_MISMATCH');while(!signal?.aborted){const authority=await readJson(c.authorityPath,null);if(authority?.instanceId===c.instanceId&&authority.startIdentity===c.startIdentity&&authority.artifactDigest===metadata.identity.artifactDigest)break;await new Promise(ok=>setTimeout(ok,100));}}
  const coordinator=createCoordinatorClient({origin:c.coordinatorOrigin,instanceId:c.instanceId,key:c.controllerKey,bindingPath:c.coordinatorBindingPath});
  const executor=createNativeExecutor({...c,coordinator});const controller=createInstanceController({...c,coordinator,executor,signal,onEvent});try{await controller.run();return controller;}finally{await metadata.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());startController(process.argv[2],{signal:stop.signal,onEvent:e=>process.stdout.write(JSON.stringify(e)+'\n')}).catch(e=>{process.stderr.write((e.code||'CONTROLLER_FAILED')+'\n');process.exitCode=1;});}
