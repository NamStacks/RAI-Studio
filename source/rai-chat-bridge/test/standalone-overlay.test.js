import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const bridge = new URL('../', import.meta.url).pathname;
const launcher = process.env.S9E_LAUNCH_MODULE || path.join(bridge, 'generate-launch.js');
const token = 'synthetic-fix4-bearer';
const sentinels = { RAI_BRIDGE_TOKEN: token, RAI_OWNER_TOKEN: token, INHERITED_SECRET: 'fix4-private-secret', RSESSION_SENTINEL: 'fix4-rsession-only', RAI_MCP_SERVER_NAME: 'inherited_wrong_namespace' };

function workflow(command, args, env) {
  const driver = `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
const child=spawn(process.argv[1],JSON.parse(process.argv[2]),{stdio:['pipe','pipe','inherit']});
const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fix4',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_audit_workflow',arguments:{}}}];let at=0;
function next(){while(at<requests.length){const r=requests[at++];child.stdin.write(JSON.stringify(r)+'\\n');if(r.id!==undefined)return;}child.stdin.end();}
createInterface({input:child.stdout}).on('line',line=>{console.log(line);if(JSON.parse(line).id!==undefined)next();});child.on('exit',code=>process.exit(code??1));next();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver, command, JSON.stringify(args)], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(JSON.parse).find(r => r.id === 2);
}

for (const provider of ['opencode', 'claude', 'codex']) test(`standalone overlay ${provider}`, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fix4-quote'-$()-"));
  try {
    const configDir = path.join(root, '.raistudio');
    mkdirSync(configDir);
    const record = path.join(root, 'record.json');
    const recorder = path.join(root, "recorder ' $().cjs");
    writeFileSync(recorder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:process.argv.slice(2),env:process.env}));\n`, { mode: 0o700 });
    const native = { type: 'local', command: ['native-rai', "literal ' $(touch INJECTED)\nnext"] };
    const inline = { mcp: { rai: native }, instructions: ["native ' $(touch INJECTED)\nnotes"] };
    const configured = ['--', "literal ' $(touch INJECTED)\ntail"];
    writeFileSync(path.join(configDir, 'assistant.json'), JSON.stringify({ provider, providers: { [provider]: { command: recorder, args: configured } } }));
    const generated = spawnSync(process.execPath, [launcher], { cwd: bridge, env: {
      HOME: root, PATH: process.env.PATH, ...sentinels,
      RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health', RAI_BRIDGE_CWD: root,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(inline)
    }, encoding: 'utf8', timeout: 10000 });
    assert.equal(generated.status, 0, generated.stderr);
    for (const [key, value] of Object.entries(sentinels)) {
      assert.ok(!generated.stdout.includes(value), `script excludes inherited value ${key}`);
      if (!['RAI_BRIDGE_TOKEN', 'RAI_MCP_SERVER_NAME'].includes(key)) assert.ok(!generated.stdout.includes(key), `script excludes inherited key ${key}`);
    }
    const script = path.join(root, 'launch.sh');
    writeFileSync(script, generated.stdout, { mode: 0o700 });
    assert.equal(statSync(script).mode & 0o777, 0o700);
    // Terminal.app starts from its own login environment, not the generator's rsession
    const launched = spawnSync('/bin/sh', [script], { env: { HOME: root, PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000 });
    assert.equal(launched.status, 0, launched.stderr);
    const actual = JSON.parse(readFileSync(record));
    for (const key of Object.keys(sentinels)) assert.equal(actual.env[key], undefined, `child excludes ${key}`);
    assert.deepEqual(actual.argv.slice(-configured.length), configured, 'native argv unchanged');
    assert.equal(existsSync(path.join(root, 'INJECTED')), false, 'shell text stays literal');
    let response, name;
    if (provider === 'opencode') {
      assert.ok(actual.env.OPENCODE_CONFIG_CONTENT, 'OpenCode receives overlay');
      const overlay = JSON.parse(actual.env.OPENCODE_CONFIG_CONTENT);
      assert.deepEqual(overlay.mcp.rai, native, 'native rai preserved');
      assert.equal(overlay.instructions[0], inline.instructions[0]);
      [name] = Object.keys(overlay.mcp).filter(key => key !== 'rai');
      assert.match(name, /^rai_studio_session_/);
      const connector = overlay.mcp[name];
      assert.equal(connector.environment.RAI_MCP_SERVER_NAME, name);
      const reference = connector.environment.RAI_BRIDGE_TOKEN;
      assert.match(reference, /^\{file:.+\}$/);
      const tokenFile = reference.slice(6, -1);
      assert.equal(readFileSync(tokenFile, 'utf8'), token);
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      const [command, ...args] = connector.command;
      response = workflow(command, args, { ...actual.env, ...connector.environment, RAI_BRIDGE_TOKEN: readFileSync(tokenFile, 'utf8') });
      assert.ok(response.result && !response.result.isError, 'workflow succeeds');
      assert.ok(JSON.stringify(response.result).includes(`mcp__${name}__*`), 'workflow binds recorded namespace');
      assert.doesNotMatch(JSON.stringify(response), /mcp__rai__|\{\{RAI_MCP_SERVER\}\}/);
    } else {
      assert.equal(actual.env.OPENCODE_CONFIG_CONTENT, undefined);
      assert.equal(generated.stdout.split('\n').filter(line => line.startsWith('export ')).length, 0);
      const flag = provider === 'claude' ? '--mcp-config' : '-c';
      assert.ok(actual.argv.includes(flag), 'existing connector argv retained');
      assert.ok(readdirSync(configDir).some(file => file.startsWith('mcp-')));
    }
    assert.equal(readFileSync(script, 'utf8'), generated.stdout);
    if (process.env.S9E_EVIDENCE_DIR) writeFileSync(path.join(process.env.S9E_EVIDENCE_DIR, provider + '-standalone.json'), JSON.stringify({ script: generated.stdout, actual, name, response }, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, 'temporary scripts and session files cleaned');
  }
});
