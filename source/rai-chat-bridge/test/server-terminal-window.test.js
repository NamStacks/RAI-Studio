import { proofNativeServer } from './helpers/callback-proof-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { DEFAULT_CONFIG } from '../config.js';

const bridge = fileURLToPath(new URL('..', import.meta.url));
// Transport fixture only; no provider account, R payload or native authority claim.
test('initial resize survives deferred native settings, then restart retains the latest grid', {timeout:15000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-window-'));
  const cli = path.join(dir, 'window-cli.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}\n` +
    `const grid=()=>process.stdout.write('GRID:'+process.stdout.columns+'x'+process.stdout.rows+'\\n');\n` +
    `grid();process.stdout.on('resize',grid);process.stdout.on('error',()=>process.exit(0));\n` +
    `process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(0),12000);\n`);
  fs.chmodSync(cli, 0o700);
  let releaseRead;
  const waitingRead = new Promise(resolve => { releaseRead = resolve; });
  let readReceived;
  const readStarted = new Promise(resolve => { readReceived = resolve; });
  let block = true;
  const native = createServer(proofNativeServer('window-test-token', async (req,res) => {
    if (block) { readReceived(); await waitingRead; }
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.provider = 'claude';cfg.providers.claude.command=cli;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({status:'ok',settings:cfg,settings_revision:'window-r1'}));
  }));
  await new Promise(resolve => native.listen(0,'127.0.0.1',resolve));
  const reservation=createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const reservedPort=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,['server.js'],{cwd:bridge,env:{...process.env,HOME:dir,
    RAI_BRIDGE_DIR:dir,RAI_BRIDGE_PORT:String(reservedPort),RAI_BRIDGE_CWD:dir,RAI_BRIDGE_TOKEN:'window-test-token',
    RAI_SESSION_HEALTH_URL:`http://127.0.0.1:${native.address().port}/health`},stdio:['ignore','pipe','pipe']});
  let socket;
  try {
    const port=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',d=>{out+=d;const m=out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);if(m)resolve(Number(m[1]));});child.once('exit',code=>reject(new Error('bridge exit '+code)));});
    const url=`http://127.0.0.1:${port}`;
    const html=await (await fetch(url+'/')).text();const token=html.match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)[1];
    socket=new WebSocket(url.replace('http','ws')+'/pty?token='+encodeURIComponent(token),{origin:url});
    let output='';socket.on('message',(data,binary)=>{if(binary)output+=data.toString();});
    await once(socket,'open');
    socket.send(JSON.stringify({type:'resize',cols:80,rows:24}));
    socket.send(JSON.stringify({type:'resize',cols:72,rows:28}));
    await readStarted;
    // The pending native read guarantees no PTY exists when both resize frames arrive.
    await new Promise(resolve => setTimeout(resolve,25));
    block=false;releaseRead();
    const waitFor=async value=>{const deadline=Date.now()+4000;while(!output.includes(value)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(output.includes(value),JSON.stringify(output));};
    await waitFor('GRID:72x28');
    assert.ok(!output.includes('GRID:120x40'),'no first-frame default-width race');
    output='';socket.send(JSON.stringify({type:'resize',cols:63,rows:19}));await waitFor('GRID:63x19');
    output='';socket.send(JSON.stringify({type:'restart'}));await waitFor('GRID:63x19');
  } finally {
    releaseRead();if(socket)socket.terminate();
    if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    await new Promise(resolve=>native.close(resolve));
  }
});
