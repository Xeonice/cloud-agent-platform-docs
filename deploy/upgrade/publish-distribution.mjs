import * as fs from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest, digest, invariant,verifySignedManifest,loadTrustRoot } from './trust.mjs';
import { readJson, fileDigest, atomicJson,secureDirectory } from './io.mjs';
import { unpackVerified } from './artifacts.mjs';
export async function publishDistribution({root,repository='Xeonice/cloud-agent-platform-docs',token,trustRootPath='/run/agent-platform/jenkins-tools/release-trust-root.json',reuseCacheRoot='/srv/agent-platform/component-reuse',fetcher=fetch}) {
  invariant(repository==='Xeonice/cloud-agent-platform-docs'&&token?.length>0,'PUBLISHER_CREDENTIAL_REQUIRED');
  const roots=await loadTrustRoot(trustRootPath);invariant((roots.purpose||'release')==='release','PRODUCTION_PUBLICATION_TRUST_REQUIRED');
  const catalog=await readJson(join(root,'catalog.json'));invariant(catalog.schemaVersion===1&&catalog.releases?.length,'VERIFIED_CATALOG_REQUIRED');
  const files=new Set(['catalog.json']);let releaseId,projectRevision;
  for(const r of catalog.releases){const envelope=r.envelope;verifySignedManifest(envelope,roots);invariant(r.manifestDigest===envelope.manifestDigest&&digest(envelope.manifest)===envelope.manifestDigest,'SIGNED_DISTRIBUTION_CHANGED');
    releaseId ||= r.releaseId;projectRevision ||= envelope.manifest.commits.project;invariant(r.releaseId===releaseId&&envelope.manifest.commits.project===projectRevision,'MIXED_DISTRIBUTION_RELEASE');
    for(const p of envelope.manifest.packages){invariant(basename(p.name)===p.name,'INVALID_ASSET_NAME');const actual=await fileDigest(join(root,p.name));invariant(actual.digest===p.digest&&actual.bytes===p.bytes,'PUBLISHED_PACKAGE_CHANGED');files.add(p.name);}
  }
  async function api(path,{method='GET',body,raw,headers={}}={}){const r=await fetcher(path.startsWith('https://')?path:'https://api.github.com/repos/'+repository+'/'+path,{method,headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,'x-github-api-version':'2022-11-28',...headers},body:raw||body&&JSON.stringify(body),signal:AbortSignal.timeout(120_000),redirect:'error'});if(r.status===404)return null;invariant(r.ok,'DISTRIBUTION_PUBLISH_FAILED');return r.status===204?{}:r.json();}
  let release=await api('releases/tags/'+encodeURIComponent(releaseId));
  if(!release)release=await api('releases',{method:'POST',body:{tag_name:releaseId,target_commitish:projectRevision,name:releaseId,draft:true,prerelease:releaseId.includes('-'),body:'Immutable signed instance installation artifacts. Publication does not upgrade any instance.'}});
  invariant(release.tag_name===releaseId&&release.target_commitish===projectRevision,'REMOTE_RELEASE_IDENTITY_CONFLICT');
  const existing=await api('releases/'+release.id+'/assets?per_page=100');const local={};
  for(const name of files){const actual=await fileDigest(join(root,name));local[name]=actual;const prior=existing.find(a=>a.name===name);if(prior){invariant(prior.size===actual.bytes&&prior.digest===actual.digest,'IMMUTABLE_REMOTE_ASSET_CONFLICT');continue;}
    invariant(release.draft===true,'PUBLISHED_RELEASE_IS_IMMUTABLE');const uploaded=await api(release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(name),{method:'POST',raw:await fs.readFile(join(root,name)),headers:{'content-type':'application/octet-stream'}});invariant(uploaded.size===actual.bytes&&uploaded.digest===actual.digest,'REMOTE_ASSET_DIGEST_UNCONFIRMED');
  }
  if(release.draft)release=await api('releases/'+release.id,{method:'PATCH',body:{draft:false}});
  invariant(release.draft===false,'DISTRIBUTION_PUBLICATION_UNCONFIRMED');const proof={state:'published',releaseId,releaseIdRemote:release.id,publishedAt:release.published_at,assets:local,instanceDeployment:false};await atomicJson(join(root,'distribution-published.json'),proof);
  for(const record of catalog.releases){const envelope=record.envelope;for(const pkg of envelope.manifest.packages){const cache=await secureDirectory(join(reuseCacheRoot,pkg.platform+'-'+pkg.arch));const installed=await unpackVerified(join(root,pkg.name),pkg,cache,envelope.manifest.components);const manifestPath=join(cache,envelope.manifestDigest.slice(7)+'.json');await atomicJson(manifestPath,envelope);await atomicJson(join(cache,'current.json'),{root:installed.root,manifestPath,trustRootPath});}}
  return proof;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)publishDistribution({root:resolve(process.argv[2]),token:process.env.GITHUB_TOKEN}).then(r=>process.stdout.write(JSON.stringify(r)+'\n'),e=>{process.stderr.write((e.code||'DISTRIBUTION_PUBLISH_FAILED')+'\n');process.exitCode=1;});
