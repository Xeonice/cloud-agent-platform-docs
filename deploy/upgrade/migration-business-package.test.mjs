import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createAcceptedUpgrade } from '../test-support/accepted-upgrade.mjs';
import { readVerifiedMigrationBusiness } from './control-migration-runtime.mjs';
const Database=createRequire(new URL('../../api/package.json',import.meta.url))('better-sqlite3');

test('migration verifies the signed schema-2 packages collection and returns the actual selected package for archive/provenance checks',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'migration-business-package-'))),db=new Database(':memory:');
  t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});
  const f=createAcceptedUpgrade(db),paths={envelopePath:join(root,'signed.json'),currentSourcePath:join(root,'current.json'),trustRootPath:join(root,'trust.json')};
  for(const [path,value]of[[paths.envelopePath,f.envelope],[paths.currentSourcePath,f.current],[paths.trustRootPath,f.roots]])await fs.writeFile(path,JSON.stringify(value),{mode:0o600});
  assert.equal(Object.hasOwn(f.envelope.manifest,'package'),false);
  const verified=await readVerifiedMigrationBusiness(paths);
  assert.deepEqual(verified.signed.package,f.manifest.packages[0]);
  assert.equal(verified.signed.package.platform,process.platform);
  assert.equal(verified.envelope.manifestDigest,f.envelope.manifestDigest);
  const forged=structuredClone(f.envelope);forged.manifest.packages[0].digest='sha256:'+'0'.repeat(64);
  await fs.writeFile(paths.envelopePath,JSON.stringify(forged),{mode:0o600});
  await assert.rejects(readVerifiedMigrationBusiness(paths));
});
