import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pty from 'node-pty';
import vm from 'node:vm';
const { createCliSession } = await import(process.env.S9D_MCP_MODULE || '../mcp.js');
const secret = 's9d-fixture-only-secret';
const native = { theme: 'native', permission: 'deny', instructions: ['native.md'], mcp: { rai: { type: 'local', command: ['user-server'] }, rai_studio: { enabled: false } } };
for (const [label, provider, content] of [
  ...['claude', 'codex', 'grok', 'opencode'].map(p => [p, p, undefined]),
  ['collision', 'opencode', JSON.stringify(native)],
  ...['{broken', 'null', '{"mcp":[]}', '{"instructions":"native.md"}'].map((v,i) => ['malformed-'+i, 'opencode', v])
]) test(`${label}: real PTY preserves user PATH and native configuration`, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 's9d-'));
  let term;
  const notices = []; const warn = console.warn;
  try {
    mkdirSync(path.join(dir, 'bin')); mkdirSync(path.join(dir, 'extra'));
    const other = process.execPath.includes('node@22') ? '/opt/homebrew/Cellar/node/26.5.0/bin/node' : '/opt/homebrew/Cellar/node@22/22.22.2_2/bin/node';
    const userNode = existsSync(other) ? other : process.execPath;
    symlinkSync(userNode, path.join(dir, 'bin/node'));
    const userPath = `${dir}/bin:${dir}/extra:/usr/bin:/bin`;
    const record = path.join(dir, 'record.json');
    const recorder = path.join(dir, 'recorder');
    writeFileSync(recorder, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.S9D_RECORD, JSON.stringify({argv:process.argv.slice(2),env:process.env,execPath:process.execPath,tty:process.stdout.isTTY}));\n', { mode: 0o700 });
    const nativeFile = path.join(dir, 'native.jsonc');
    const nativeBytes = '// native JSONC\n'+JSON.stringify(native); writeFileSync(nativeFile,nativeBytes);
    const env = { HOME: dir, PATH: userPath, S9D_RECORD: record, RAI_BRIDGE_TOKEN: secret, RAI_OWNER_TOKEN: secret, RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health', OPENCODE_CONFIG: nativeFile, ...(content === undefined ? {} : { OPENCODE_CONFIG_CONTENT: content }) };
    console.warn = msg => notices.push(msg);
    const session = createCliSession({ provider, profile: { command: recorder, args: ['native argument'] }, cwd: dir, configDir: dir, env, spawn: pty.spawn }); term = session.term;
    console.warn = warn;
    await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error('PTY timeout')),5000); term.onExit(({exitCode})=>{clearTimeout(timer);exitCode===0?resolve():reject(new Error('PTY exit '+exitCode));}); });
    const actual=JSON.parse(readFileSync(record));
    if (process.env.S9D_EVIDENCE_DIR) writeFileSync(path.join(process.env.S9D_EVIDENCE_DIR,label+'.json'),JSON.stringify({actual,notices},null,2));
    assert.equal(actual.tty,true);
    assert.equal(actual.env.PATH,userPath,'PATH byte exact');
    assert.equal(realpathSync(actual.execPath),realpathSync(userNode),'native shebang uses user Node');
    assert.equal(actual.argv[0],'native argument');
    assert.ok(!JSON.stringify(actual).includes(secret),'no bearer in argv/env');
    assert.equal(readFileSync(nativeFile,'utf8'),nativeBytes);
    if (provider !== 'opencode') return;
    assert.equal(actual.env.OPENCODE_CONFIG,nativeFile);
    if (label.startsWith('malformed')) {
      assert.equal(actual.env.OPENCODE_CONFIG_CONTENT,content,'malformed content unchanged');
      assert.equal(session.configPath,undefined);
      assert.match(notices.join('\n'),/RAI.*wiring.*skipped.*inline/i);
      const source = readFileSync(process.env.S9D_SERVER_FILE || new URL('../server.js', import.meta.url), 'utf8');
      const displayed = [], replay = [];
      const ws = { OPEN: 1, readyState: 1, send: bytes => displayed.push(bytes.toString()) };
      const context = { Buffer, console: { log() {}, error() {} },
        config: { provider, model: '', providers: { [provider]: { command: recorder } } }, CWD: dir,
        validateProfile: () => ({ ok: true }), requireBridgeToken() {}, commandExists: () => true,
        spawnCli: () => session, armCaffeinateGuard() {}, wireTerm() {}, sendToClient() {},
        store: { client: ws, clearOutput() { replay.length = 0; }, appendOutput(bytes) { replay.push(bytes.toString()); } } };
      vm.createContext(context);
      vm.runInContext(source.slice(source.indexOf('function start()'), source.indexOf('function startSignIn()')), context);
      assert.equal(context.start(), true);
      assert.match(displayed.join(''), /RAI.*wiring.*skipped.*inline/i, 'successful launch visibly reports skipped wiring');
      assert.deepEqual(replay, displayed, 'notice retained for reconnect replay');
      assert.ok(!displayed.join('').includes(secret));
      assert.ok(!displayed.join('').includes(content));
      return;
    }
    const inline=JSON.parse(actual.env.OPENCODE_CONFIG_CONTENT);
    if (content) { for (const key of Object.keys(native)) if(key!=='mcp' && key!=='instructions') assert.deepEqual(inline[key],native[key]);
      for(const [key,value] of Object.entries(native.mcp)) assert.deepEqual(inline.mcp[key],value,'native MCP preserved');
      assert.equal(inline.instructions[0],'native.md'); }
    const entries=Object.entries(inline.mcp).filter(([name])=>!Object.hasOwn(content?native.mcp:{},name));
    assert.equal(entries.length,1);
    const [name,connector]=entries[0];
    assert.match(name,/^rai_studio_session_[a-f0-9_]+$/);
    assert.equal(path.isAbsolute(connector.command[0]),true,'absolute connector Node');
    assert.equal(realpathSync(connector.command[0]),realpathSync(process.execPath));
    assert.match(connector.environment.RAI_BRIDGE_TOKEN,/^\{file:.+\.token\}$/);
    const tokenPath=connector.environment.RAI_BRIDGE_TOKEN.slice(6,-1);
    const child=spawnSync(connector.command[0],connector.command.slice(1),{env:{PATH:userPath,...connector.environment,RAI_BRIDGE_TOKEN:readFileSync(tokenPath,'utf8')},input:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'s9d',version:'1'}}})+'\n',encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr);
    const response=child.stdout.split('\n').filter(Boolean).map(x=>JSON.parse(x)).find(x=>x.id===1);
    assert.ok(response?.result?.serverInfo,'real connector initialize response');
    if (process.env.S9D_EVIDENCE_DIR) writeFileSync(path.join(process.env.S9D_EVIDENCE_DIR,label+'-initialize.json'),JSON.stringify({command:connector.command,userNode:actual.execPath,PATH:userPath,exit:child.status,response},null,2));
  } finally {console.warn=warn;try{term?.kill();}catch{} rmSync(dir,{recursive:true,force:true});}
});

const python = '/opt/homebrew/bin/python3';
function parseToml(overrides) {
  const parsed = spawnSync(python, ['-c', 'import sys,json\ntry: import tomllib\nexcept ImportError: import tomli as tomllib\nprint(json.dumps([tomllib.loads(s) for s in json.load(sys.stdin)]))'], {
    input: JSON.stringify(overrides), encoding: 'utf8', timeout: 5000
  });
  assert.equal(parsed.status, 0, `TOML parse: ${parsed.stderr}`);
  return JSON.parse(parsed.stdout);
}

for (const provider of ['claude', 'codex', 'opencode']) {
  for (const [shape, leaf] of Object.entries({ space: 'space directory', quote: 'single\'double"', backslash: 'back\\slash', unicode: '日本語=]' })) {
    for (const pathMode of ['absent', 'empty', 'foreign']) {
      test(`connector matrix ${provider} ${shape} ${pathMode}`, async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 's9d-fix1-'));
        const dir = path.join(root, leaf);
        mkdirSync(dir);
        const record = path.join(root, 'record.json');
        const recorder = path.join(root, 'recorder');
        writeFileSync(recorder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.S9D_RECORD, JSON.stringify({argv:process.argv.slice(2),env:process.env,tty:process.stdout.isTTY}));\n`, { mode: 0o700 });
        const env = { HOME: root, S9D_RECORD: record, RAI_BRIDGE_TOKEN: secret, RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' };
        if (pathMode !== 'absent') env.PATH = pathMode === 'empty' ? '' : '/s9d-no-node';
        let term;
        try {
          // Resolve the adapter through a special-character path as well as the config directory.
          symlinkSync(new URL('../rai-native-mcp.js', import.meta.url).pathname, path.join(dir, 'rai-native-mcp.js'));
          const session = createCliSession({ provider, profile: { command: recorder, args: [] }, cwd: root,
            configDir: dir, bridgeDir: dir, env, spawn: pty.spawn });
          term = session.term;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('PTY timeout')), 5000);
            term.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error(`PTY exit ${exitCode}`)); });
          });
          const actual = JSON.parse(readFileSync(record, 'utf8'));
          assert.equal(actual.tty, true);
          assert.equal(Object.hasOwn(actual.env, 'PATH'), Object.hasOwn(env, 'PATH'), 'PATH presence exact');
          assert.equal(actual.env.PATH, env.PATH, 'PATH byte exact');
          assert.ok(!JSON.stringify(actual).includes(secret), 'native argv/env contain no bearer');
          let command, args, connectorEnv = {}, config;
          if (provider === 'claude') {
            const configPath = actual.argv[actual.argv.indexOf('--mcp-config') + 1];
            assert.equal(configPath, session.configPath);
            config = JSON.parse(readFileSync(configPath, 'utf8'));
            ({ command, args, env: connectorEnv } = Object.values(config.mcpServers)[0]);
          } else if (provider === 'codex') {
            const overrides = actual.argv.flatMap((arg, i) => arg === '-c' ? [actual.argv[i + 1]] : []);
            config = parseToml(overrides);
            const serverName = Object.keys(config.find(value => value.mcp_servers && Object.values(value.mcp_servers).some(server => server.command)).mcp_servers)[0];
            const rai = config.find(value => value.mcp_servers?.[serverName]?.command)?.mcp_servers[serverName];
            connectorEnv = config.find(value => value.mcp_servers?.[serverName]?.env)?.mcp_servers[serverName].env;
            command = rai?.command;
            args = config.find(value => value.mcp_servers?.[serverName]?.args)?.mcp_servers[serverName].args;
            assert.equal(command, session.configPath, 'TOML wrapper path round-trip');
            assert.match(readFileSync(command, 'utf8'), /\nexec /);
          } else {
            config = JSON.parse(actual.env.OPENCODE_CONFIG_CONTENT);
            const connector = Object.values(config.mcp)[0];
            [command, ...args] = connector.command;
            connectorEnv = { ...connector.environment };
            const reference = connectorEnv.RAI_BRIDGE_TOKEN;
            assert.match(reference, /^\{file:.+\}$/);
            connectorEnv.RAI_BRIDGE_TOKEN = readFileSync(reference.slice(6, -1), 'utf8');
          }
          assert.ok(path.isAbsolute(command), 'absolute connector command');
          if (provider !== 'codex') assert.equal(realpathSync(command), realpathSync(process.execPath), 'absolute current Node');
          const requests = [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's9d-fix1', version: '1' } } },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
          ];
          const child = spawnSync(command, args, { env: { ...actual.env, ...connectorEnv },
            input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8', timeout: 5000 });
          assert.equal(child.error, undefined, String(child.error));
          assert.equal(child.status, 0, child.stderr);
          const responses = child.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
          assert.ok(responses.find(response => response.id === 1)?.result?.serverInfo, 'real initialize');
          assert.ok(responses.find(response => response.id === 2)?.result?.tools?.length > 0, 'real tools/list');
          if (process.env.S9D_EVIDENCE_DIR) writeFileSync(path.join(process.env.S9D_EVIDENCE_DIR, `${provider}-${shape}-${pathMode}.json`),
            JSON.stringify({ actual, config, command, args, exit: child.status, responses }, null, 2));
        } finally {
          try { term?.kill(); } catch {}
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

test('Codex TOML strings round-trip all controls and special paths', async () => {
  const { buildMcpArgs } = await import(process.env.S9D_MCP_MODULE || '../mcp.js');
  const value = 'space "quote" \\ 日本語=]' + Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f';
  const args = buildMcpArgs('codex', value);
  assert.equal(parseToml([args[1]])[0].mcp_servers.rai.command, value);
});
