import { invariant,digest } from './trust.mjs';
import { isImageRuntimeVersionsMigration } from './additive-migration-recipe.mjs';
const ID=/^[a-z][a-z0-9_]{0,80}$/;
function exact(value,keys,code){invariant(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k)),code);}
/** Same declarative data contract as the Coordinator; never shell or SQL text. */
export function validateMigrationPlan(value){
  if(isImageRuntimeVersionsMigration(value))return {plan:structuredClone(value),planDigest:digest(value)};
  exact(value,['schemaVersion','kind','fromSchema','targetSchema','maxBatchRows','oldRepresentationRetained','newSemanticsEnabled','projections'],'INVALID_MIGRATION_PLAN');
  invariant(value.schemaVersion===1&&value.kind==='expand-shadow'&&Number.isSafeInteger(value.fromSchema)&&value.fromSchema>=0&&Number.isSafeInteger(value.targetSchema)&&value.targetSchema>=value.fromSchema&&Number.isSafeInteger(value.maxBatchRows)&&value.maxBatchRows>=1&&value.maxBatchRows<=1000&&value.oldRepresentationRetained===true&&value.newSemanticsEnabled===false&&Array.isArray(value.projections)&&value.projections.length>=1&&value.projections.length<=32,'INVALID_MIGRATION_PLAN');
  const targets=new Set();
  for(const p of value.projections){exact(p,['sourceTable','primaryKey','targetTable','fields'],'INVALID_MIGRATION_PROJECTION');invariant(ID.test(p.sourceTable)&&!/^upgrade_|^platform_|^upg_shadow_/.test(p.sourceTable)&&ID.test(p.primaryKey)&&ID.test(p.targetTable)&&p.targetTable.startsWith('upg_shadow_')&&!targets.has(p.targetTable)&&Array.isArray(p.fields)&&p.fields.length>=1&&p.fields.length<=100,'INVALID_MIGRATION_PROJECTION');targets.add(p.targetTable);const names=new Set();for(const f of p.fields){exact(f,['name','type','source','default'],'INVALID_MIGRATION_FIELD');invariant(ID.test(f.name)&&!['row_key','row_revision','tombstone'].includes(f.name)&&!names.has(f.name)&&['text','integer','real','blob'].includes(f.type),'INVALID_MIGRATION_FIELD');names.add(f.name);const source=Object.hasOwn(f,'source'),fallback=Object.hasOwn(f,'default');invariant(source!==fallback&&(source?ID.test(f.source):(f.default===null||typeof f.default==='string'||typeof f.default==='boolean'||typeof f.default==='number'&&Number.isFinite(f.default))),'INVALID_MIGRATION_MAPPING');}}
  return {plan:structuredClone(value),planDigest:digest(value)};
}
