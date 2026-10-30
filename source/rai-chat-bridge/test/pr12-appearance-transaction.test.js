import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
function appearanceContext() {
  const writes = [];
  const context = {document:{documentElement:{dataset:{}}},term:{options:{fontSize:10}},
    terminalThemes:{dark:{id:'black'},light:{id:'white'}},
    localStorage:{setItem:(...args)=>writes.push(args)},THEME_KEY:'theme',FONT_SIZE_KEY:'font',
    themeButtons:[],systemAppearance:{matches:false},fit:{fit(){}},sendResize(){}};
  vm.createContext(context);
  const from = source.indexOf('function applyFontSize(');
  const to = source.indexOf('\nfunction settingsBody(',from);
  vm.runInContext(source.slice(from,to),context);
  return {context,writes};
}
test('theme preview stages appearance without persisting before Save',()=>{
  const {context,writes}=appearanceContext();
  context.applyTheme('system',{persist:false});
  assert.equal(context.document.documentElement.dataset.theme,'light');
  assert.deepEqual(writes,[]);
  context.applyTheme('system');
  assert.deepEqual(writes,[['theme','system']]);
});
test('font preview stages typography without persisting before Save',()=>{
  const {context,writes}=appearanceContext();
  context.applyFontSize(14,{persist:false});
  assert.equal(context.term.options.fontSize,14);
  assert.deepEqual(writes,[]);
  context.applyFontSize(14);
  assert.deepEqual(writes,[['font','14']]);
});
test('Cancel restores the saved appearance without touching pending user text',()=>{
  const {context,writes}=appearanceContext();
  Object.assign(context,{savedAppearance:{fontSize:10,theme:'dark'},draftThemeMode:'light',
    panel:{hidden:false},settingsLoading:false,settingsSaving:false,savedSettings:{},pendingText:{value:'intervening user draft'},
    document:{documentElement:{dataset:{}},getElementById:()=>({hidden:false})}});
  context.term.focus=()=>{};
  context.term.options.fontSize=14;
  const start=source.indexOf('function closePanelDiscard(');
  const end=source.indexOf("\ndocument.getElementById('settings-confirm-discard')",start);
  vm.runInContext(source.slice(start,end),context);
  context.closePanelDiscard();
  assert.equal(context.term.options.fontSize,10);
  assert.equal(context.document.documentElement.dataset.theme,'dark');
  assert.equal(context.pendingText.value,'intervening user draft');
  assert.deepEqual(writes,[]);
});

