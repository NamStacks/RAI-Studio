import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/terminal.js',import.meta.url),'utf8');
test('Save freezes only settings controls while acknowledgement is pending, preserving native document and pending draft',async()=>{
 let resolve; const panel={hidden:false,inert:false,setAttribute(){},removeAttribute(){}};
 const c={panel,settingsLoading:false,settingsSaving:false,settingsRevision:'r1',settingsSave:{disabled:false},globalPromptInput:{value:'exact raw instructions'},autoApprovalInput:{checked:false},providerSel:{value:'claude'},fontSizeSel:{value:'12'},draftThemeMode:'dark',draftSnippets:{},savedSettings:{provider:'claude',globalPrompt:'exact raw instructions',autoApproveReadOnly:false},savedAppearance:{},validateGlobalPrompt(){},validateSnippets(){},snippetInputValue:()=>({}),persistSettings:()=>new Promise(r=>{resolve=r;}),showSettingsError(){},applySnippets(){},settingsBody:()=>({}),applyFontSize(){},applyTheme(){},closePanelDiscard(){},documentText:'dirty original native document',pendingText:'unsent raw provider draft'};
 vm.createContext(c);const from=source.indexOf('async function saveSettings('),to=source.indexOf("\nresetSnippetsBtn.addEventListener",from);vm.runInContext(source.slice(from,to),c);
 const saving=c.saveSettings();assert.equal(panel.inert,true);assert.equal(c.documentText,'dirty original native document');assert.equal(c.pendingText,'unsent raw provider draft');
 resolve(false);await saving;assert.equal(panel.inert,false);assert.equal(c.globalPromptInput.value,'exact raw instructions');assert.equal(panel.hidden,false);
});
