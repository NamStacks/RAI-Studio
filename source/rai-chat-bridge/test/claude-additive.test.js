import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pty from 'node-pty';
const { createCliSession, removeSessionMcpConfig } = await import(process.env.S9E_MCP_MODULE || '../mcp.js');
const secret = 's9e-synthetic-bearer';
const { tools: nativeTools } = await import('../rai-native-mcp.js');
for (const [shape, leaf] of Object.entries({ space: 'space directory', quote: 'single\'double"', backslash: 'back\\slash', unicode: '日本語=]' })) {
  for (const pathMode of ['absent', 'empty', 'foreign']) {
    test(`Claude additive PTY ${shape} ${pathMode}`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 's9e-'));
      const dir = path.join(root, leaf); mkdirSync(dir);
      let term;
      try {
        const nativeScript = path.join(root, 'native-rai.cjs');
        writeFileSync(nativeScript, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='tools/list'?{tools:${JSON.stringify(nativeTools)}}:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'user-rai',version:'1'}}}));});`);
        const native = { mcpServers: { rai: { command: process.execPath, args: [nativeScript] }, native: { command: 'user-native', args: [] } } };
        const nativeBytes = JSON.stringify(native); writeFileSync(path.join(root, '.mcp.json'), nativeBytes);
        symlinkSync(process.env.S9E_CONNECTOR_MODULE || new URL('../rai-native-mcp.js', import.meta.url).pathname, path.join(dir, 'rai-native-mcp.js'));
        const record = path.join(root, 'record.json');
        const recorder = path.join(root, 'recorder');
        // A no-network mcp-list-style probe: native discovery plus the CLI overlay.
        writeFileSync(recorder, `#!${process.execPath}\nconst fs=require('node:fs');const argv=process.argv.slice(2);const native=JSON.parse(fs.readFileSync('.mcp.json'));const at=argv.indexOf('--mcp-config');const overlay=at<0?{mcpServers:{}}:JSON.parse(fs.readFileSync(argv[at+1]));const servers={...(argv.includes('--strict-mcp-config')?{}:native.mcpServers),...overlay.mcpServers};fs.writeFileSync(process.env.S9E_RECORD,JSON.stringify({argv,env:process.env,tty:process.stdout.isTTY,servers,configText:at<0?'':fs.readFileSync(argv[at+1],'utf8'),instructions:fs.readFileSync(argv[argv.indexOf('--append-system-prompt-file')+1],'utf8'),plugin:argv.includes('--plugin-dir')?fs.readFileSync(require('node:path').join(argv[argv.indexOf('--plugin-dir')+1],'SKILL.md'),'utf8'):null}));\n`, { mode: 0o700 });
        const env = { HOME: root, S9E_RECORD: record, RAI_BRIDGE_TOKEN: secret, RAI_OWNER_TOKEN: secret, RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' };
        if (pathMode !== 'absent') env.PATH = pathMode === 'empty' ? '' : '/s9e-no-node';
        const session = createCliSession({ provider: 'claude', profile: { command: recorder, args: ['--model', 'native-model'] }, configDir: dir, bridgeDir: dir, cwd: root, env, spawn: pty.spawn });
        term = session.term;
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('PTY timeout')), 5000); term.onExit(({exitCode}) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('PTY exit '+exitCode)); }); });
        const actual = JSON.parse(readFileSync(record));
        if (process.env.S9E_EVIDENCE_DIR) writeFileSync(path.join(process.env.S9E_EVIDENCE_DIR, `${shape}-${pathMode}-argv.json`), JSON.stringify(actual, null, 2));
        assert.equal(actual.tty, true);
        assert.ok(!JSON.stringify(actual.argv).includes('--strict-mcp-config'), 'native MCP discovery must remain enabled');
        assert.ok(!actual.argv.includes('--no-chrome'), 'native Chrome integration must remain enabled');
        assert.ok(!JSON.stringify({argv:actual.argv,env:actual.env}).includes(secret), 'no bearer in argv/env');
        assert.equal(actual.env.PATH, env.PATH);
        assert.equal(Object.hasOwn(actual.env, 'PATH'), Object.hasOwn(env, 'PATH'));
        assert.deepEqual(actual.argv.slice(0,2), ['--model','native-model']);
        assert.equal(readFileSync(path.join(root, '.mcp.json'),'utf8'),nativeBytes);
        assert.deepEqual(actual.servers.rai, native.mcpServers.rai, 'user rai must remain native');
        assert.deepEqual(actual.servers.native, native.mcpServers.native);
        const config = JSON.parse(readFileSync(session.configPath));
        const names = Object.keys(config.mcpServers); assert.equal(names.length,1);
        const name = names[0]; assert.match(name, /^rai_studio_session_[a-f0-9]{32}$/);
        const index = actual.argv.indexOf('--allowedTools'); assert.ok(index>=0);
        const allowed=[];for(let i=index+1;i<actual.argv.length&&!actual.argv[i].startsWith('--');i++) allowed.push(actual.argv[i]);
        const connector=config.mcpServers[name];
        if (process.env.S9E_CHECK !== 'secret') {
          for (const text of [actual.instructions, actual.plugin]) {
            assert.doesNotMatch(text, /\{\{[^}]*\}\}/, 'S10e rendered no placeholders');
            assert.match(text, /read whole file first/i, 'S10e rendered read-first');
            assert.match(text, /raw, reference, data, environment, config and unknown/i, 'S10e rendered denied classes');
            assert.match(text, /deny wins/i, 'S10e rendered deny precedence');
            assert.match(text, /write_project_file/, 'S10e rendered disk tool');
            assert.doesNotMatch(text, /config files are editable/i, 'S10e rendered no config permission');

            assert.ok(text?.includes(`mcp__${name}__*`), 'instructions bind exact session namespace');
            assert.ok(!/`rai`|mcp__rai__|\{\{RAI_MCP_SERVER\}\}/.test(text), 'no bare rai instructions');
          }
        }
        if (process.env.S9E_CHECK !== 'instructions') {
          assert.ok(!actual.configText.includes(secret), 'no bearer in config');
          assert.ok(!JSON.stringify(connector.env).includes(secret), 'no bearer in connector env');
          const tokenPath = connector.env.RAI_BRIDGE_TOKEN_FILE;
          assert.equal(statSync(tokenPath).mode & 0o777, 0o600, 'token file owner only');
          assert.equal(statSync(path.dirname(tokenPath)).mode & 0o777, 0o700);
          assert.equal(readFileSync(tokenPath, 'utf8'), secret);
        }
        assert.deepEqual(actual.servers[name],connector,'RAI wiring survives native discovery');
        assert.equal(path.isAbsolute(connector.command),true);assert.equal(connector.command,process.execPath);
        const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'s9e',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_audit_workflow',arguments:{}}}];
        const fixture = path.join(root,'native-fixture.mjs');
        writeFileSync(fixture, `import {proofConfig} from ${JSON.stringify(new URL('./helpers/callback-proof-fixture.js',import.meta.url).href)};
let edits=0;
const config=proofConfig({token:${JSON.stringify(secret)},fetch:async url=>({ok:true,json:async()=>({
health:{session_id:'fixture-session',console_busy:false,console_epoch:'0',source_revision:'0'},
active_document:{document_id:'doc-a'},document:{document_id:'doc-a',contents:'42'},project_context:{project_active:true},
edit:{status:new URL(url).pathname==='/edit' && edits++===0?'approval_required':'applying'},debug:{run_id:'run-fixture'},
result:{run_id:'run-fixture',status:'unknown'},monitor:{run_id:'run-fixture',status:'unknown'},environment:{bindings:[]}
}[new URL(url).pathname.slice(1)])})});globalThis.fetch=config.fetch;`);
        for (const [name,args] of [
          ['audit_session',{action:'start'}],
          ['edit_document',{document_id:'doc-a',expected_text:'42',replacement:'43'}],
          ['edit_document',{document_id:'doc-a',expected_text:'42',replacement:'43'}],
          ['get_debug_info',{run_id:'run-fixture'}],['get_run_result',{run_id:'run-fixture'}],
          ['monitor_console_run',{run_id:'run-fixture',observation_ms:1000}],['get_environment_summary',{}]
        ]) requests.push({jsonrpc:'2.0',id:requests.length,method:'tools/call',params:{name,arguments:args}});
        const driver = `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
const child=spawn(process.argv[1],JSON.parse(process.argv[2]),{stdio:['pipe','pipe','inherit']});
const requests=JSON.parse(process.argv[3]);let at=0;
function next(){while(at<requests.length){const r=requests[at++];child.stdin.write(JSON.stringify(r)+'\\n');if(r.id!==undefined)return;}child.stdin.end();}
createInterface({input:child.stdout}).on('line',line=>{console.log(line);if(JSON.parse(line).id!==undefined)next();});child.on('exit',code=>process.exit(code??1));next();`;
        const child=spawnSync(process.execPath,['--input-type=module','-e',driver,connector.command,JSON.stringify(['--import',fixture,...connector.args]),JSON.stringify(requests)],{env:{...actual.env,...connector.env},encoding:'utf8',timeout:5000});
        assert.equal(child.status,0,child.stderr);
        const responses=child.stdout.split('\n').filter(Boolean).map(x=>JSON.parse(x));
        assert.ok(responses.find(x=>x.id===1)?.result?.serverInfo);
        for (const tool of responses.find(x=>x.id===2).result.tools.filter(t => ['edit_document','write_project_file'].includes(t.name))) {
          assert.match(tool.description, /read whole file first/i, 'S10e stdio description read-first');
          assert.match(tool.description, /code files only/i, 'S10e stdio description code-only');
        }
        const workflow = responses.find(x=>x.id===3)?.result;
        assert.ok(workflow && !workflow.isError, 'workflow tools/call succeeds');
        const workflowText = workflow.content.map(item=>item.text ?? '').join('\n');
        assert.ok(!/\{\{[^}]*\}\}/.test(workflowText), 'workflow has no unrendered placeholders');
        assert.ok(!/`rai`|mcp__rai__/.test(workflowText), 'workflow has no bare rai namespace');
        assert.ok(workflowText.includes(`mcp__${name}__*`), 'workflow binds exact session namespace');
        for (const request of requests.filter(x=>x.method==='tools/call' && x.id!==3)) {
          const response=responses.find(x=>x.id===request.id);
          assert.ok(response?.result && !response.error, `${request.params.name} tools/call succeeds`);
          assert.ok(!/\{\{[^}]*\}\}|`rai`|mcp__rai__/.test(JSON.stringify(response.result)), `${request.params.name} guidance has no namespace leaks`);
        }
        assert.ok(JSON.stringify(responses).includes('Poll edit_document'), 'edit polling guidance exercised');
        assert.ok(JSON.stringify(responses).includes('Automatic approval: the exact edit'), 'applying edit guidance exercised');
        assert.ok(JSON.stringify(responses).includes('diagnostic only'), 'audit debug guidance exercised');
        assert.ok(JSON.stringify(responses).includes('not an owned'), 'audit result guidance exercised');
        assert.ok(JSON.stringify(responses).includes('coverage incomplete'), 'audit monitor guidance exercised');
        const tools=responses.find(x=>x.id===2)?.result?.tools;assert.ok(tools?.length>0);
        assert.ok(!/\{\{[^}]*\}\}|`rai`|mcp__rai__/.test(JSON.stringify(tools)), 'tool instructions have no namespace leaks');
        const nativeChild = spawnSync(native.mcpServers.rai.command, native.mcpServers.rai.args, {env:actual.env,input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:5000});
        assert.equal(nativeChild.status,0,nativeChild.stderr);
        const nativeResponses = nativeChild.stdout.split('\n').filter(Boolean).map(x=>JSON.parse(x));
        assert.deepEqual(nativeResponses.find(x=>x.id===2).result.tools.map(t=>t.name), tools.map(t=>t.name), 'native rai exposes identical tool names');
        assert.deepEqual(allowed,tools.map(t=>`mcp__${name}__${t.name}`),'every approval binds only the actual connector');
        assert.ok(!allowed.some(t=>t.startsWith('mcp__rai__')),'user rai cannot masquerade as RAI');
        assert.ok(!child.stdout.includes(secret) && !child.stderr.includes(secret), 'no bearer in connector logs');
        if(process.env.S9E_EVIDENCE_DIR)writeFileSync(path.join(process.env.S9E_EVIDENCE_DIR,`${shape}-${pathMode}-mcp.json`),JSON.stringify({name,allowed,responses,exit:child.status},null,2));
        assert.equal(removeSessionMcpConfig(session.configPath, {configDir: dir}), true);
        assert.equal(existsSync(session.configPath), false);
        assert.equal(existsSync(`${session.configPath}.session`), false);
        assert.equal(existsSync(`${session.configPath}.instructions.md`), false);
      } finally { try { term?.kill(); } catch {} rmSync(root,{recursive:true,force:true}); }
    });
  }
}

const { requireNativeConfig } = await import('../rai-native-mcp.js');
test('Claude token file is read only inside connector and rejects unsafe files without disclosure', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 's9e-token-'));
  const tokenPath = path.join(root, 'token');
  const env = { RAI_BRIDGE_TOKEN_FILE: tokenPath, RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' };
  try {
    writeFileSync(tokenPath, secret, {mode: 0o600});
    assert.equal(requireNativeConfig(env).token, secret);
    assert.ok(!JSON.stringify(env).includes(secret));
    chmodSync(tokenPath, 0o644);
    assert.throws(() => requireNativeConfig(env), /^Error: RAI session token file is invalid$/);
    chmodSync(tokenPath, 0o600);
    const link = path.join(root, 'link'); symlinkSync(tokenPath, link);
    assert.throws(() => requireNativeConfig({...env, RAI_BRIDGE_TOKEN_FILE: link}), /token file is invalid/);
    rmSync(tokenPath);
    assert.throws(() => requireNativeConfig(env), /token file is invalid/);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
test('Claude spawn failure removes token instructions and plugin artifacts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 's9e-cleanup-'));
  try {
    assert.throws(() => createCliSession({provider:'claude',profile:{command:process.execPath,args:[]},configDir:root,
      env:{HOME:root,RAI_BRIDGE_TOKEN:secret,RAI_SESSION_HEALTH_URL:'http://127.0.0.1:19090/health'},
      spawn() { throw new Error('synthetic spawn failure'); }}), /synthetic spawn failure/);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
test('Claude stale session cleanup preserves active session directories', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 's9e-stale-'));
  try {
    const dead = path.join(root, 'mcp-99999999-dead.json.session'); mkdirSync(dead); writeFileSync(path.join(dead,'token'),secret,{mode:0o600});
    const active = path.join(root, `mcp-${process.pid}-active.json.session`); mkdirSync(active);
    const session = createCliSession({provider:'claude',profile:{command:process.execPath,args:[]},configDir:root,
      env:{HOME:root,RAI_BRIDGE_TOKEN:secret,RAI_SESSION_HEALTH_URL:'http://127.0.0.1:19090/health'},spawn(){return {};}});
    assert.equal(existsSync(dead),false); assert.equal(existsSync(active),true);
    removeSessionMcpConfig(session.configPath,{configDir:root});
    assert.deepEqual(readdirSync(root),[path.basename(active)]);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

const { renderSessionInstructions } = await import('../rai-audit-mcp.js');
test('session instruction renderer rejects interpolation and preserves literal text', () => {
  for (const name of ['x`inject', 'x\nrai', '${process.env.SECRET}', '$&', '{{other}}', '', 'a/b', 'rai;evil'])
    assert.throws(() => renderSessionInstructions('{{RAI_MCP_SERVER}}', name), /invalid RAI MCP server name/);
  assert.equal(renderSessionInstructions('$& `quoted` {{RAI_MCP_SERVER}} {{RAI_MCP_SERVER}}', 'rai_studio_session_abc'),
    '$& `quoted` mcp__rai_studio_session_abc__* mcp__rai_studio_session_abc__*');
});
