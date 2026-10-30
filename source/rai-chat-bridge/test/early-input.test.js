import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import * as pty from 'node-pty';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { DEFAULT_CONFIG } from '../config.js';
import { proofNativeServer } from './helpers/callback-proof-fixture.js';

const bridge = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), label);
}
async function fixture(run, { initDelay = 0, silent = false, exitEarly = false, spawnFailure = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's9c-input-'));
  const record = path.join(dir, 'record');
  const cli = path.join(dir, 'recorder');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(path.join(dir,'spawned'))},'');\nsetTimeout(()=>{process.stdin.setRawMode(true);\nconst name=${JSON.stringify(record)}+'.'+process.pid;\nfs.writeFileSync(name,Buffer.alloc(0));\nprocess.stdin.on('data',b=>fs.appendFileSync(name,b));\nif(!${silent})process.stdout.write('RECORDER_READY:'+process.pid+'\\n'+'GRID:'+process.stdout.columns+'x'+process.stdout.rows+'\\n');\nprocess.stdout.on('resize',()=>process.stdout.write('GRID:'+process.stdout.columns+'x'+process.stdout.rows+'\\n'));\n},${initDelay});\n${exitEarly ? 'setTimeout(()=>process.exit(0),100);' : ''}\nsetTimeout(()=>process.exit(0),20000);\n`, {mode:0o700});
  if (spawnFailure) fs.unlinkSync(cli);
  let release, entered = false;
  const blocked = new Promise(r => { release = r; });
  const native = createServer(proofNativeServer('s9c-test-token', async (req,res) => {
    entered = true; await blocked;
    const settings = structuredClone(DEFAULT_CONFIG);
    settings.providers.claude.command = cli; settings.caffeinate = false;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({status:'ok',settings,settings_revision:'s9c-r1'}));
  }));
  let child;
  const sockets = [];
  try {
    await new Promise((resolve,reject) => { native.once('error',reject);native.listen(0,'127.0.0.1',resolve); });
    const reservation = createServer();
    await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
    const reservedPort=reservation.address().port;
    await new Promise(r=>reservation.close(r));
    child = spawn(process.execPath,[process.env.S9C_SERVER_FILE || 'server.js'], {cwd:bridge,
      env:{...process.env,HOME:dir,RAI_BRIDGE_DIR:dir,RAI_BRIDGE_PORT:String(reservedPort),RAI_BRIDGE_CWD:dir,
        RAI_BRIDGE_TOKEN:'s9c-test-token',RAI_SESSION_HEALTH_URL:`http://127.0.0.1:${native.address().port}/health`},stdio:['ignore','pipe','pipe']});
    let log = '';child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
    await until(()=>/listening on http:\/\/127.0.0.1:(\d+)/.test(log) || child.exitCode !== null,'bridge starts: '+log);
    assert.equal(child.exitCode,null,log);
    const port = log.match(/listening on http:\/\/127.0.0.1:(\d+)/)[1];
    const url = `http://127.0.0.1:${port}`;
    const html = await (await fetch(url)).text();
    const token = html.match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)[1];
    async function connect() {
      const ws = new WebSocket(url.replace('http','ws')+'/pty?token='+token,{origin:url});
      ws.output = '';ws.controls = [];ws.on('message',(b,binary)=>{if(binary)ws.output+=b.toString();else ws.controls.push(JSON.parse(b));});
      sockets.push(ws);await once(ws,'open');return ws;
    }
    const ws = await connect();
    await until(()=>entered,'native read entered');
    const send = (socket,data,binary=false) => socket.send(JSON.stringify({type:'input',data}),{binary});
    const files = () => fs.readdirSync(dir).filter(n=>n.startsWith('record.')).map(n=>path.join(dir,n));
    const bytes = () => Buffer.concat(files().map(n=>fs.readFileSync(n)));
    const barrier = async socket => { const pong = once(socket,'pong');socket.ping();await pong; };
    await run({ws,connect,send,release,files,bytes,barrier,dir,cli});
  } finally {
    release();for(const ws of sockets)ws.terminate();
    for(const name of fs.readdirSync(dir).filter(n=>n.startsWith('record.'))) {
      try { process.kill(Number(name.slice('record.'.length)), 'SIGKILL'); } catch {}
    }
    if(child?.exitCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
    native.closeAllConnections();await new Promise(r=>native.close(r));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('early typed and bracketed paste bytes arrive in order exactly once, binary JSON and control frames survive', {timeout:15000}, async()=>fixture(async f=>{
  const expected = 'typedé\x00\x1b[A\n\x1b[200~paste one\npaste two\x1b[201~\n';
  f.send(f.ws,'typedé\x00\x1b[A\n');f.send(f.ws,'\x1b[200~paste one\npaste two\x1b[201~\n',true);
  f.ws.send(JSON.stringify({type:'resize',cols:71,rows:23}));
  f.ws.send(JSON.stringify({type:'resize',cols:73,rows:27}));
  await f.barrier(f.ws);f.release();
  await until(()=>f.ws.output.includes('RECORDER_READY:'),'recorder ready');
  assert.ok(f.ws.output.includes('GRID:73x27'),'latest pending resize at spawn');
  await until(()=>f.bytes().length>=Buffer.byteLength(expected),'queued bytes reach real PTY');
  await delay(100);assert.equal(f.bytes().toString(),expected);
  f.send(f.ws,'\x03\x1b[A\x00',true);
  await until(()=>f.bytes().length===Buffer.byteLength(expected)+5,'raw controls');
  assert.deepEqual(f.bytes(),Buffer.from(expected+'\x03\x1b[A\x00'));
  f.ws.send(JSON.stringify({type:'resize',cols:74,rows:28}));
  await until(()=>f.ws.output.includes('GRID:74x28'),'ready resize');
}));
for (const action of ['restart','stop','sign_in','close','replace']) {
  test(`pending input cleared on ${action}, never replayed into another session/client`, {timeout:15000}, async()=>fixture(async f=>{
    f.send(f.ws,'STALE\n');await f.barrier(f.ws);
    let ws=f.ws;
    if(action==='close'){const closed=once(ws,'close');ws.close();await closed;ws=await f.connect();}
    else if(action==='replace')ws=await f.connect();
    else ws.send(JSON.stringify({type:action}));
    await f.barrier(ws);f.release();
    if(action==='stop') {
      await delay(150);assert.equal(f.files().length,0,'stop invalidates deferred start');
      ws.send(JSON.stringify({type:'restart'}));
    }
    await until(()=>ws.output.includes('RECORDER_READY:'),'new recorder ready');
    assert.equal(f.bytes().toString(),'','old input discarded');
    f.send(ws,'FRESH\n');await until(()=>f.bytes().toString()==='FRESH\n','only new input delivered');
    await delay(100);assert.equal(f.bytes().toString(),'FRESH\n');
  }));
}
for (const limit of ['bytes','frames']) {
  test(`pending input ${limit} overflow explicitly closes, cancels startup and drops no silent tail`, {timeout:15000}, async()=>fixture(async f=>{
    const closed=once(f.ws,'close');
    if(limit==='bytes') f.send(f.ws,'x'.repeat(1024*1024+1));
    else for(let i=0;i<1025;i++)f.send(f.ws,'');
    let timer;
    let result;
    try { result=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('input queue overflow did not close')),3000);})]); }
    finally { clearTimeout(timer); }
    const [code,reason]=result;
    assert.equal(code,1009);assert.match(reason.toString(),/input queue/i);
    f.release();await delay(150);assert.equal(f.files().length,0);
  }));
}


for (const silent of [false, true]) {
  test(`delayed raw initialization preserves early CR DEL Ctrl-C and newline-free paste (${silent ? 'deadline' : 'output'})`, {timeout:15000}, async()=>fixture(async f=>{
    const early = 'a\rb\x7fc\x03';
    const paste = 'pasteé'.repeat(20000);
    f.send(f.ws,early);await f.barrier(f.ws);f.release();
    // Send more while the child is spawned but has not initialized its terminal.
    await until(()=>fs.existsSync(path.join(f.dir,'spawned')),'child spawned before late input');f.send(f.ws,paste,true);await f.barrier(f.ws);
    await until(()=>f.bytes().length===Buffer.byteLength(early+paste),'byte-exact delayed initialization');
    assert.deepEqual(f.bytes(),Buffer.from(early+paste));
    await delay(100);assert.deepEqual(f.bytes(),Buffer.from(early+paste));
  }, {initDelay:300,silent}));
}

test('spawn failure discards queued input with explicit notice and permits a clean restart', {timeout:15000}, async()=>fixture(async f=>{
  f.send(f.ws,'STALE\r\x7f\x03');await f.barrier(f.ws);f.release();
  await until(()=>f.ws.controls.some(c=>c.type==='launch_failed'),'explicit spawn failure');
  assert.equal(f.files().length,0,'no recorder spawned');
  fs.writeFileSync(f.cli,`#!${process.execPath}\nconst fs=require('node:fs');process.stdin.setRawMode(true);const n=${JSON.stringify(path.join(f.dir,'record'))}+'.'+process.pid;fs.writeFileSync(n,'');process.stdin.on('data',b=>fs.appendFileSync(n,b));process.stdout.write('RECORDER_READY');setTimeout(()=>{},20000);\n`,{mode:0o700});
  f.ws.send(JSON.stringify({type:'restart'}));await until(()=>f.ws.output.includes('RECORDER_READY'),'restart after failure');
  f.send(f.ws,'FRESH');await until(()=>f.bytes().length>=5,'fresh input after failure');
  assert.equal(f.bytes().toString(),'FRESH','failed queue discarded');
}, {spawnFailure:true}));

test('exit before readiness discards queue without flushing into the next session', {timeout:15000}, async()=>fixture(async f=>{
  f.send(f.ws,'STALE');await f.barrier(f.ws);f.release();
  await until(()=>f.ws.controls.some(c=>c.type==='exit'),'exit before ready');
  assert.equal(f.bytes().length,0);
  assert.ok(!f.ws.output.includes('STALE'),'no pre-ready input flushed to exiting cooked PTY');
  fs.writeFileSync(f.cli,`#!${process.execPath}\nconst fs=require('node:fs');process.stdin.setRawMode(true);const n=${JSON.stringify(path.join(f.dir,'record'))}+'.'+process.pid;fs.writeFileSync(n,'');process.stdin.on('data',b=>fs.appendFileSync(n,b));process.stdout.write('RECORDER_READY');setTimeout(()=>{},20000);\n`,{mode:0o700});
  f.ws.send(JSON.stringify({type:'restart'}));
  await until(()=>f.ws.output.includes('RECORDER_READY'),'replacement ready');
  f.send(f.ws,'FRESH');await until(()=>f.bytes().length>=5,'replacement input');
  await delay(1100);assert.equal(f.bytes().toString(),'FRESH','no stale deadline flush');
}, {initDelay:1000,exitEarly:true}));


function readinessFixture() {
  const source = fs.readFileSync(process.env.S9C_SERVER_FILE || path.join(bridge,'server.js'),'utf8');
  const writes=[], notices=[], timers=[];
  let connect;
  const ws={OPEN:1,readyState:1,send:()=>{},close:()=>{}};
  const store={attach(ws){const old=this.client;this.client=ws;return old;},detach(ws){if(this.client===ws)this.client=null;},snapshotOutput:()=>null,busy:false,clearOutput:()=>{},client:ws,term:null,appendOutput:()=>{},noteActivity:()=>{},cancelReap:()=>{}};
  const context={Buffer,console,store,wss:{on:(event,fn)=>{connect=fn;}},server:{listen:()=>{}},HOST:'127.0.0.1',PORT:0,pty:{spawn:()=>{}},terminalSize:{cols:80,rows:24},config:{provider:'claude',model:'test',providers:{claude:{command:'recorder',authMode:'oauth'}}},CWD:'/tmp',activeModels:new Map(),
    ActiveModelTracker:class {noteInput(){} observe(){}},removeTermConfig:()=>{},sendStatus:()=>{},
    sendToClient:n=>notices.push(n),canonicalSettingsReady:true,
    setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;},
    runInspector:{reset:()=>{},get:()=>({})},stopTerm:()=>context.clearPendingInput(),
    validateProfile:()=>({ok:true}),requireBridgeToken:()=>{},commandExists:()=>true,armCaffeinateGuard:()=>{},
    BridgeConfigError:class extends Error {},startSignIn:()=>false};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const INPUT_QUEUE_BYTES'),source.indexOf('function stopTerm(')),context);
  vm.runInContext(source.slice(source.indexOf('function wireTerm('),source.indexOf('\nfunction start()')),context);
  vm.runInContext(source.slice(source.indexOf('function start()'),source.indexOf('function startSignIn()')),context);
  vm.runInContext(source.slice(source.indexOf('function startSignIn()'),source.indexOf("wss.on('connection'")),context);
  vm.runInContext(source.slice(source.indexOf("wss.on('connection'")),context);
  let data,exit;
  const term={pid:1,resize:()=>{},write:b=>writes.push(b),onData:f=>{data=f;},onExit:f=>{exit=f;}};
  function queue(value) {vm.runInContext('pendingInput = {ws:store.client,frames:[testData],bytes:Buffer.byteLength(testData)}',Object.assign(context,{testData:value}));}
  function wire(t=term,login=false){context.spawnCli=()=>({term:t});context.createProviderLoginSession=()=>t;if(login)context.startSignIn();else context.start();}
  return {context,store,ws,term,writes,notices,timers,queue,wire,
    socket(){const handlers={};const socket={...ws,on:(event,fn)=>{handlers[event]=fn;}};connect(socket);return {send:data=>handlers.message(Buffer.from(JSON.stringify({type:'input',data}))),close:()=>handlers.close()};},data:b=>data(b),exit:()=>exit({exitCode:0,signal:0}),
    pending:()=>vm.runInContext('pendingInput',context),deadline(){for(const t of timers.splice(0))if(!t.cancelled)t.fn();}};
}

for (const silent of [false,true]) test(`socket-free real PTY delayed raw bytes (${silent?'deadline':'output'})`,{timeout:10000},async()=>{
  const f=readinessFixture();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s9c-raw-'));
  const record=path.join(dir,'bytes');
  const script=`import os,tty,time\ntime.sleep(.3)\ntty.setraw(0)\n${silent?'':"os.write(1,b'READY')"}\nwith open(${JSON.stringify(record)},'wb',buffering=0) as f:\n while True:\n  f.write(os.read(0,65536))\n`;
  const term=pty.spawn('/usr/bin/python3',['-c',script],{cols:80,rows:24,env:process.env});
  const expected='a\rb\x7fc\x03'+'pasteé'.repeat(20000);
  try {
    f.queue(expected);f.wire(term);
    if(silent){await delay(1100);f.deadline();}
    await until(()=>fs.existsSync(record)&&fs.statSync(record).size===Buffer.byteLength(expected),'byte-exact real PTY delayed raw');
    assert.deepEqual(fs.readFileSync(record),Buffer.from(expected));
  } finally {term.kill();fs.rmSync(dir,{recursive:true,force:true});}
});

test('socket-free readiness lifecycle: exit discards pending bytes and cancels deadline',()=>{
  const f=readinessFixture();f.queue('STALE');f.wire();f.exit();f.deadline();
  assert.deepEqual(f.writes,[],'exit before ready never flushes');assert.equal(f.pending(),null);
  f.store.term={write:b=>f.writes.push(b)};f.deadline();assert.deepEqual(f.writes,[]);
});

test('socket-free readiness lifecycle: spawn failure discards without a flush',()=>{
  const f=readinessFixture();
  f.context.spawnCli=()=>{f.queue('STALE');throw new Error('controlled spawn failure');};
  f.context.requestSession(f.ws);f.deadline();
  assert.equal(f.pending(),null,'failed queue discarded');assert.deepEqual(f.writes,[]);
  assert.equal(f.notices[0].type,'launch_failed');
});

test('socket-free readiness deadline is bounded and output flushes only once',()=>{
  const f=readinessFixture();f.queue('EARLY');f.wire();
  assert.deepEqual(f.writes,[],'no immediate spawn flush');
  assert.ok(f.timers.some(t=>t.ms>0&&t.ms<=1000),'hard fallback deadline at most 1000ms');
  f.data('READY');f.deadline();f.data('MORE');assert.deepEqual(f.writes,['EARLY']);
});


test('socket-free login PTY waits for output or the bounded deadline',()=>{
  for(const output of [true,false]) {
    const f=readinessFixture();f.queue('LOGIN\r\x7f\x03');f.wire(f.term,true);
    assert.deepEqual(f.writes,[],'login does not flush on spawn');
    if(output)f.data('LOGIN PROMPT');else f.deadline();
    assert.deepEqual(f.writes,['LOGIN\r\x7f\x03']);
  }
});


test('socket-free input during spawned readiness and reconnect remains queued in order',()=>{
  const f=readinessFixture();f.wire();
  const old=f.socket();old.send('STALE');
  const current=f.socket();current.send('a\r\x7f\x03');current.send('paste'.repeat(2000));
  assert.deepEqual(f.writes,[],'spawned PTY cannot bypass readiness queue');
  f.data('READY');assert.deepEqual(f.writes,['a\r\x7f\x03','paste'.repeat(2000)]);
  current.send('LIVE');assert.equal(f.writes.at(-1),'LIVE');
});
