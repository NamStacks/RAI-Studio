import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_CONFIG, backfillProviderDefaults } from '../config.js';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
function fixture() {
  const original={provider:'claude',providers:{claude:{},codex:{}},globalPrompt:'custom',snippets:{},autoApproveReadOnly:false,caffeinate:false,theme:'system',fontSize:12,custom:'keep'};
  let revision='r1', stored=structuredClone(original), writes=0;
  const context={config:structuredClone(original),settingsRevision:'r1', canonicalSettingsReady:true,
    settingsAuthority:{async read(){return {settings:structuredClone(stored),settings_revision:revision};},async save(next,expected){assert.equal(expected,revision);stored=structuredClone(next);revision='r2';writes++;return {status:'committed',settings:structuredClone(stored),settings_revision:revision};}},
    DEFAULT_CONFIG,backfillProviderDefaults,structuredClone,hasValidSessionToken:()=>true,
    settingsCatalogForActiveModels:x=>x,activeModelSnapshot:()=>({}),readBody:async req=>JSON.stringify(req.body),
    validateSnippets:x=>x,validateGlobalPrompt:x=>x,validateProfile:()=>({ok:true}),mergeSettings:(a,b)=>({...a,provider:b.provider??a.provider}),
    sendJson:(res,code,obj)=>{res.code=code;res.body=obj;},setLiveCaffeinate:()=>{},sendToClient:()=>{},observedCaffeinate:false,
    writeConfig:()=>{},store:{term:{__provider:'claude'}},transitionRequired:()=>false};
  vm.createContext(context);
  const normalizeStart=source.indexOf('function normalizeSettings(');
  const normalizeEnd=source.indexOf('// Defaults are supplied',normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  vm.runInContext(source.slice(normalizeStart,normalizeEnd),context);
  const originalBytes=JSON.stringify(original);
  context.config=context.normalizeSettings(original);
  assert.equal(JSON.stringify(original),originalBytes,'effective normalization must not mutate raw authority settings');
  const start=source.indexOf('async function handleSettings(');
  const boundary=/\n(?:async )?function handleProviderStatus\(/.exec(source.slice(start));
  assert.ok(start >= 0 && boundary, 'Settings handler extraction boundaries exist');
  const end=start+boundary.index;
  vm.runInContext(source.slice(start,end),context);
  return {context, original,get writes(){return writes;},get stored(){return stored;}};
}
test('settings commit routes through native authority, acknowledges all editable fields and retains custom data',async()=>{
  for (const explicit of [true,false]) {
  const f=fixture(),res={};
  const body={provider:'codex',globalPrompt:'draft',snippets:{},caffeinate:false,theme:'light',fontSize:14,expected_revision:'r1'};
  if (explicit) body.autoApproveReadOnly=false;
  await f.context.handleSettings({method:'POST',body},res);
  assert.equal(res.code,200);assert.equal(f.writes,1);assert.equal(res.body.settings_revision,'r2');
  const replay={};await f.context.handleSettings({method:'POST',body:{provider:'codex',expected_revision:'r1'}},replay);
  assert.equal(replay.code,409);assert.equal(f.writes,1);
  assert.equal(f.stored.custom,'keep');assert.equal(f.stored.theme,'light');assert.equal(f.stored.fontSize,14);
  assert.equal(f.stored.autoApproveReadOnly,false);assert.equal(res.body.autoApproveReadOnly,true);
  }
});
test('stale and replay settings saves deny before write and preserve exact draft and stored settings',async()=>{
  const f=fixture(),body={provider:'codex',expected_revision:'stale',globalPrompt:'unsent\n draft'},bytes=JSON.stringify(body),res={};
  await f.context.handleSettings({method:'POST',body},res);
  assert.equal(res.code,409);assert.equal(f.writes,0);assert.equal(JSON.stringify(body),bytes);assert.deepEqual(f.stored,f.original);
});
test('native settings failure cannot fall back to a bridge writer or acknowledge switch',async()=>{
  const f=fixture(),res={},before=f.context.config;f.context.settingsAuthority.save=async()=>{throw Error('native unavailable');};
  await f.context.handleSettings({method:'POST',body:{provider:'codex',expected_revision:'r1'}},res);
  assert.notEqual(res.code,200);assert.equal(f.writes,0);assert.deepEqual(f.context.config,before);
});

import { createSettingsAuthority } from '../settings-authority.js';
function s11Authority(saveOnEdit, acknowledge = x => x) {
  const settings = {provider:'claude', providers:{claude:{command:'claude',args:[]}},
    caffeinate:false, autoApproveReadOnly:true, saveOnEdit, globalPrompt:'', snippets:{}, theme:'dark', fontSize:10};
  const calls = [];
  const authority = createSettingsAuthority({nativeCall:async (endpoint, request) => {
    calls.push({endpoint, request});
    if (request.operation === 'read') return {settings:structuredClone(settings), settings_revision:'r1'};
    return {status:'committed', settings:acknowledge(JSON.parse(request.settings)), settings_revision:'r2'};
  }});
  return {settings, authority, calls};
}
for (const value of [false, true]) {
  test(`S11 fix2 exact native saveOnEdit acknowledgement ${value}`, async () => {
    const f=s11Authority(value);
    const result=await f.authority.save(f.settings,'r1');
    assert.equal(result.settings.saveOnEdit,value);
    assert.deepEqual(f.calls.map(x=>x.request.operation),['read','save']);
    assert.ok(f.calls.every(x=>x.endpoint==='settings'));
  });
  test(`S11 fix2 retired saveOnEdit omitted or flipped by native is not a readback conflict ${value}`, async () => {
    for (const acknowledge of [x=>{delete x.saveOnEdit;return x;}, x=>({...x,saveOnEdit:!value})]) {
      const f=s11Authority(value, acknowledge);
      const result=await f.authority.save(f.settings,'r1');
      assert.equal(result.status,'committed');
      assert.equal(f.calls.length,2);
    }
  });
}
for (const value of [undefined, 'false']) test(`S11 fix2 invalid saveOnEdit submission ${value}`, async () => {
  const f=s11Authority(value);
  if (value===undefined) delete f.settings.saveOnEdit;
  await assert.rejects(f.authority.save(f.settings,'r1'), /saveOnEdit must be boolean/, 'S11 fix2 boolean validation required');
  assert.deepEqual(f.calls.map(x=>x.request.operation),['read']);
});
const READBACK_DIFFERS = [
  ['provider', 'codex'], ['caffeinate', true], ['autoApproveReadOnly', false], ['theme', 'light'],
  ['fontSize', 12], ['globalPrompt', 'changed by native'], ['snippets', {extra: {}}]
];
test('S11 fix2 native readback that differs in any compared field is rejected and never reported as committed', async () => {
  for (const [field, other] of READBACK_DIFFERS) for (const mode of ['differs', 'omitted']) {
    const f=s11Authority(true, x => { if (mode==='omitted') delete x[field]; else x[field]=other; return x; });
    assert.notDeepEqual(other, f.settings[field], `${field} test value must differ from the submitted value`);
    await assert.rejects(f.authority.save(f.settings,'r1'), /Native settings readback differs/, `${field} ${mode}`);
    assert.deepEqual(f.calls.map(x=>x.request.operation),['read','save'], `${field} ${mode}`);
  }
});
