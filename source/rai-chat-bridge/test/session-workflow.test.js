import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pty from 'node-pty';
const { createCliSession } = await import(process.env.S9E_MCP_MODULE || '../mcp.js');
const connectorModule = process.env.S9E_CONNECTOR_MODULE || new URL('../rai-native-mcp.js', import.meta.url).pathname;
function call(command, args, env) {
  const requests = [
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fix3',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_audit_workflow',arguments:{}}}
  ];
  const driver = `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
const child=spawn(process.argv[1],JSON.parse(process.argv[2]),{stdio:['pipe','pipe','inherit']});
const requests=JSON.parse(process.argv[3]);let at=0;
function next(){while(at<requests.length){const r=requests[at++];child.stdin.write(JSON.stringify(r)+'\\n');if(r.id!==undefined)return;}child.stdin.end();}
createInterface({input:child.stdout}).on('line',line=>{console.log(line);if(JSON.parse(line).id!==undefined)next();});child.on('exit',code=>process.exit(code??1));next();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',driver,command,JSON.stringify(args),JSON.stringify(requests)],{env,encoding:'utf8',timeout:5000});
  assert.equal(child.status,0,child.stderr);
  const responses=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(responses.find(r=>r.id===2)?.result?.tools.some(t=>t.name==='get_audit_workflow'));
  return responses.find(r=>r.id===3);
}
for (const provider of ['opencode','codex','claude']) test(`session workflow recorded ${provider} with native rai`, async () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'s9e-fix3-')); let term;
  try {
    const nativeScript=path.join(root,'native-rai.cjs');
    writeFileSync(nativeScript, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='tools/list'?{tools:[{name:'get_audit_workflow',inputSchema:{type:'object'}}]}:{serverInfo:{name:'native-rai',version:'1'}}}));});`);
    const native={command:process.execPath,args:[nativeScript]};
    const nativeBytes=JSON.stringify({mcpServers:{rai:native},mcp:{rai:{type:'local',command:[native.command,...native.args]}}});
    writeFileSync(path.join(root,'native.json'),nativeBytes);
    writeFileSync(path.join(root,'.mcp.json'),JSON.stringify({mcpServers:{rai:native}}));
    writeFileSync(path.join(root,'opencode.json'),JSON.stringify({mcp:{rai:{type:'local',command:[native.command,...native.args]}}}));
    mkdirSync(path.join(root,'.codex'));
    const codexNative=`[mcp_servers.rai]\ncommand=${JSON.stringify(native.command)}\nargs=${JSON.stringify(native.args)}\n`;
    writeFileSync(path.join(root,'.codex/config.toml'),codexNative);
    const recorder=path.join(root,'recorder'); const record=path.join(root,'record.json');
    writeFileSync(recorder,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.RECORD,JSON.stringify({argv:process.argv.slice(2),env:process.env,tty:process.stdout.isTTY,native:JSON.parse(fs.readFileSync('native.json'))}));\n`,{mode:0o700});
    const env={HOME:root,PATH:process.env.PATH,RECORD:record,RAI_BRIDGE_TOKEN:'synthetic-fix3',RAI_SESSION_HEALTH_URL:'http://127.0.0.1:19090/health',OPENCODE_CONFIG_CONTENT:JSON.stringify({mcp:{rai:{type:'local',command:[native.command,...native.args]}}})};
    const session=createCliSession({provider,profile:{command:recorder,args:[]},configDir:root,cwd:root,env,spawn:pty.spawn});term=session.term;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PTY timeout')),5000);term.onExit(({exitCode})=>{clearTimeout(timer);exitCode===0?resolve():reject(Error('PTY exit '+exitCode));});});
    const actual=JSON.parse(readFileSync(record)); assert.equal(actual.tty,true);
    let name,command,args,connectorEnv={};
    if(provider==='opencode') {
      const config=JSON.parse(actual.env.OPENCODE_CONFIG_CONTENT);assert.deepEqual(config.mcp.rai,actual.native.mcp.rai);
      [name]=Object.keys(config.mcp).filter(n=>n!=='rai');const c=config.mcp[name];[command,...args]=c.command;connectorEnv={...c.environment};
      connectorEnv.RAI_BRIDGE_TOKEN=readFileSync(connectorEnv.RAI_BRIDGE_TOKEN.slice(6,-1),'utf8');
    } else if(provider==='claude') {
      const config=JSON.parse(readFileSync(actual.argv[actual.argv.indexOf('--mcp-config')+1]));[name]=Object.keys(config.mcpServers);({command,args,env:connectorEnv}=config.mcpServers[name]);
    } else {
      const overrides=actual.argv.flatMap((v,i)=>v==='-c'?[actual.argv[i+1]]:[]);
      const parsed=spawnSync('/opt/homebrew/bin/python3',['-c','import tomllib,json,sys; print(json.dumps([tomllib.loads(s) for s in json.load(sys.stdin)]))'],{input:JSON.stringify(overrides),encoding:'utf8'});
      assert.equal(parsed.status,0,parsed.stderr);const configs=JSON.parse(parsed.stdout);
      const c=configs.find(c=>Object.values(c.mcp_servers||{}).some(s=>s.command));[name]=Object.keys(c.mcp_servers);command=c.mcp_servers[name].command;
      args=configs.find(c=>c.mcp_servers?.[name]?.args)?.mcp_servers[name].args;
      connectorEnv=configs.find(c=>c.mcp_servers?.[name]?.env)?.mcp_servers[name].env || {};
    }
    const response=call(command,args,{...actual.env,...connectorEnv});
    assert.ok(response.result && !response.result.isError,'workflow succeeds');
    const text=JSON.stringify(response.result);
            assert.match(text, /read whole file first/i, 'S10e rendered read-first');
            assert.match(text, /raw, reference, data, environment, config and unknown/i, 'S10e rendered denied classes');
            assert.match(text, /deny wins/i, 'S10e rendered deny precedence');
            assert.match(text, /write_project_file/, 'S10e rendered disk tool');
            assert.doesNotMatch(text, /config files are editable/i, 'S10e rendered no config permission');

    assert.ok(!/mcp__rai__|\{\{RAI_MCP_SERVER\}\}/.test(text),'workflow has no bare rai namespace');
    assert.match(name,/^rai_studio_session_/,'session namespace avoids native rai');
    assert.equal(connectorEnv.RAI_MCP_SERVER_NAME,name,'recorded connector env names session');
    assert.ok(text.includes(provider==='opencode'?name:`mcp__${name}__*`),'workflow binds recorded namespace');
    if (provider==='opencode') assert.ok(!text.includes(`mcp__${name}__*`),'OpenCode workflow names the server, not the Claude tool form');
    assert.equal(readFileSync(path.join(root,'native.json'),'utf8'),nativeBytes);
    assert.equal(readFileSync(path.join(root,'.codex/config.toml'),'utf8'),codexNative);
    const nativeChild=spawnSync(actual.native.mcpServers.rai.command,actual.native.mcpServers.rai.args,{env:actual.env,input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n',encoding:'utf8',timeout:5000});
    assert.equal(nativeChild.status,0,nativeChild.stderr);
    assert.equal(JSON.parse(nativeChild.stdout).result.tools[0].name,'get_audit_workflow','native rai exposes the colliding tool');
    if(process.env.S9E_EVIDENCE_DIR) writeFileSync(path.join(process.env.S9E_EVIDENCE_DIR,provider+'-workflow.json'),JSON.stringify({actual,name,command,args,connectorEnv,response},null,2));
  } finally {try{term?.kill();}catch{}rmSync(root,{recursive:true,force:true});}
});
test('session workflow missing namespace fails closed',()=>{
  const response=call(process.execPath,[connectorModule],{PATH:process.env.PATH,RAI_BRIDGE_TOKEN:'synthetic-fix3',RAI_SESSION_HEALTH_URL:'http://127.0.0.1:19090/health'});
  assert.ok(response.error || response.result?.isError,'missing namespace must fail closed');
  assert.match(JSON.stringify(response),/RAI_MCP_SERVER_NAME.*required/);
  assert.ok(!/mcp__rai__|\{\{RAI_MCP_SERVER\}\}/.test(JSON.stringify(response)));
});
test('explicit bare rai registration supports legacy connectors',()=>{
 const response=call(process.execPath,[connectorModule],{PATH:process.env.PATH,RAI_BRIDGE_TOKEN:'synthetic-fix3',RAI_SESSION_HEALTH_URL:'http://127.0.0.1:19090/health',RAI_MCP_SERVER_NAME:'rai'});
 assert.ok(response.result && !response.result.isError);assert.ok(JSON.stringify(response).includes('mcp__rai__*'));
});
