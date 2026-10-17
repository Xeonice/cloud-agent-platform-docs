import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeCoordinatorCapabilities } from './build-distribution.mjs';

// Production probe in a separate Node process against a minimal compiled
// dependency closure. No API/Owner bootstrap or release is executed.
async function fixture(t) {
  const root=await fs.mkdtemp(join(tmpdir(),'coordinator-capabilities-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const write=async(name,body)=>{
    const path=join(root,name);await fs.mkdir(join(path,'..'),{recursive:true});await fs.writeFile(path,body);
  };
  await write('node_modules/reflect-metadata/index.js','Reflect.getMetadata=(_key,target)=>target.providers;');
  await write('node_modules/@nestjs/common/constants.js',"exports.MODULE_METADATA={PROVIDERS:'providers'};");
  await write('node_modules/@platform/project/index.js',"exports.PROJECT_READ_PROJECTION=Symbol.for('project');");
  const base='apps/api/dist/platform/upgrade/';
  await write(base+'upgrade-project-projection.js',"exports.createUpgradeProjectProjection=()=>{};exports.UPGRADE_PROJECT_DATA_FORMATS=['project-name-v2-authority'];");
  await write(base+'upgrade-service.js',"exports.UpgradeService=class{onApplicationBootstrap(){}advanceOperation(){}};");
  await write(base+'upgrade-operation-store.js','exports.UpgradeOperationStore=class{};');
  await write(base+'upgrade-projection.js','exports.UpgradeProjection=class{};');
  const bind=async(extra='')=>write(base+'upgrade.module.js',`
    const {PROJECT_READ_PROJECTION}=require('@platform/project');
    const f=require('./upgrade-project-projection');
    const {UpgradeService}=require('./upgrade-service');
    const {UpgradeOperationStore}=require('./upgrade-operation-store');
    const {UpgradeProjection}=require('./upgrade-projection');
    exports.UpgradeModule=class{};
    exports.UpgradeModule.providers=[{provide:PROJECT_READ_PROJECTION,useFactory:f.createUpgradeProjectProjection}${extra}];
  `);
  await bind();return {root,write,bind,base};
}

test('old deployed closure declares only its existing data format',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await probeCoordinatorCapabilities(f.root),{dataFormats:['project-name-v2-authority']});
});

test('operation capability requires the compiled driver and its real store/projection bindings',async t=>{
  const f=await fixture(t);
  await f.write(f.base+'upgrade-service.js',"exports.UpgradeService=class{onApplicationBootstrap(){}advanceOperation(){}};exports.UPGRADE_OPERATION_DATA_FORMATS=['upgrade-plan-v1'];");
  await assert.rejects(probeCoordinatorCapabilities(f.root),{code:'ARTIFACT_COMMAND_FAILED'});
  await f.bind(',UpgradeService,UpgradeOperationStore,UpgradeProjection');
  assert.deepEqual(await probeCoordinatorCapabilities(f.root),{
    dataFormats:['project-name-v2-authority'],upgradeOperationFormats:['upgrade-plan-v1'],
  });
  await f.write(f.base+'upgrade-service.js',"exports.UpgradeService=class{onApplicationBootstrap(){}advanceOperation(){}};exports.UPGRADE_OPERATION_DATA_FORMATS=['future-unimplemented-format'];");
  await assert.rejects(probeCoordinatorCapabilities(f.root),{code:'ARTIFACT_COMMAND_FAILED'});
});
