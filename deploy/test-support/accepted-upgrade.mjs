import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical, digest } from '../upgrade/trust.mjs';
const require=createRequire(new URL('../../api/package.json',import.meta.url));
const { createUpgradeControlStores, freezeUpgradePlan }=require('./apps/api/dist/platform/upgrade/control-store-factory.js');

/** Actual independent UpgradeStore acceptance and terminal receipt. Package
 * bytes/processes are not created by this protocol fixture. */
export function createAcceptedUpgrade(sqlite,{instanceId='retirement-test',attemptId='22222222-2222-4222-8222-222222222222',clock=Date.now,fail=true}={}) {
  const artifact=name=>({artifactDigest:digest(name),inputFingerprint:digest('input-'+name),sourceRevision:'a'.repeat(40),protocol:{min:1,max:2}});
  const source={releaseId:'v1.0.0',activationGeneration:1,activatedAt:new Date(clock()-10000).toISOString(),schema:29,channel:'retirement-fixture',
    components:{api:artifact('old-api'),coordinator:artifact('old-coordinator'),owner:artifact('old-owner'),installer:artifact('installer'),web:{...artifact('web'),webRevision:'c'.repeat(40)}},
    commits:{project:'a'.repeat(40),api:'b'.repeat(40),web:'c'.repeat(40)},productionWebBinding:'http://127.0.0.1:39999'};
  const manifest={schemaVersion:2,releaseId:'v1.0.1',channel:source.channel,publishedAt:new Date(clock()).toISOString(),commits:source.commits,
    components:{...source.components,api:artifact('new-api'),coordinator:artifact('new-coordinator')},
    packages:[{platform:process.platform,arch:process.arch,name:'retirement-boundary.tgz',url:'https://distribution.invalid/retirement-boundary.tgz',digest:digest('archive'),bytes:1000,format:'native-tar'}],
    upgradePaths:[{fromRelease:source.releaseId,minSchema:29,maxSchema:29,targetSchema:29,bridgeReleases:[],migrationPlanDigest:null}],
    policy:{id:'fixture-only',weights:[1,5,25,100],stageDurationMs:60000,minRequests:100,observationFreshnessMs:5000,probeHz:10,requestDeadlineMs:2000,attachDeadlineMs:5000,
      softErrorDelta:0.01,p95Ratio:2,p95FloorMs:1000,evaluationIntervalMs:10000,consecutiveEvaluations:2,retentionMs:60000,migrationBatchMs:500,maxWalBytes:1048576,minFreeBytes:1048576,
      fallbacks:[{releaseId:source.releaseId,apiDigest:source.components.api.artifactDigest,webDigest:source.components.web.artifactDigest,rehearsed:true}],stopUserResources:false,restoreLiveVolume:false,contractInUpgrade:false},
    evidence:['build','contracts','four-combinations','native-continuity','fault-recovery'].map(kind=>({kind,result:'passed',inputFingerprint:digest('fixture-only'),reportDigest:digest(kind),runId:'protocol-fixture-only',recordedAt:new Date(clock()).toISOString()}))};
  const keys=generateKeyPairSync('ed25519'),envelope={manifest,manifestDigest:digest(manifest),signature:{algorithm:'Ed25519',keyId:'fixture-only',value:sign(null,Buffer.from(canonical(manifest)),keys.privateKey).toString('base64')}};
  const roots={schemaVersion:1,channel:source.channel,keys:[{id:'fixture-only',publicKey:keys.publicKey.export({format:'pem',type:'spki'})}],distributionOrigins:['https://distribution.invalid']};
  const current={instanceId,releaseId:source.releaseId,schema:29,channel:source.channel,platform:process.platform,arch:process.arch,
    protocols:Object.fromEntries(Object.entries(source.components).map(([k,v])=>[k,v.protocol])),bridges:[]};
  const stores=createUpgradeControlStores({sqlite,instanceId,clock:{now:()=>new Date(clock())},ids:{next:()=>attemptId},claimGuard:()=>null,dataFormatGuard:()=>{}});
  stores.store.bootstrap(source);
  const plan=freezeUpgradePlan(envelope,source);
  stores.store.accept('fixture-admin',{requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',targetReleaseId:manifest.releaseId,targetDigest:envelope.manifestDigest,expectedActivationGeneration:1},envelope,plan);
  const claim=stores.store.claim(attemptId,'original-upgrade',500,0),snapshot=stores.store.snapshot(attemptId);
  if(fail)stores.store.commitReceipt(attemptId,{fence:claim.fence,generation:snapshot.attempt.generation,expectedSequence:snapshot.attempt.sequence,eventId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',kind:'failed',payload:{reason:'Protocol qualification fixture failure'}});
  return {stores,plan,source,manifest,envelope,roots,current,attemptId};
}
