import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,mkdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const scratch=process.env.TMPDIR;
test('native-authority startup never creates a competing migration/recovery writer for corrupt settings',()=>{
 const home=mkdtempSync(path.join(scratch,'pr12-settings-'));
 try {mkdirSync(path.join(home,'.raistudio'));const file=path.join(home,'.raistudio','assistant.json');writeFileSync(file,'{ exact invalid owner bytes');
 const configUrl=new URL('../config.js',import.meta.url).href;
 const run=spawnSync(process.execPath,['--input-type=module','-e',`import {loadConfig} from ${JSON.stringify(configUrl)};loadConfig({persistMigration:false});`],{env:{...process.env,HOME:home},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.equal(readFileSync(file,'utf8'),'{ exact invalid owner bytes');assert.deepEqual(readdirSync(path.dirname(file)),['assistant.json']);
 }finally{rmSync(home,{recursive:true,force:true});}
});
