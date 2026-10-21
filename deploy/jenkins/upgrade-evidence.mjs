import * as fs from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from '../upgrade/artifacts.mjs';
import { readJson,fileDigest,atomicJson,secureDirectory } from '../upgrade/io.mjs';
import { invariant,canonical } from '../upgrade/trust.mjs';
export async function collectUpgradeEvidence(config,{run=command}={}) {
  const output=await secureDirectory(config.outputRoot),nativeReport=join(output,'native-actual.json');
  invariant(config.platform==='linux'&&config.arch==='arm64'&&process.platform==='linux'&&process.arch==='arm64','NATIVE_KVM_ARCHITECTURE_REQUIRED');
  invariant((await fs.stat('/dev/kvm')).isCharacterDevice(),'KVM_REQUIRED');
  const runner=join(config.sourceRoot,'e2e-contract/native/verify-upgrade.mjs');invariant((await fs.lstat(runner)).isFile(),'NATIVE_RUNNER_NOT_IMPLEMENTED');
  await run(process.execPath,[runner,'--report',nativeReport,'--package-root',config.packageRoot,'--manifest',config.manifestPath,...(config.acceptanceConfigPath?['--config',config.acceptanceConfigPath]:[])],{cwd:config.sourceRoot});
  const result=await readJson(nativeReport);
  invariant(result.result==='passed'&&result.skipped===0&&result.substituted!==true&&result.native===true&&canonical(result.commits)===canonical(config.commits)&&result.packageDigest===config.packageDigest&&result.runInputFingerprint===config.runInputFingerprint,'NATIVE_EVIDENCE_NOT_CURRENT');
  const required=['N01','N02','N03',...Array.from({length:14},(_,i)=>'X'+String(i+1).padStart(2,'0')),'WebA-APIA','WebA-APIB','WebB-APIB','WebB-APIA'];
  invariant(required.every(id=>result.assertions?.some(a=>a.id===id&&a.result==='passed'&&a.expectLocation&&a.actualEvidence)),'NATIVE_OR_COMBINATIONS_INCOMPLETE');
  const reports=[];
  for(const kind of ['build','contracts','four-combinations','native-continuity','fault-recovery',...(config.migrationPlanDigest?['online-migration']:[])]){
    const detail=result.gates?.[kind];invariant(detail?.result==='passed'&&detail.assertions?.length>0&&detail.assertions.every(a=>a.result==='passed'&&a.expectLocation&&a.actualEvidence),'ACTUAL_GATE_EVIDENCE_REQUIRED');
    const report={...detail,kind,result:'passed',skipped:0,native:true,commits:config.commits,inputFingerprint:config.runInputFingerprint,runId:result.runId,recordedAt:result.recordedAt};const name=kind+'.json';await atomicJson(join(output,name),report);reports.push({name,...await fileDigest(join(output,name))});
  }
  for(const planDigest of config.contractPlanDigests||[]){const detail=result.gates?.['semantic-contract']?.plans?.find(p=>p.contractPlanDigest===planDigest);invariant(detail?.result==='passed'&&detail.inputFingerprint===config.runInputFingerprint&&detail.assertions?.length>0&&detail.assertions.every(a=>a.result==='passed'&&a.expectLocation&&a.actualEvidence),'SEMANTIC_CONTRACT_EVIDENCE_REQUIRED');const report={...detail,kind:'semantic-contract',result:'passed',skipped:0,native:true,commits:config.commits,inputFingerprint:config.runInputFingerprint,runId:result.runId,recordedAt:result.recordedAt};const name='semantic-contract-'+planDigest.slice(7)+'.json';await atomicJson(join(output,name),report);reports.push({name,...await fileDigest(join(output,name))});}
  await atomicJson(join(output,'report-set.json'),{schemaVersion:1,runInputFingerprint:config.runInputFingerprint,reports});return {result:'passed',reports};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)readJson(process.argv[2]).then(collectUpgradeEvidence).then(r=>process.stdout.write(JSON.stringify(r)+'\n'),e=>{process.stderr.write((e.code||'UPGRADE_EVIDENCE_FAILED')+'\n');process.exitCode=1;});
