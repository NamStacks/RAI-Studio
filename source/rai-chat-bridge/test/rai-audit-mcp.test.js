import { proofConfig } from './helpers/callback-proof-fixture.js';
const handleRequest = (request, config) => rawhandleRequest(request, proofConfig(config));
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { handleRequest as rawhandleRequest, MAX_PROJECT_FILE_TEXT_BYTES } from '../rai-native-mcp.js';

function harness() {
  const native = {session_id: 'session-a', console_busy: false, console_epoch: '0', source_revision: '0'};
  const calls = [];
  const config = {token: 'fixture-token', healthUrl: 'http://127.0.0.1:1234/health', fetch: async (url, options={}) => {
    const name = new URL(url).pathname.slice(1); calls.push(name);
    const full = native.contents ?? 'x <- 42';
    const offset = Number(new URLSearchParams(options.body).get('offset') ?? 0);
    const digest = createHash('sha256').update(full).digest('hex');
    const page = full.slice(offset, offset + MAX_PROJECT_FILE_TEXT_BYTES);
    const payload = {health: {...native, status: 'ok'}, active_document: {document_id: 'doc-a', path: 'analysis.Rmd',
      ...(native.paged ? {content_digest:digest,total_bytes:full.length} : {})},
      project_context: {project_active: true, root_name: 'fixture', working_directory: '.'},
      document: native.paged ? {document_id: 'doc-a', audit_revision:native.source_revision, contents: page,
        content_digest:digest,offset,total_bytes:full.length,...(offset+page.length<full.length?{next_offset:offset+page.length}:{}),path:'analysis.Rmd'}
        : {document_id: 'doc-a', audit_revision:native.source_revision, contents: full, path: 'analysis.Rmd'},
      run: {status: native.run_status ?? 'queued', run_id:'run-owned', session_id:native.session_id},
      result: {status:native.result_status ?? 'ok', run_id:'run-owned', session_id:native.session_id, console_epoch:native.result_epoch ?? native.console_epoch, completion:'top_level_prompt', stdout:native.stdout ?? '[1] 42', tainted:native.tainted ?? false, code_hash:native.result_hash ?? createHash('sha256').update('42').digest('hex')},
      debug: {run_id:'run-owned',error_detail:{message:'REJECTED_NATIVE_DIAGNOSTIC'}},
      file: {path:'analysis.Rmd',text:native.file_text ?? 'x <- 42',audit_revision:native.file_revision ?? '0'},
      environment: {bindings: [{name: 'x', binding: 'value'}], total_count: 1, truncated: false}}[name];
    if (!payload) throw new Error('unexpected endpoint '+name);
    return {ok:true, json: async () => payload};
  }};
  const call = async (name, args={}) => {
    const response = await handleRequest({id:1, method:'tools/call', params:{name, arguments:args}}, config);
    if (response.error) throw new Error(response.error.message);
    return JSON.parse(response.result.content[0].text);
  };
  return {call, native, calls, config};
}

test('audit starts from native identity and checkpoints only actual native evidence with outcome checks', async () => {
  const h = harness();
  const previous = process.env.RAI_MCP_SERVER_NAME;
  let workflow;
  try { process.env.RAI_MCP_SERVER_NAME = 'rai'; workflow = await h.call('get_audit_workflow'); }
  finally { if (previous === undefined) delete process.env.RAI_MCP_SERVER_NAME; else process.env.RAI_MCP_SERVER_NAME = previous; }
  assert.match(workflow.instructions, /Raw inputs are read-only/);
  assert.equal(workflow.phases.length, 13);
  const audit = await h.call('audit_session', {action: 'start'});
  assert.equal(audit.current_phase, 0);
  await assert.rejects(h.call('audit_session', {action: 'checkpoint', audit_id: audit.audit_id, phase:0, evidence_ids: ['invented'], checks: ['42']}), /evidence/);
  const env = await h.call('get_environment_summary');
  assert.ok(env.audit_evidence_id);
  const next = await h.call('audit_session', {action: 'checkpoint', audit_id: audit.audit_id, phase:0, evidence_ids:[env.audit_evidence_id], checks:['"truncated":false']});
  assert.equal(next.current_phase, 1);
  assert.equal(next.evidence.length, 1);
  assert.equal(next.evidence[0].status, 'verified');
  assert.ok(h.calls.every(name => !['run','edit','interrupt'].includes(name)));
});

test('audit cancellation changes orchestration only and restart invalidates saved identity', async () => {
  const h = harness();
  const audit = await h.call('audit_session', {action:'start'});
  h.native.session_id = 'session-b';
  const resumed = await h.call('audit_session', {action:'resume', audit_id:audit.audit_id});
  assert.equal(resumed.status, 'invalidated');
  const next = await h.call('audit_session', {action:'start'});
  const cancelled = await h.call('audit_session', {action:'cancel', audit_id:next.audit_id});
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(h.calls.every(name => !['run','edit','interrupt','restart'].includes(name)));
});

test('busy native session blocks audit reads and forged fields before action', async () => {
  const h = harness(); h.native.console_busy = true;
  await assert.rejects(h.call('audit_session', {action:'start'}), /busy/);
  assert.deepEqual(h.calls, ['health']);
  await assert.rejects(h.call('audit_session', {action:'start', source_digest: 'forged'}), /unsupported/);
});


test('audit can advance native epoch only after its own completed Console run', async () => {
  const h = harness();
  const audit = await h.call('audit_session', {action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.console_epoch = '1';
  const result = await h.call('get_run_result',{run_id:'run-owned'});
  assert.ok(result.audit_evidence_id);
  const checkpoint = await h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,evidence_ids:[result.audit_evidence_id],checks:['[1] 42']});
  assert.equal(checkpoint.identity.native_generation,'1');
  assert.equal(checkpoint.current_phase,1);
});


test('native result for a different exact proposal cannot become verified audit evidence', async () => {
  const h=harness(); await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'43'}});
  h.native.console_epoch='1';
  const result=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal(result.audit_evidence_id,undefined);
  assert.match(result.audit_evidence_unavailable,/source|outcome/);
});


test('Console phase outcome checks cannot use transport/status fields as measurement', async () => {
  const h=harness(); const audit=await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.console_epoch='1';
  const result=await h.call('get_run_result',{run_id:'run-owned'});
  await assert.rejects(h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,evidence_ids:[result.audit_evidence_id],checks:['"status":"ok"']}),/outcome check/);
});


test('checkpoint accepts a bounded human-readable coverage reason advertised by its schema', async () => {
  const h=harness();const a=await h.call('audit_session',{action:'start'});const e=await h.call('get_environment_summary');
  const saved=await h.call('audit_session',{action:'checkpoint',audit_id:a.audit_id,phase:0,evidence_ids:[e.audit_evidence_id],checks:['"truncated":false'],skip_reason:'Values deliberately uninspected; metadata only.'});
  assert.equal(saved.skips[0].reason,'Values deliberately uninspected; metadata only.');
});

test('repeated result reads retain the same evidence identity within their original phase', async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});h.native.console_epoch='1';
  const first=await h.call('get_run_result',{run_id:'run-owned'});const again=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal(again.audit_evidence_id,first.audit_evidence_id);
});

test('audit hashes the exact validated source passed to native Console', async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:' 42\n'}});h.native.console_epoch='1';
  const r=await h.call('get_run_result',{run_id:'run-owned'});assert.ok(r.audit_evidence_id,r.audit_evidence_unavailable);
});


test('source changes invalidate evidence collection before a later restoration can bless it', async () => {
  const h=harness(); const a=await h.call('audit_session',{action:'start'});
  h.native.contents='x <- 99';
  await assert.rejects(h.call('read_open_document',{document_id:'doc-a'}),/identity changed/);
  h.native.contents='x <- 42';
  const state=await h.call('audit_session',{action:'status',audit_id:a.audit_id});
  assert.equal(state.status,'invalidated');
});

test('native monotonic source revision invalidates an A-to-B-to-A restoration', async () => {
  const h=harness(); const audit=await h.call('audit_session',{action:'start'});
  h.native.source_revision='2'; // two native editor commits, same final contents
  const resumed=await h.call('audit_session',{action:'resume',audit_id:audit.audit_id});
  assert.equal(resumed.status,'invalidated');
});

test('restored project resource bytes cannot reuse earlier native revision evidence', async () => {
  const h=harness(); const audit=await h.call('audit_session',{action:'start'});
  const file=await h.call('read_project_file',{path:'analysis.Rmd'});
  h.native.file_revision='2';
  await assert.rejects(h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,evidence_ids:[file.audit_evidence_id],checks:['42']}),/resource changed/);
});

test('tainted terminal ownership is retired and cannot be rehabilitated on later reads', async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.tainted=true;
  const first=await h.call('get_run_result',{run_id:'run-owned'});
  assert.match(first.audit_evidence_unavailable,/tainted/);
  h.native.tainted=false;
  const retry=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal(retry.audit_evidence_unavailable,first.audit_evidence_unavailable);
  assert.equal(retry.audit_evidence_id,undefined);
});

test('capacity rejection remains explicit on repeated completed-result reads', async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.stdout='\u0001'.repeat(16000);
  const first=await h.call('get_run_result',{run_id:'run-owned'});
  assert.match(first.audit_evidence_unavailable,/capacity/);
  const retry=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal(retry.audit_evidence_unavailable,first.audit_evidence_unavailable);
  assert.equal(retry.audit_evidence_id,undefined);
});

test('a full 64 KB read_project_file page becomes checkpoint evidence, and the record bound still holds', async () => {
  const line='x <- "a" # \\ path\n';
  const pages={source:line.repeat(Math.ceil(MAX_PROJECT_FILE_TEXT_BYTES/line.length)).slice(0,MAX_PROJECT_FILE_TEXT_BYTES),newlines:'\n'.repeat(MAX_PROJECT_FILE_TEXT_BYTES)};
  for(const [kind,text] of Object.entries(pages)) {
    const h=harness();h.native.file_text=text;
    const audit=await h.call('audit_session',{action:'start'});
    const page=await h.call('read_project_file',{path:'analysis.Rmd'});
    assert.equal(page.text.length,MAX_PROJECT_FILE_TEXT_BYTES);
    assert.ok(page.audit_evidence_id,`${kind}: ${page.audit_evidence_unavailable}`);
    const next=await h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,evidence_ids:[page.audit_evidence_id],checks:['"path":"analysis.Rmd"']});
    assert.equal(next.current_phase,1);
  }
  const h=harness();h.native.file_text='\u0001'.repeat(MAX_PROJECT_FILE_TEXT_BYTES);
  await h.call('audit_session',{action:'start'});
  const page=await h.call('read_project_file',{path:'analysis.Rmd'});
  assert.equal(page.audit_evidence_id,undefined);
  assert.match(page.audit_evidence_unavailable,/capacity/);
});

test('a full 64 KB read_open_document buffer becomes checkpoint evidence', async () => {
  const line='x <- "a" # \\ path\n';
  const h=harness();h.native.contents=line.repeat(Math.ceil(MAX_PROJECT_FILE_TEXT_BYTES/line.length)).slice(0,MAX_PROJECT_FILE_TEXT_BYTES);
  const audit=await h.call('audit_session',{action:'start'});
  const doc=await h.call('read_open_document',{document_id:'doc-a'});
  assert.equal(doc.contents.length,MAX_PROJECT_FILE_TEXT_BYTES);
  assert.ok(doc.audit_evidence_id,doc.audit_evidence_unavailable);
  const next=await h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,evidence_ids:[doc.audit_evidence_id],checks:['"path":"analysis.Rmd"']});
  assert.equal(next.current_phase,1);
});

test('unsaved open buffer pages stay bound to one digest and survive evidence checkpoints', async () => {
  const h=harness();h.native.paged=true;h.native.contents='x'.repeat(MAX_PROJECT_FILE_TEXT_BYTES)+'last page unsaved';
  const audit=await h.call('audit_session',{action:'start'});
  const first=await h.call('read_open_document',{document_id:'doc-a'});
  assert.equal(first.contents.length,MAX_PROJECT_FILE_TEXT_BYTES);
  assert.equal(first.next_offset,MAX_PROJECT_FILE_TEXT_BYTES);
  assert.ok(first.audit_evidence_id);
  const next=await h.call('read_open_document',{document_id:'doc-a',offset:first.next_offset,expected_digest:first.content_digest});
  assert.equal(next.contents,'last page unsaved');
  assert.equal(next.content_digest,first.content_digest);
  assert.ok(next.audit_evidence_id);
  await h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,
    evidence_ids:[first.audit_evidence_id,next.audit_evidence_id],checks:['last page unsaved']});
  await assert.rejects(h.call('read_open_document',{document_id:'doc-a',offset:first.next_offset}),/digest/);
  h.native.contents+='changed';
  await assert.rejects(h.call('read_open_document',{document_id:'doc-a',offset:first.next_offset,expected_digest:first.content_digest}),/identity changed/);
});

for(const kind of ['source','epoch']) test(`rejected ${kind} result releases ownership permanently`, async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  if(kind==='source')h.native.result_hash=createHash('sha256').update('43').digest('hex');else h.native.result_epoch='1';
  const rejected=await h.call('get_run_result',{run_id:'run-owned'});
  assert.match(rejected.audit_evidence_unavailable,/unverified|Console changed/);
  assert.equal(rejected.audit_evidence_id,undefined);
  delete h.native.result_hash;delete h.native.result_epoch;
  const retry=await h.call('get_run_result',{run_id:'run-owned'});
  assert.match(retry.audit_evidence_unavailable,/coverage incomplete/);
  assert.equal(retry.audit_evidence_id,undefined);
});

test('a replayed queued acknowledgement cannot restore retired run ownership', async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  const proposal={language:'R',target:'console',code:'42'};
  await h.call('run_r',{proposal});h.native.tainted=true;
  const rejected=await h.call('get_run_result',{run_id:'run-owned'});
  h.native.tainted=false;await h.call('run_r',{proposal});
  const retry=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal(retry.audit_evidence_unavailable,rejected.audit_evidence_unavailable);
  assert.equal(retry.audit_evidence_id,undefined);
});

test('historical debug output cannot bypass a rejected run evidence decision', async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.tainted=true;await h.call('get_run_result',{run_id:'run-owned'});
  const debug=await h.call('get_debug_info',{run_id:'run-owned'});
  assert.equal(debug.audit_evidence_id,undefined);
  assert.match(debug.audit_evidence_unavailable,/diagnostic/);
});
for(const status of ['unknown','expired','session_restarted']) test(`unavailable ${status} run retires ownership with explicit coverage`, async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.result_status=status;
  const rejected=await h.call('get_run_result',{run_id:'run-owned'});
  assert.match(rejected.audit_evidence_unavailable,/coverage incomplete/);
  h.native.result_status='ok';
  const retry=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal(retry.audit_evidence_unavailable,rejected.audit_evidence_unavailable);
  assert.equal(retry.audit_evidence_id,undefined);
});

for(const status of ['unknown','expired','session_restarted']) test(`monitor ${status} outcome retires without promoting diagnostics`, async () => {
  const {captureAuditEvidence}=await import('../rai-audit-mcp.js');
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  const observation=await captureAuditEvidence('monitor_console_run',{run_id:'run-owned'},{status,run_id:'run-owned'},h.config,{});
  assert.match(observation.audit_evidence_unavailable,/coverage incomplete/);
  const retry=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal(retry.audit_evidence_id,undefined);
  assert.equal(retry.audit_evidence_unavailable,observation.audit_evidence_unavailable);
});
test('quiet observation timeout does not retire a still-owned native run', async () => {
  const {captureAuditEvidence}=await import('../rai-audit-mcp.js');
  const h=harness();await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  const observation=await captureAuditEvidence('monitor_console_run',{run_id:'run-owned'},{status:'timed_out',run_id:'run-owned'},h.config,{});
  assert.equal(observation.audit_evidence_id,undefined);
  const completed=await h.call('get_run_result',{run_id:'run-owned'});
  assert.ok(completed.audit_evidence_id);
});

test('approval-delayed settled acknowledgement preserves audit ownership until output verification', async () => {
  const h=harness();await h.call('audit_session',{action:'start'});
  h.native.run_status='approval_required';
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.run_status='ok';
  const acknowledged=await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  assert.equal(acknowledged.audit_evidence_id,undefined);
  const completed=await h.call('get_run_result',{run_id:'run-owned'});
  assert.ok(completed.audit_evidence_id);
});

test('consumed run evidence cannot be replayed into a later phase', async () => {
  const h=harness();const audit=await h.call('audit_session',{action:'start'});
  const args={proposal_id:'explicit-owned',proposal:{language:'R',target:'console',code:'42'}};
  await h.call('run_r',args);
  const first=await h.call('get_run_result',{run_id:'run-owned'});
  assert.equal((await h.call('get_run_result',{run_id:'run-owned'})).audit_evidence_id,first.audit_evidence_id);
  await h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,evidence_ids:[first.audit_evidence_id],checks:['42']});
  h.native.run_status='ok';await h.call('run_r',args);
  assert.equal((await h.call('get_run_result',{run_id:'run-owned'})).audit_evidence_id,undefined);
});
test('a new audit cannot claim a historical settled acknowledgement as a new execution', async () => {
  const h=harness();const audit=await h.call('audit_session',{action:'start'});
  const args={proposal_id:'explicit-old',proposal:{language:'R',target:'console',code:'42'}};
  await h.call('run_r',args);await h.call('get_run_result',{run_id:'run-owned'});
  await h.call('audit_session',{action:'cancel',audit_id:audit.audit_id});
  await h.call('audit_session',{action:'start'});
  h.native.run_status='ok';await h.call('run_r',args);
  assert.equal((await h.call('get_run_result',{run_id:'run-owned'})).audit_evidence_id,undefined);
});

test('an owned run epoch awaiting result verification defers reads without invalidating the audit', async () => {
  const h=harness();const audit=await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.console_epoch='1';
  await assert.rejects(h.call('read_project_file',{path:'analysis.Rmd'}),/owned Console run.*verified/);
  assert.equal((await h.call('audit_session',{action:'status',audit_id:audit.audit_id})).status,'active');
  const result=await h.call('get_run_result',{run_id:'run-owned'});
  assert.ok(result.audit_evidence_id);
  const source=await h.call('read_project_file',{path:'analysis.Rmd'});
  assert.ok(source.audit_evidence_id);
  const next=await h.call('audit_session',{action:'checkpoint',audit_id:audit.audit_id,phase:0,evidence_ids:[result.audit_evidence_id],checks:['42']});
  assert.equal(next.current_phase,1);
});
for(const action of ['resume','checkpoint']) test(`pending owned result defers ${action} without blessing or invalidating its epoch`, async () => {
  const h=harness();const audit=await h.call('audit_session',{action:'start'});
  const source=await h.call('read_project_file',{path:'analysis.Rmd'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});h.native.console_epoch='1';
  const args={action,audit_id:audit.audit_id,...(action==='checkpoint'?{phase:0,evidence_ids:[source.audit_evidence_id],checks:['42']}:{})};
  await assert.rejects(h.call('audit_session',args),/owned Console run.*verified/);
  const waiting=await h.call('audit_session',{action:'status',audit_id:audit.audit_id});
  assert.equal(waiting.status,'active');assert.equal(waiting.identity.native_generation,'0');
});
test('source changes still invalidate while an owned result is outstanding', async () => {
  const h=harness();const audit=await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.console_epoch='1';h.native.contents='changed';
  await assert.rejects(h.call('read_project_file',{path:'analysis.Rmd'}),/identity changed/);
  assert.equal((await h.call('audit_session',{action:'status',audit_id:audit.audit_id})).status,'invalidated');
});

for(const field of ['session_id','source_revision']) test(`owned-run deferral does not mask ${field} drift`, async () => {
  const h=harness();const audit=await h.call('audit_session',{action:'start'});
  await h.call('run_r',{proposal:{language:'R',target:'console',code:'42'}});
  h.native.console_epoch='1';h.native[field]='changed';
  await assert.rejects(h.call('read_project_file',{path:'analysis.Rmd'}),/identity changed/);
  assert.equal((await h.call('audit_session',{action:'status',audit_id:audit.audit_id})).status,'invalidated');
  assert.equal(h.calls.filter(name=>name==='run').length,1);
});
test('an unowned epoch change still invalidates rather than defers', async () => {
  const h=harness();const audit=await h.call('audit_session',{action:'start'});
  h.native.console_epoch='1';
  await assert.rejects(h.call('read_project_file',{path:'analysis.Rmd'}),/identity changed/);
  assert.equal((await h.call('audit_session',{action:'status',audit_id:audit.audit_id})).status,'invalidated');
});
