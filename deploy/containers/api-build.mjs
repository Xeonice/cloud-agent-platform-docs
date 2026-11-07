import { createDeployer,trusted } from './api-container.mjs';
import { command } from '../upgrade/artifacts.mjs';
import { invariant } from '../upgrade/trust.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export async function buildOnly(action,...args) {
  invariant(['head','build'].includes(action),'BUILD_WORKER_HAS_NO_INSTANCE_COMMAND');await trusted();
  const run=async(program,parameters,options)=>{
    if(program==='/usr/local/bin/docker') {
      invariant(parameters[0]==='--host'&&parameters[1]==='unix:///var/run/docker.sock','INVALID_BUILD_DOCKER_REQUEST');
      const operation=parameters[2];invariant(['build','buildx','run','image','save','version','info','inspect'].includes(operation),'NON_BUILD_DOCKER_OPERATION');
      return command(program,['--host','unix:///run/build-docker/docker.sock',...parameters.slice(2)],options);
    }
    invariant(['git','/usr/bin/git','tar','/usr/bin/tar'].includes(program),'NON_BUILD_PROGRAM');return command(program,parameters,options);
  };
  const builder=createDeployer({run});return action==='head'?builder.heads():builder.build(...args);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)buildOnly(...process.argv.slice(2)).then(r=>process.stdout.write(JSON.stringify(r)+'\n'),e=>{process.stderr.write((e.code||'BUILD_FAILED')+'\n');process.exitCode=1;});
