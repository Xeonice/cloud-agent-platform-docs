import { createHash, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { permitsImageRuntimeVersionsPath } from './additive-migration-recipe.mjs';

export const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const RELEASE = /^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;
export function invariant(condition, code, detail = code) { if (!condition) throw Object.assign(new Error(detail), { code }); }
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'NON_FINITE'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  invariant(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_JSON');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export const digest = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const positive = n => Number.isSafeInteger(n) && n > 0;
const range = p => p && positive(p.min) && positive(p.max) && p.min <= p.max;
export function validateContractPlan(p) {
  const keys=['schemaVersion','kind','planDigest','expandPlanDigest','targetTable','nameColumn','artifactInputFingerprint','rollbackWindowMs','maxValidationRows','maxBatchRows','batchBudgetMs','minFreeBytes','maxWalBytes','preserveUserResources','rollbackToLegacy'];
  invariant(p&&Object.keys(p).length===keys.length&&Object.keys(p).every(k=>keys.includes(k))&&p.schemaVersion===1&&p.kind==='project-name-contract'&&DIGEST.test(p.planDigest)&&DIGEST.test(p.expandPlanDigest)&&DIGEST.test(p.artifactInputFingerprint)&&/^upg_shadow_[a-z0-9_]{1,64}$/.test(p.targetTable)&&/^[a-z][a-z0-9_]{0,80}$/.test(p.nameColumn)&&positive(p.rollbackWindowMs)&&p.rollbackWindowMs>=60000&&positive(p.maxValidationRows)&&p.maxValidationRows<=10000&&positive(p.maxBatchRows)&&p.maxBatchRows<=1000&&positive(p.batchBudgetMs)&&p.batchBudgetMs<=1000&&positive(p.minFreeBytes)&&positive(p.maxWalBytes)&&p.preserveUserResources===true&&p.rollbackToLegacy===false,'INVALID_CONTRACT_PLAN');
  const {planDigest,...facts}=p;invariant(digest(facts)===planDigest,'CONTRACT_PLAN_DIGEST_INVALID');return p;
}
export function validatePolicy(p, {purpose='release'} = {}) {
  invariant(p && NAME.test(p.id) && canonical(p.weights) === '[1,5,25,100]', 'INVALID_POLICY');
  invariant(p.stageDurationMs >= 60_000 && p.minRequests >= 100 && p.observationFreshnessMs > 0 && p.observationFreshnessMs <= 5000, 'INVALID_OBSERVATION_POLICY');
  invariant(p.probeHz >= 10 && p.requestDeadlineMs <= 2000 && p.requestDeadlineMs > 0 && p.attachDeadlineMs <= 5000 && p.attachDeadlineMs > 0, 'INVALID_SLO_POLICY');
  invariant(p.softErrorDelta <= 0.01 && p.softErrorDelta >= 0 && p.p95Ratio <= 2 && p.p95Ratio > 0 && p.p95FloorMs <= 1000 && p.p95FloorMs > 0 && p.evaluationIntervalMs <= 10_000 && p.evaluationIntervalMs > 0 && p.consecutiveEvaluations >= 2, 'INVALID_SOFT_POLICY');
  invariant(positive(p.retentionMs) && positive(p.migrationBatchMs) && p.migrationBatchMs < p.requestDeadlineMs && positive(p.maxWalBytes) && positive(p.minFreeBytes), 'INVALID_BUDGET_POLICY');
  invariant(Array.isArray(p.fallbacks) && p.fallbacks.length > 0 && p.fallbacks.every(f => RELEASE.test(f.releaseId) && DIGEST.test(f.apiDigest) && DIGEST.test(f.webDigest) && (purpose==='qualification' ? typeof f.rehearsed === 'boolean' : f.rehearsed === true)), 'FALLBACK_NOT_REHEARSED');
  invariant(p.stopUserResources === false && p.restoreLiveVolume === false && p.contractInUpgrade === false, 'FORBIDDEN_DEPLOY_AUTHORITY');
  return p;
}
export function validateManifest(m, { purpose = 'release' } = {}) {
  invariant(['release','qualification'].includes(purpose) && (m?.purpose || 'release') === purpose, 'WRONG_MANIFEST_PURPOSE');
  if (purpose === 'qualification') invariant(m.qualification && NAME.test(m.qualification.instanceId) && DIGEST.test(m.qualification.inputFingerprint), 'QUALIFICATION_BINDING_MISSING');
  invariant(m && m.schemaVersion === 2 && RELEASE.test(m.releaseId) && NAME.test(m.channel) && Number.isFinite(Date.parse(m.publishedAt)) && m.withdrawn !== true, 'INVALID_RELEASE_MANIFEST');
  invariant(m.commits && ['project','api','web'].every(k => SHA.test(m.commits[k])), 'INVALID_COMMITS');
  invariant(m.components && ['api','web','installer','coordinator'].every(k => { const c = m.components[k]; return c && DIGEST.test(c.artifactDigest) && DIGEST.test(c.inputFingerprint) && SHA.test(c.sourceRevision) && range(c.protocol); }), 'INVALID_COMPONENT_IDENTITY');
  for(const c of Object.values(m.components))if(c.dataFormats!==undefined)invariant(Array.isArray(c.dataFormats)&&c.dataFormats.every(v=>v==='project-name-v2-authority')&&new Set(c.dataFormats).size===c.dataFormats.length,'INVALID_COMPONENT_DATA_FORMATS');
  for(const [name,c] of Object.entries(m.components))if(c.upgradeOperationFormats!==undefined)invariant(name==='coordinator'&&Array.isArray(c.upgradeOperationFormats)&&c.upgradeOperationFormats.every(v=>v==='upgrade-plan-v1')&&new Set(c.upgradeOperationFormats).size===c.upgradeOperationFormats.length,'INVALID_UPGRADE_OPERATION_FORMATS');
  if(m.components.owner)invariant(DIGEST.test(m.components.owner.artifactDigest)&&DIGEST.test(m.components.owner.inputFingerprint)&&SHA.test(m.components.owner.sourceRevision)&&range(m.components.owner.protocol),'INVALID_OWNER_IDENTITY');
  invariant(SHA.test(m.components.web.webRevision), 'WEB_BUILD_IDENTITY_MISSING');
  invariant(Array.isArray(m.packages) && m.packages.length && m.packages.length <= 16, 'PACKAGES_MISSING');
  const names = new Set(), platforms = new Set();
  for (const p of m.packages) {
    invariant(['linux','darwin'].includes(p.platform) && ['arm64','x64'].includes(p.arch) && NAME.test(p.name) && DIGEST.test(p.digest) && positive(p.bytes) && ['native-tar','oci-tar'].includes(p.format), 'INVALID_PACKAGE');
    invariant(!names.has(p.name) && !platforms.has(p.platform + ':' + p.arch), 'DUPLICATE_PACKAGE'); names.add(p.name); platforms.add(p.platform + ':' + p.arch);
    const url = new URL(p.url); invariant(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'UNTRUSTED_PACKAGE_URL');
  }
  invariant(Array.isArray(m.upgradePaths) && m.upgradePaths.length > 0 && m.upgradePaths.every(p => RELEASE.test(p.fromRelease) && Number.isSafeInteger(p.minSchema) && p.minSchema >= 0 && Number.isSafeInteger(p.maxSchema) && p.maxSchema >= p.minSchema && Number.isSafeInteger(p.targetSchema) && p.targetSchema >= 0 && Array.isArray(p.bridgeReleases) && p.bridgeReleases.every(RELEASE.test.bind(RELEASE)) && (p.migrationPlanDigest === null || DIGEST.test(p.migrationPlanDigest))), 'INVALID_UPGRADE_PATH');
  validatePolicy(m.policy,{purpose});
  if(m.contractPlans!==undefined){invariant(Array.isArray(m.contractPlans)&&m.contractPlans.length<=16,'INVALID_CONTRACT_PLANS');const ids=new Set();for(const plan of m.contractPlans){validateContractPlan(plan);invariant(!ids.has(plan.planDigest),'DUPLICATE_CONTRACT_PLAN');ids.add(plan.planDigest);invariant(plan.artifactInputFingerprint===runInputFingerprint(m)&&m.upgradePaths.some(p=>p.migrationPlanDigest===plan.expandPlanDigest),'CONTRACT_PLAN_INPUT_MISMATCH');}}
  if (purpose === 'release') {
    invariant(Array.isArray(m.evidence) && ['build','contracts','four-combinations','native-continuity','fault-recovery'].every(kind => m.evidence.some(e => e.kind === kind && e.result === 'passed' && DIGEST.test(e.inputFingerprint) && DIGEST.test(e.reportDigest) && NAME.test(e.runId) && Number.isFinite(Date.parse(e.recordedAt)))), 'RELEASE_GATES_MISSING');
    if (m.upgradePaths.some(p => p.migrationPlanDigest)) invariant(m.evidence.some(e => e.kind === 'online-migration' && e.result === 'passed' && e.maxDataTested === true && e.forwardOnlyTested === true && DIGEST.test(e.reportDigest)), 'MIGRATION_GATES_MISSING');
  } else invariant(Array.isArray(m.evidence) && m.evidence.every(e => ['qualification','not-run','passed'].includes(e.result) && DIGEST.test(e.inputFingerprint) && DIGEST.test(e.reportDigest)), 'INVALID_QUALIFICATION_EVIDENCE');
  for(const plan of m.contractPlans||[])invariant(m.evidence.some(e=>e.kind==='semantic-contract'&&e.contractPlanDigest===plan.planDigest&&e.inputFingerprint===plan.artifactInputFingerprint&&DIGEST.test(e.reportDigest)&&(e.result==='passed'||(purpose==='qualification'&&e.result==='not-run'))),'SEMANTIC_CONTRACT_GATES_MISSING');

  return m;
}
function signForPurpose(manifest, keyId, privatePem, purpose) {
  validateManifest(manifest,{purpose}); invariant(NAME.test(keyId), 'INVALID_KEY_ID');
  const key = createPrivateKey(privatePem); invariant(key.asymmetricKeyType === 'ed25519', 'INVALID_SIGNING_KEY');
  const bytes = canonical(manifest);
  return { manifest, manifestDigest: digest(bytes), signature: { algorithm: 'Ed25519', keyId, value: sign(null, Buffer.from(bytes), key).toString('base64') } };
}
export const signManifest = (manifest,keyId,privatePem) => signForPurpose(manifest,keyId,privatePem,'release');
export const signQualificationManifest = (manifest,keyId,privatePem) => signForPurpose(manifest,keyId,privatePem,'qualification');
export function runInputFingerprint(manifest) {
  return digest({commits:manifest.commits,components:manifest.components,packages:manifest.packages.map(({platform,arch,digest,bytes,format,unpackedBytes})=>({platform,arch,digest,bytes,format,...(unpackedBytes===undefined?{}:{unpackedBytes})})),upgradePaths:manifest.upgradePaths,policy:{...manifest.policy,fallbacks:manifest.policy.fallbacks.map(({rehearsed,...identity})=>identity)}});
}
export function verifySignedManifest(envelope,roots,now=Date.now()) {
  invariant(roots?.schemaVersion === 1 && Array.isArray(roots.keys) && roots.keys.length && Array.isArray(roots.distributionOrigins) && roots.distributionOrigins.length, 'TRUST_ROOT_MISSING');
  const { manifest, manifestDigest, signature } = envelope || {};
  invariant(signature?.algorithm === 'Ed25519' && typeof signature.value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(signature.value), 'SIGNATURE_MISSING');
  const trusted = roots.keys.find(k => k.id === signature.keyId && k.revoked !== true && (!k.notBefore || Date.parse(k.notBefore) <= now) && (!k.notAfter || Date.parse(k.notAfter) >= now));
  invariant(trusted, 'UNTRUSTED_SIGNING_KEY');
  const key = createPublicKey(trusted.publicKey); invariant(key.asymmetricKeyType === 'ed25519', 'INVALID_TRUST_KEY');
  const bytes = canonical(manifest);
  invariant(DIGEST.test(manifestDigest) && digest(bytes) === manifestDigest && verify(null, Buffer.from(bytes), key, Buffer.from(signature.value, 'base64')), 'SIGNATURE_OR_MANIFEST_DIGEST_INVALID');
  const purpose=roots.purpose||'release';invariant((manifest.purpose||'release')===purpose,'WRONG_TRUST_DOMAIN');validateManifest(manifest,{purpose});invariant(manifest.channel===roots.channel,'WRONG_CHANNEL');for(const p of manifest.packages)invariant(roots.distributionOrigins.includes(new URL(p.url).origin),'UNTRUSTED_DISTRIBUTION_ORIGIN');return {manifest,manifestDigest,purpose};
}
export function verifyManifest(envelope, roots, current, now = Date.now()) {
  const {manifest,manifestDigest}=verifySignedManifest(envelope,roots,now);
  const purpose=roots.purpose||'release';
  invariant((manifest.purpose||'release')===purpose, 'WRONG_TRUST_DOMAIN');
  if(purpose==='qualification') invariant(roots.qualificationInstanceId === current.instanceId && manifest.qualification?.instanceId === current.instanceId && manifest.qualification.inputFingerprint === runInputFingerprint(manifest), 'WRONG_QUALIFICATION_INSTANCE');
  validateManifest(manifest,{purpose});
  invariant(manifest.channel === roots.channel && manifest.channel === current.channel, 'WRONG_CHANNEL');
  const pkg = manifest.packages.find(p => p.platform === current.platform && p.arch === current.arch);
  invariant(pkg, 'UNSUPPORTED_ARCHITECTURE');
  for (const p of manifest.packages) invariant(roots.distributionOrigins.includes(new URL(p.url).origin), 'UNTRUSTED_DISTRIBUTION_ORIGIN');
  const path = manifest.upgradePaths.find(p => p.fromRelease === current.releaseId && current.schema >= p.minSchema && current.schema <= p.maxSchema);
  invariant(path && path.bridgeReleases.every(b => (current.bridges || []).includes(b)), 'UPGRADE_PATH_NOT_SUPPORTED');
  invariant(path.targetSchema===current.schema||permitsImageRuntimeVersionsPath(path,current.schema),'GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED');
  for (const name of ['api','web','installer','coordinator',...(manifest.components.owner?['owner']:[])]) { const live = current.protocols?.[name] || (['coordinator','owner'].includes(name)?current.protocols?.api:null); invariant(live && range(live) && live.min <= manifest.components[name].protocol.max && live.max >= manifest.components[name].protocol.min, 'INCOMPATIBLE_PROTOCOL'); }
  const different=['api','web','installer','coordinator',...(manifest.components.owner?['owner']:[])].some(name=>current[name+'Digest']!==manifest.components[name].artifactDigest||current[name+'InputFingerprint']!==manifest.components[name].inputFingerprint);
  invariant(current.releaseId !== manifest.releaseId||(current.partialRepair===true&&different),'ALREADY_INSTALLED');
  return { manifest, manifestDigest, package: pkg, path };
}
export async function loadTrustRoot(path) {
  const s = await lstat(path); invariant(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o022) === 0, 'INSECURE_TRUST_ROOT');
  if (process.getuid) invariant(s.uid === process.getuid() || s.uid === 0, 'TRUST_ROOT_OWNER');
  return JSON.parse(await readFile(path, 'utf8'));
}
export function freezePlan(verified, current) {
  const { manifest: m, manifestDigest, package: pkg, path } = verified;
  invariant(path.targetSchema===current.schema||permitsImageRuntimeVersionsPath(path,current.schema),'GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED');
  const apiReused = current.apiDigest === m.components.api.artifactDigest && current.apiInputFingerprint === m.components.api.inputFingerprint;
  const webReused = current.webDigest === m.components.web.artifactDigest && current.webInputFingerprint === m.components.web.inputFingerprint;
  const coordinatorDigest=current.coordinatorDigest||current.apiDigest,coordinatorInputFingerprint=current.coordinatorInputFingerprint||current.apiInputFingerprint;
  const coordinatorReused=coordinatorDigest===m.components.coordinator.artifactDigest&&coordinatorInputFingerprint===m.components.coordinator.inputFingerprint;
  const ownerReused=!m.components.owner||(current.ownerDigest===m.components.owner.artifactDigest&&current.ownerInputFingerprint===m.components.owner.inputFingerprint);
  const installerReused=current.installerDigest===m.components.installer.artifactDigest&&current.installerInputFingerprint===m.components.installer.inputFingerprint;
  const steps = [ { stepId: 'package-download', kind: 'download', artifactName: pkg.name, totalWork: pkg.bytes }, { stepId: 'package-verify', kind: 'verify', totalWork: 1 } ];
  if(!installerReused)steps.push({stepId:'installer-handoff',kind:'installer-handoff',totalWork:1});
  if (path.migrationPlanDigest) steps.push({ stepId: 'migration', kind: 'migration', planDigest: path.migrationPlanDigest, totalWork: null });
  if(!ownerReused)steps.push({stepId:'owner-candidate',kind:'owner-candidate',totalWork:1});
  if (!apiReused) steps.push({ stepId: 'candidate', kind: 'candidate', totalWork: 1 });
  if(!coordinatorReused)steps.push({stepId:'coordinator-handoff',kind:'coordinator-handoff',totalWork:1});
  if (!apiReused) { for (const weight of m.policy.weights) steps.push({ stepId: 'route-' + weight, kind: 'route', weight, totalWork: 1 }, { stepId: 'observe-' + weight, kind: 'observe', weight, totalWork: m.policy.minRequests }); }
  if (!webReused) steps.push({ stepId: 'web-bind', kind: 'web', totalWork: 1 });
  steps.push({ stepId: 'activation-confirm', kind: 'activation', totalWork: 1 });
  const plan = { schemaVersion: 1, releaseId: m.releaseId, manifestDigest, package: pkg, migrationPath: path, apiReused, webReused, coordinatorReused, ownerReused, installerReused, policy: m.policy, steps, sourceActivationGeneration: current.generation, sourceApiDigest: current.apiDigest, sourceWebDigest: current.webDigest, sourceCoordinatorDigest:coordinatorDigest, sourceOwnerDigest:current.ownerDigest||null,sourceInstallerDigest:current.installerDigest,sourceInstallerInputFingerprint:current.installerInputFingerprint };
  return { ...plan, planDigest: digest(plan) };
}
