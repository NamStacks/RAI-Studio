import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/terminal.js',import.meta.url),'utf8');
function functions(names,c) {
 vm.createContext(c);
 for(const name of names){const from=source.indexOf(`function ${name}(`);assert.notEqual(from,-1);const start=source.lastIndexOf('\n',from);let end=source.indexOf('\n}',from)+2;vm.runInContext(source.slice(start,end),c);}
 return c;
}
test('settings Save submits loaded native revision and all appearance/caffeine fields, not local storage',async()=>{
 let body;const c=functions(['settingsBody','slimSnippets','persistSettings'],{providerSel:{value:'codex'},globalPromptInput:{value:'exact\n draft'},snippetInputValue:()=>({}),caffeinateInput:{checked:false},draftThemeMode:'system',fontSizeSel:{value:'14'},settingsRevision:'r1',savedSettings:null,currentProvider:'claude',wsSessionToken:'ui',showStatus(){},showSettingsError(){},fetch:async(_url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({...body,settings_revision:'r2'})};}});
 assert.equal(await c.persistSettings(),true);assert.equal(body.expected_revision,'r1');assert.equal(body.theme,'system');assert.equal(body.fontSize,14);assert.equal(body.caffeinate,false);assert.equal(body.saveOnEdit,true, "RAI saving is always sent ON");assert.equal(body.autoApproveReadOnly,true);assert.equal(c.settingsRevision,'r2');
});
test('repeated outer gear activation preserves an open raw settings draft',async()=>{
 let reads=0;const c=functions(['openPanel'],{panel:{hidden:false},settingsLoading:false,globalPromptInput:{value:'raw unsaved text'},fetchSettings:async()=>{reads++;throw Error('should not read');},showStatus(){}});
 await c.openPanel();assert.equal(reads,0);assert.equal(c.globalPromptInput.value,'raw unsaved text');
});
test('a rejected save retains exact revision and raw draft without acknowledged provider change',async()=>{
 const c=functions(['slimSnippets','persistSettings'],{settingsBody:()=>({provider:'codex',globalPrompt:'draft'}),settingsRevision:'r1',currentProvider:'claude',wsSessionToken:'ui',showStatus(){},showSettingsError(){},fetch:async()=>({ok:false,status:400,json:async()=>({error:'Settings changed'})})});
 assert.equal(await c.persistSettings(),false);assert.equal(c.settingsRevision,'r1');assert.equal(c.currentProvider,'claude');
});
test('owning source defines native locked CAS route and outer gear has no separate modal/writer',()=>{
 const root=new URL('../../source/',import.meta.url);
 const cpp=readFileSync(new URL('src/cpp/session/modules/SessionRaiAssistant.cpp',root),'utf8');
 assert.match(cpp,/Error handleSettingsRequest\(/);assert.match(cpp,/LOCK_EX \| LOCK_NB/);assert.match(cpp,/expected_revision/);
 const presenter=readFileSync(new URL('src/gwt/src/org/rstudio/studio/client/workbench/views/chat/ChatPresenter.java',root),'utf8');
 const from=presenter.indexOf('void onRaiAssistantSettings()');const to=presenter.indexOf('\n   @Handler',from);
 assert.match(presenter.slice(from,to),/display_\.openRaiSettings\(\)/);assert.doesNotMatch(presenter.slice(from,to),/new RaiAssistantSettingsDialog|raiSetSettings|raiSetCaffeinate/);
});

for (const legacy of [false, undefined]) test(`settings load/save without retired DOM control: legacy ${legacy}`, async () => {
  let posted; const errors=[]; const sessions=[];
  const c={panel:{hidden:true,inert:false,setAttribute(){},removeAttribute(){}},settingsReadGeneration:0,settingsLoading:false,settingsSaving:false,settingsRevision:null,structuredClone,
    fetchSettings:async()=>({provider:'claude',providers:{claude:{}},globalPrompt:'kept',snippets:{},autoApproveReadOnly:legacy,saveOnEdit:legacy,caffeinate:false,theme:'light',fontSize:12,settings_revision:'raw-rev'}),
    globalPromptInput:{value:''},caffeinateInput:{checked:true},providerSel:{value:''},renderNativeCliList(){},authModeSel:{value:''},fontSizeSel:{value:'12'},settingsSave:{disabled:false},wsSessionToken:'fixture',
    snippetInputValue:()=>c.draftSnippets,applySnippets(value){c.snippets=structuredClone(value);},fillSnippetInputs(value){c.draftSnippets=structuredClone(value);},
    showSettingsTab(){},showSettingsError(e){errors.push(e);},showStatus(e){errors.push(e);},populateModelOptions(){},populateEffortOptions(){},selectSavedFontSize(){},applyFontSize(){},applyTheme(){},refreshProviderStatus(){},validateGlobalPrompt(){},validateSnippets(){},
    document:{createElement:()=>({})},restartPendingBtn:{hidden:true},sessionStorage:{setItem(...x){sessions.push(x);}},closePanelDiscard(){c.panel.hidden=true;},
    fetch:async(_url,options)=>{posted=JSON.parse(options.body);return {ok:true,json:async()=>({...posted,settings_revision:'saved-rev'})};}};
  functions(['openPanel','settingsBody','slimSnippets','persistSettings','saveSettings'],c);
  await c.openPanel(); assert.equal(c.panel.hidden,false); assert.equal(c.savedSettings.autoApproveReadOnly,true); assert.equal(c.caffeinateInput.checked,false); assert.equal(c.globalPromptInput.value,'kept');
  // A retained legacy snapshot cannot create an extra restart/approval step either.
  c.savedSettings.autoApproveReadOnly=false;
  assert.equal(c.savedSettings.saveOnEdit,true, "snapshot is ON whatever the stored value was");
  await c.saveSettings(); assert.equal(posted.autoApproveReadOnly,true); assert.equal(posted.caffeinate,false);assert.equal(posted.saveOnEdit,true, "saved ON without restart"); assert.equal(posted.expected_revision,'raw-rev'); assert.equal(c.settingsRevision,'saved-rev'); assert.equal(c.panel.hidden,true); assert.equal(c.restartPendingBtn.hidden,true); assert.deepEqual(sessions,[]); assert.deepEqual(errors,[]);
});
