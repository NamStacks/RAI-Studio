import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/terminal.js',import.meta.url),'utf8');
test('host opening retry joins the in-flight native read rather than issuing a premature negative acknowledgement',async()=>{
 let release, reads=0,settled=false;
 const c={panel:{hidden:true},settingsLoading:false,settingsReadGeneration:0,settingsRevision:null,settingsOpenPromise:null,
 fetchSettings:()=>{reads++;return new Promise(resolve=>{release=resolve;});},showStatus(){}};vm.createContext(c);
 const start=source.indexOf('async function openPanel('),end=source.indexOf('\nfunction closePanel(',start);
 vm.runInContext(source.slice(start,end),c);
 const first=c.openPanel();const second=c.openPanel().then(()=>{settled=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);assert.equal(settled,false);
 release({provider:'claude',settings_revision:'r1'});await first;await second;
});
