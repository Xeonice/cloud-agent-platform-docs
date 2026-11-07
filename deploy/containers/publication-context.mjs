import { userInfo } from 'node:os';
import { join,resolve } from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { command } from '../upgrade/artifacts.mjs';
import { invariant } from '../upgrade/trust.mjs';
export const PUBLICATION_PROFILE='agent-platform-publication';
export const PUBLICATION_DOCKER_CONTEXT='colima-'+PUBLICATION_PROFILE;
export async function verifyPublicationContext({run=command,homedir=userInfo().homedir}={}) {
  const contexts=JSON.parse(await run('docker',['context','inspect',PUBLICATION_DOCKER_CONTEXT]));
  const expected=join(homedir,'.colima',PUBLICATION_PROFILE,'docker.sock');
  invariant(contexts.length===1&&contexts[0].Name===PUBLICATION_DOCKER_CONTEXT&&contexts[0].Endpoints?.docker?.Host==='unix://'+expected,'NOT_ISOLATED_PUBLICATION_VM');
  const sock=await fs.lstat(expected);invariant(sock.isSocket()&&!sock.isSymbolicLink()&&await fs.realpath(expected)===expected,'PUBLICATION_SOCKET_IDENTITY_INVALID');return {context:PUBLICATION_DOCKER_CONTEXT,profile:PUBLICATION_PROFILE,endpoint:expected};
}
export async function launchPublication(composePath,{run=command}={}) {await verifyPublicationContext({run});return run('docker',['--context',PUBLICATION_DOCKER_CONTEXT,'compose','-f',resolve(composePath),'up','-d']);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)launchPublication(process.argv[2]).then(()=>process.stdout.write('Isolated publication profile started\n'),e=>{process.stderr.write((e.code||'PUBLICATION_PROFILE_REJECTED')+'\n');process.exitCode=1;});
