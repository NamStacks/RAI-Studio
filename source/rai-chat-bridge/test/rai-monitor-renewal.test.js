import { proofConfig } from './helpers/callback-proof-fixture.js';
const handleRequest = (request, config) => rawhandleRequest(request, proofConfig(config));
const monitorConsoleRun = (request, config) => rawmonitorConsoleRun(request, proofConfig(config));
import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorConsoleRun as rawmonitorConsoleRun, handleRequest as rawhandleRequest } from '../rai-native-mcp.js';

const config = { token: 'test-token', healthUrl: 'http://127.0.0.1:1234/health', runSessionRegistry: { sessionFor: () => undefined } };

// The two native-source contract checks below read the RAI-Studio fork, which is
// a separate repository. This bridge repo is cloned on its own (CI, fresh
// machines, release worktrees), so the fork path must be discovered, never
// assumed to be a sibling directory. Set RAI_STUDIO_SOURCE to point at a fork
// checkout; when no checkout is present the contract check is skipped with a
// stated reason instead of failing on a missing file.
const FORK_REL = 'src/cpp/session/modules/SessionRaiAssistant.cpp';
function nativeSourcePath() {
  const { existsSync } = require_fs();
  const roots = [];
  if (process.env.RAI_STUDIO_SOURCE) roots.push(process.env.RAI_STUDIO_SOURCE);
  roots.push(new URL('../../rstudio/', import.meta.url).pathname);
  roots.push(`${process.env.HOME ?? ''}/dev/rstudio/`);
  for (const root of roots) {
    const candidate = root.endsWith('/') ? `${root}${FORK_REL}` : `${root}/${FORK_REL}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
let fsModule;
function require_fs() {
  if (!fsModule) throw new Error('fs not loaded');
  return fsModule;
}
const fsReady = import('node:fs').then(mod => { fsModule = mod; });
async function nativeSource() {
  await fsReady;
  const file = nativeSourcePath();
  if (!file) return undefined;
  return fsModule.readFileSync(file, 'utf8');
}
const SKIP_NO_FORK = 'no RAI-Studio fork checkout found (set RAI_STUDIO_SOURCE)';
test('quiet compute expires only observation and can renew the SAME native run', async () => {
  let time = 0;
  const calls = [];
  const options = { ...config, now: () => time, sleep: async ms => { time += ms; },
    pollIntervalMs: 5, noOutputMs: 5, monitorTimeoutMs: 20,
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => ({ status: 'running', run_id: 'run-quiet', elapsed_ms: time, output_bytes: 0 }) }; }
  };
  const first = await monitorConsoleRun('run-quiet', options);
  assert.equal(first.status, 'timed_out');
  assert.equal(first.progress, 'quiet');
  assert.equal(first.liveness, 'responsive');
  assert.equal(first.resume_same_run, true);
  const second = await monitorConsoleRun('run-quiet', options);
  assert.equal(second.status, 'timed_out');
  assert.equal(second.run_id, first.run_id);
  assert.ok(second.elapsed_ms > first.elapsed_ms);
  assert.ok(calls.every(url => url.endsWith('/monitor')));
});

test('pending capture does not finish monitor prematurely', async () => {
  let time = 0;
  let calls = 0;
  const result = await monitorConsoleRun('run-pending', { ...config,
    now: () => time, sleep: async ms => { time += ms; }, pollIntervalMs: 5, monitorTimeoutMs: 10,
    fetch: async () => { calls++; return { ok: true, json: async () => ({ run_id: 'run-pending', status: 'pending' }) }; }
  });
  assert.equal(result.status, 'timed_out');
  assert.ok(calls > 1);
});

test('monitor accepts bounded observation window and never reads R recovery metadata while busy', async () => {
  let time = 0;
  const calls = [];
  const response = await handleRequest({ id: 1, method: 'tools/call', params: {
    name: 'monitor_console_run', arguments: { run_id: 'run-window', observation_ms: 1000 }
  } }, { ...config, now: () => time, sleep: async ms => { time += ms; }, pollIntervalMs: 500,
    fetch: async url => { calls.push(url); return { ok: true, json: async () => ({run_id: 'run-window', status: 'running', output_bytes: 0}) }; }
  });
  assert.equal(response.error, undefined);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, 'timed_out');
  assert.equal(result.monitor_elapsed_ms, 1000);
  assert.ok(calls.every(url => url.endsWith('/monitor')));
});

// Native listener must bypass the R main queue only for bounded observations.
test('native heartbeat has an authenticated listener-thread path, not an R event-pump dependency', async (t) => {
  const source = await nativeSource();
  if (!source) return t.skip(SKIP_NO_FORK);
  assert.match(source, /bool handleImmediateConnection\(boost::shared_ptr<HttpConnection> connection\) override/);
  const handler = source.slice(source.indexOf('bool handleImmediateConnection('), source.indexOf('// --- Native Console run capture'));
  assert.match(handler, /handleSessionHealthRequest/);
  assert.match(handler, /handleConsoleMonitorRequest/);
  assert.doesNotMatch(handler, /RFunction|enqueueConsoleInput|handleConsoleRunRequest/);
});


test('monitor rejects a stale native snapshot even if preceding health looked current', async () => {
  let time = 0;
  const opts = {...config, now:()=>time, sleep:async ms=>{time+=ms;}, pollIntervalMs:5, monitorTimeoutMs:10, runSessionRegistry:{sessionFor:()=> 'session-current'}, fetch:async url => ({ok:true,json:async()=> url.endsWith('/health') ? {session_id:'session-current'} : {run_id:'run-stale',session_id:'session-old',status:'running'}})};
  await assert.rejects(monitorConsoleRun('run-stale',opts), /session/);
});

test('get_run_result rejects a wrong run ID rather than trusting transport success', async () => {
  const response = await handleRequest({id:1,method:'tools/call',params:{name:'get_run_result',arguments:{run_id:'run-expected'}}}, {...config,fetch:async()=>({ok:true,json:async()=>({run_id:'run-other',status:'ok',stdout:'42'})})});
  assert.match(response.error?.message ?? '', /run.*identity/);
});


test('result path defers R-backed registry reads while native Console is busy', async (t) => {
  const source = await nativeSource();
  if (!source) return t.skip(SKIP_NO_FORK);
  const start = source.indexOf('Error handleConsoleResultRequest(');
  const body = source.slice(start,source.indexOf('// Read-only in-flight Console-capture snapshot',start));
  assert.ok(body.indexOf('s_consoleBusy') >= 0 && body.indexOf('s_consoleBusy') < body.indexOf('RFunction'));
  assert.match(body, /console_busy/);
});


test('absent capture is not settled until matching completed native result exists', async () => {
  const states=[];
  const response=await handleRequest({id:1,method:'tools/call',params:{name:'monitor_console_run',arguments:{run_id:'run-finalizing'}}},{...config,onSnapshot:s=>states.push(s.state),fetch:async url=>({ok:true,json:async()=>url.endsWith('/monitor')?{run_id:'run-finalizing',status:'not_running'}:{run_id:'run-finalizing',status:'pending'}})});
  assert.equal(response.error,undefined);
  assert.equal(JSON.parse(response.result.content[0].text).status,'finalization_pending');
  assert.ok(!states.includes('settled'));
});


test('heartbeat uses native elapsed and last-output age across renewed windows', async () => {
  const snapshots=[]; let time=0;
  await monitorConsoleRun('run-clock',{...config,now:()=>time,sleep:async ms=>{time+=ms;},pollIntervalMs:5,monitorTimeoutMs:10,onSnapshot:s=>snapshots.push(s),fetch:async()=>({ok:true,json:async()=>({status:'running',run_id:'run-clock',elapsed_ms:12345.67,last_output_age_ms:2345.67,output_bytes:7})})});
  assert.equal(snapshots[0].elapsed_ms,12345);
  assert.equal(snapshots[0].quiet_ms,2345);
});


test('fast completed runs display final native byte and elapsed counters without an in-flight sample', async () => {
  const snapshots=[];
  const response=await handleRequest({id:1,method:'tools/call',params:{name:'monitor_console_run',arguments:{run_id:'run-fast'}}},{...config,onSnapshot:s=>snapshots.push(s),fetch:async url=>({ok:true,json:async()=>url.endsWith('/monitor')?{run_id:'run-fast',status:'not_running'}:{run_id:'run-fast',status:'ok',completion:['top_level_prompt'],tainted:false,console_busy:false,elapsed_ms:[1234.56],output_bytes:[27],stdout:'AUDIT_EXEC_COUNT=12'}})});
  assert.equal(response.error,undefined);
  assert.equal(snapshots.at(-1).state,'settled');
  assert.equal(snapshots.at(-1).output_bytes,27);
  assert.equal(snapshots.at(-1).elapsed_ms,1234);
});


test('a new identical request after verified completion receives a fresh auto proposal id, not a replay', async () => {
  const proposals=[]; let n=0;
  const cfg={token:'test',healthUrl:'http://127.0.0.1:1234/health',fetch:async(url,options)=>({ok:true,json:async()=>{
    if(url.endsWith('/health'))return {session_id:'session-a'};
    if(url.endsWith('/run')){proposals.push(options.body.get('proposal_id'));return {status:'queued',run_id:`run-${++n}`,session_id:'session-a'};}
    return {status:'ok',run_id:'run-1',session_id:'session-a',completion:['top_level_prompt'],console_busy:false,tainted:false,stdout:'42'};
  }})};
  const call=(name,args)=>handleRequest({id:1,method:'tools/call',params:{name,arguments:args}},cfg);
  await call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  await call('get_run_result',{run_id:'run-1'});
  await call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  assert.notEqual(proposals[0],proposals[1]);
});


test('late completion cannot release a newer identity for the same fingerprint', async () => {
  const {createProposalIdentityCache}=await import('../rai-native-mcp.js');let time=0;
  const cache=createProposalIdentityCache({now:()=>time,ttlMs:10});
  const a=cache.getOrCreate('same');time=11;const b=cache.getOrCreate('same');
  cache.forget('same',a);assert.equal(cache.getOrCreate('same'),b);
  cache.forget('same',b);assert.notEqual(cache.getOrCreate('same'),b);
});

test('approval-delayed settled response can release its spent automatic proposal', async () => {
  const proposals=[];
  const cfg={token:'test',healthUrl:'http://127.0.0.1:1234/health',fetch:async(url,options)=>({ok:true,json:async()=>{
    if(url.endsWith('/health'))return {session_id:'session-a'};
    if(url.endsWith('/run')) {
      proposals.push(options.body.get('proposal_id'));
      return proposals.length===1 ? {status:'approval_required'} : {status:'ok',run_id:'run-delayed',session_id:'session-a'};
    }
    return {status:'ok',run_id:'run-delayed',session_id:'session-a',completion:'top_level_prompt',console_busy:false,tainted:false};
  }})};
  const call=(name,args)=>handleRequest({id:1,method:'tools/call',params:{name,arguments:args}},cfg);
  const proposal={language:'R',target:'console',code:'42'};
  await call('run_r',{proposal});await call('run_r',{proposal});
  assert.equal(proposals[0],proposals[1]);
  await call('get_run_result',{run_id:'run-delayed'});
  await call('run_r',{proposal});assert.notEqual(proposals[1],proposals[2]);
});
