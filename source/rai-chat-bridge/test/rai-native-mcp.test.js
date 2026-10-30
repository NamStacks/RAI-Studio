import { proofConfig } from './helpers/callback-proof-fixture.js';
const callEndpoint = (name, values, config) => rawcallEndpoint(name, values, proofConfig(config));
const handleRequest = (request, config) => rawhandleRequest(request, proofConfig(config));
const monitorConsoleRun = (request, config) => rawmonitorConsoleRun(request, proofConfig(config));
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NATIVE_REQUEST_TIMEOUT_MS, callEndpoint as rawcallEndpoint, createProposalIdentityCache, endpointFor, handleRequest as rawhandleRequest, monitorConsoleRun as rawmonitorConsoleRun, normalizeNativeResult, requireNativeConfig, tools, validateDocumentEditContext, validateDocumentEditText, validateDocumentId, validateMaxLines, validateObjectNames, validatePlotIndex, validateProjectFilePath, validateProposalId, validateRunId, validateToolArguments } from '../rai-native-mcp.js';

const TEST_HEALTH_URL = 'http://127.0.0.1:19090/health';
const CONFIG = { token: 'test-token', healthUrl: TEST_HEALTH_URL, proposalIdCache: createProposalIdentityCache() };

const proposal = (code, extra = {}) => ({ language: 'R', target: 'console', code, ...extra });
const callRunR = (args, config) =>
  handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_r', arguments: args } }, config);

test('cached notebook inventory is read-only, scoped to one open document and independent of Plots pane', async () => {
  const data={document_id:'doc_42',dirty:true,content_digest:'a'.repeat(64),audit_revision:'7',
    outputs:[{chunk_id:'chunk1',ordinal:'000001',bytes:24}],total_count:1,truncated:false,
    provenance:'cached_output_only_not_current_run_proof',execution_origin:'historical_notebook_cache_not_console_run'};
  const h=recordingFetch(data);
  const call = args => handleRequest({id:1,method:'tools/call',params:{name:'list_notebook_outputs',arguments:args}}, {...CONFIG,fetch:h.fetch});
  for (const args of [{},{document_id:'../secret'},{document_id:'doc_42',path:'secret'}]) {
    const result=await call(args);assert.ok(result.error);assert.equal(h.calls.length,0);
  }
  const response=await call({document_id:'doc_42'});
  assert.deepEqual(JSON.parse(response.result.content[0].text),data);
  assert.equal(new URL(h.calls[0].url).pathname,'/notebook_outputs');
  assert.equal(new URLSearchParams(h.calls[0].options.body).get('document_id'),'doc_42');
  assert.equal(h.calls.length,1);
});

test('cached notebook image validates opaque IDs and native PNG; never requests a redraw', async () => {
  const png=Uint8Array.from([137,80,78,71,13,10,26,10,1,2]);
  const calls=[];
  const fetch=async (url, options) => {calls.push({url,options}); return {ok:true,status:200,
    headers:{get:k=>k==='content-type'?'image/png':k==='content-length'?String(png.length):null},
    arrayBuffer:async()=>png.buffer};};
  const call=args=>handleRequest({id:1,method:'tools/call',params:{name:'get_notebook_output_image',arguments:args}},{...CONFIG,fetch});
  for (const args of [{document_id:'doc_42',chunk_id:'../bad',ordinal:'000001',expected_document_digest:'a'.repeat(64)},
    {document_id:'doc_42',chunk_id:'chunk1',ordinal:'../bad',expected_document_digest:'a'.repeat(64)},
    {document_id:'doc_42',chunk_id:'chunk1',ordinal:'000001'},
    {document_id:'doc_42',chunk_id:'chunk1',ordinal:'000001',expected_document_digest:'bad'}]) {
    assert.ok((await call(args)).error);assert.equal(calls.length,0);
  }
  const result=await call({document_id:'doc_42',chunk_id:'chunk1',ordinal:'000001',expected_document_digest:'a'.repeat(64)});
  assert.equal(JSON.parse(result.result.content[0].text).execution_origin,'historical_notebook_cache_not_console_run');
  assert.equal(JSON.parse(result.result.content[0].text).cache_freshness,'unverified');
  assert.equal(result.result.content[1].type,'image');
  assert.equal(new URL(calls[0].url).pathname,'/notebook_image');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)),
    {document_id:'doc_42',chunk_id:'chunk1',ordinal:'000001',expected_document_digest:'a'.repeat(64)});
  assert.equal(calls.length,1);
});

test('Console result is labeled run-specific and never claims notebook chunk/cache refresh', async () => {
  const {fetch,calls} = recordingFetch({status:'ok',run_id:'run-abc',stdout:'plot ready',
    completion:'top_level_prompt',data_effects:{output_files:[{path:'derived.png',sha256:'f'.repeat(64)}]}});
  const response = await handleRequest({id:7,method:'tools/call',params:{
    name:'get_run_result',arguments:{run_id:'run-abc'}}},{...CONFIG,fetch});
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.execution_origin,'native_console_capture');
  assert.equal(result.notebook_cache_refreshed,false);
  assert.equal(result.data_effects.output_files[0].sha256,'f'.repeat(64));
  assert.equal(new URL(calls[0].url).pathname,'/result');
});

// A fetch that records every call, so a test can prove one never happened.
function recordingFetch(response) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => response
    };
  };
  return { fetch, calls };
}

test('tools/list returns bounded native tools including automatic identity-bound derived designation', async () => {
  const message = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, CONFIG);

  assert.deepEqual(message.result.tools.map((tool) => tool.name), ['run_r', 'get_active_document_context', 'list_open_documents', 'read_open_document', 'edit_document', 'get_run_result', 'monitor_console_run', 'get_debug_info', 'write_project_file', 'read_project_file', 'get_project_context', 'authorize_existing_derived_binding', 'get_environment_summary', 'get_plot_image', 'get_plot_history', 'list_notebook_outputs', 'get_notebook_output_image', 'get_viewer_state', 'get_audit_workflow', 'audit_session']);
  assert.equal(message.result.tools, tools);
  const authorize = message.result.tools.find((tool) => tool.name === 'authorize_existing_derived_binding');
  assert.deepEqual(authorize.inputSchema.required, ['name', 'kind']);
  assert.deepEqual(authorize.inputSchema.properties.kind.enum, ['plots', 'helper', 'path']);
  assert.match(authorize.description, /automatically authorizes/i);
  assert.match(authorize.description, /type and exact binding identity/);
  assert.match(authorize.description, /historical derivation.*not machine-proven/);
  assert.doesNotMatch(authorize.description, /ATTEST|asks the user|one-time approval card/);

  const runR = message.result.tools[0].inputSchema;
  assert.equal(runR.additionalProperties, false);
  assert.deepEqual(runR.required, ['proposal']);
  assert.equal(runR.properties.proposal.additionalProperties, false);
  assert.deepEqual(runR.properties.proposal.required, ['language', 'target', 'code']);
  assert.equal(runR.properties.proposal.properties.language.const, 'R');
  assert.equal(runR.properties.proposal.properties.target.const, 'console');
  assert.equal(runR.properties.proposal_id.type, 'string');

  const getRunResult = message.result.tools.find((tool) => tool.name === 'get_run_result').inputSchema;
  assert.equal(getRunResult.additionalProperties, false);
  assert.deepEqual(getRunResult.required, ['run_id']);

  const getDebugInfo = message.result.tools.find((tool) => tool.name === 'get_debug_info').inputSchema;
  assert.equal(getDebugInfo.additionalProperties, false);
  assert.deepEqual(getDebugInfo.required, ['run_id']);
  assert.deepEqual(Object.keys(getDebugInfo.properties), ['run_id', 'object_names']);
  assert.equal(getDebugInfo.properties.object_names.type, 'array');
  assert.equal(getDebugInfo.properties.object_names.minItems, 1);
  assert.equal(getDebugInfo.properties.object_names.maxItems, 20);
  assert.equal(getDebugInfo.properties.object_names.items.pattern, '^[A-Za-z.][A-Za-z0-9._]{0,127}$');

  const runRTool = message.result.tools.find((tool) => tool.name === 'run_r');
  assert.match(runRTool.description, /Figure inspection protocol/);
  assert.match(runRTool.description, /Do not create scratch files or control graphics devices/);
  const plotImage = message.result.tools.find((tool) => tool.name === 'get_plot_image');
  // Task4: get_plot_image must accurately describe what it returns -- the
  // existing complete Plots-pane PNG history item, never a generated crop,
  // and no native-resolution promise beyond the PNG it actually returns.
  assert.match(plotImage.description, /already-rendered RAI-Studio Plots-pane PNG history item/);
  assert.match(plotImage.description, /never returns a generated crop/);
  assert.match(plotImage.description, /no promise about native display resolution beyond the pixel dimensions/);
  assert.match(plotImage.description, /never returns data, files, or any device output/);
  assert.match(plotImage.description, /Do not make text-level claims beyond what the returned PNG's own pixels show/);

  const plotHistory = message.result.tools.find((tool) => tool.name === 'get_plot_history');
  // Task4: an empty Plots-pane history must not be read as proof that no
  // file-device or knitr output ever happened -- those never touch the pane.
  assert.match(plotHistory.description, /does not prove the absence of file-device or knitr output/);

  const readProjectFile = message.result.tools.find((tool) => tool.name === 'read_project_file').inputSchema;
  assert.equal(readProjectFile.additionalProperties, false);
  assert.deepEqual(readProjectFile.required, ['path']);
  assert.deepEqual(Object.keys(readProjectFile.properties), ['path', 'offset']);
  assert.equal(readProjectFile.properties.path.type, 'string');
  assert.equal(readProjectFile.properties.path.minLength, 1);
  assert.equal(readProjectFile.properties.path.maxLength, 4096);
  assert.equal(readProjectFile.properties.offset.type, 'integer');
  assert.equal(readProjectFile.properties.offset.minimum, 0);
  assert.equal(readProjectFile.properties.offset.maximum, 10485760);

  const getPlotImage = message.result.tools.find((tool) => tool.name === 'get_plot_image').inputSchema;
  assert.equal(getPlotImage.additionalProperties, false);
  assert.deepEqual(getPlotImage.required, []);
  // The ONLY argument this tool has ever gained is a bounded history index --
  // still no path, URL, device, size, format, or content field.
  assert.deepEqual(Object.keys(getPlotImage.properties), ['index']);
  assert.equal(getPlotImage.properties.index.type, 'integer');
  assert.equal(getPlotImage.properties.index.minimum, 0);
  assert.equal(getPlotImage.properties.index.maximum, 999);

  const getPlotHistory = message.result.tools.find((tool) => tool.name === 'get_plot_history').inputSchema;
  assert.equal(getPlotHistory.additionalProperties, false);
  assert.deepEqual(getPlotHistory.required, []);
  assert.deepEqual(getPlotHistory.properties, {});

  const getProjectContext = message.result.tools.find((tool) => tool.name === 'get_project_context').inputSchema;
  assert.equal(getProjectContext.additionalProperties, false);
  assert.deepEqual(getProjectContext.required, []);
  // No path/dir/glob/depth argument: the caller cannot steer this at any
  // directory, so it can never become arbitrary disk browsing.
  assert.deepEqual(getProjectContext.properties, {});

  const getEnvironmentSummary = message.result.tools.find((tool) => tool.name === 'get_environment_summary').inputSchema;
  assert.equal(getEnvironmentSummary.additionalProperties, false);
  assert.deepEqual(getEnvironmentSummary.required, []);
  assert.deepEqual(Object.keys(getEnvironmentSummary.properties), ['object_names', 'summary_mode', 'requested_columns']);
  assert.equal(getEnvironmentSummary.properties.object_names.type, 'array');
  assert.equal(getEnvironmentSummary.properties.object_names.minItems, 1);
  assert.equal(getEnvironmentSummary.properties.object_names.maxItems, 20);
  assert.equal(getEnvironmentSummary.properties.object_names.items.pattern, '^[A-Za-z.][A-Za-z0-9._]{0,127}$');
  assert.deepEqual(getEnvironmentSummary.properties.summary_mode.enum, ['full', 'nrow']);
  assert.equal(getEnvironmentSummary.properties.requested_columns.type, 'array');
  assert.equal(getEnvironmentSummary.properties.requested_columns.minItems, 1);
  assert.equal(getEnvironmentSummary.properties.requested_columns.maxItems, 20);
  assert.equal(getEnvironmentSummary.properties.requested_columns.items.pattern, '^[A-Za-z.][A-Za-z0-9._]{0,127}$');

  const getViewerState = message.result.tools.find((tool) => tool.name === 'get_viewer_state').inputSchema;
  assert.equal(getViewerState.additionalProperties, false);
  assert.deepEqual(getViewerState.required, []);
  assert.deepEqual(getViewerState.properties, {});

  const readOpenDocument = message.result.tools.find((tool) => tool.name === 'read_open_document').inputSchema;
  assert.deepEqual(readOpenDocument.required, ['document_id']);
  assert.equal(readOpenDocument.properties.document_id.pattern, '^[A-Za-z0-9_-]{1,256}$');

  const editDocument = message.result.tools.find((tool) => tool.name === 'edit_document').inputSchema;
  assert.deepEqual(editDocument.required, ['document_id']);
  assert.equal(editDocument.oneOf.length, 2);
  assert.deepEqual(editDocument.oneOf[1].required, ['expected_digest', 'contents']);
  assert.equal(editDocument.properties.contents.maxLength, 10*1024*1024);
  assert.equal(editDocument.properties.expected_text.maxLength, 32768);
  // context_before/context_after are optional at the schema level (Rmd's
  // mandatory-together requirement is enforced by validateToolArguments at
  // call time, not by JSON Schema's `required`), but each must be bounded
  // 1..2048 bytes when supplied.
  assert.ok('context_before' in editDocument.properties, 'edit_document schema must declare context_before');
  assert.ok('context_after' in editDocument.properties, 'edit_document schema must declare context_after');
  assert.equal(editDocument.properties.context_before.minLength, 1);
  assert.equal(editDocument.properties.context_before.maxLength, 2048);
  assert.equal(editDocument.properties.context_after.minLength, 1);
  assert.equal(editDocument.properties.context_after.maxLength, 2048);
});

test('active and open-document tools send only bounded editor requests', async () => {
  const { fetch, calls } = recordingFetch({ status: 'approval_required', request_id: 'rai-edit' });
  const config = { ...CONFIG, fetch };

  await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_active_document_context', arguments: {} } }, config);
  await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_open_documents', arguments: {} } }, config);
  await handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_open_document', arguments: { document_id: 'doc_42' } } }, config);
  const edit = await handleRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'edit_document', arguments: { document_id: 'doc_42', expected_text: 'x <- 1', replacement: 'x <- 2' } } }, config);

  assert.equal(calls[0].url, 'http://127.0.0.1:19090/active_document');
  assert.equal(calls[0].options.body.toString(), '');
  assert.equal(calls[1].url, 'http://127.0.0.1:19090/documents');
  assert.equal(calls[1].options.body.toString(), '');
  assert.equal(calls[2].url, 'http://127.0.0.1:19090/document');
  assert.equal(calls[2].options.body.get('document_id'), 'doc_42');
  assert.equal(calls[3].url, 'http://127.0.0.1:19090/edit');
  assert.equal(calls[3].options.body.get('expected_text'), 'x <- 1');
  assert.equal(calls[3].options.body.get('replacement'), 'x <- 2');
  assert.equal(JSON.parse(edit.result.content[0].text).status, 'approval_required');
});

test('document edit rejects paths, empty text, and unsupported fields before a network call', async () => {
  const cases = [
    { document_id: '../doc', expected_text: 'x', replacement: 'y' },
    { document_id: 'doc', expected_text: '', replacement: 'y' },
    { document_id: 'doc', expected_text: 'x', replacement: '' },
    { document_id: 'doc', expected_text: 'x', replacement: 'y', path: '/tmp/a.R' },
    // A lone context field -- never a valid pair, and never sent to the network.
    { document_id: 'doc', expected_text: 'x', replacement: 'y', context_before: 'a' },
    { document_id: 'doc', expected_text: 'x', replacement: 'y', context_after: 'b' },
    // Out-of-bounds context strings.
    { document_id: 'doc', expected_text: 'x', replacement: 'y', context_before: '', context_after: 'b' },
    { document_id: 'doc', expected_text: 'x', replacement: 'y', context_before: 'a'.repeat(2049), context_after: 'b' }
  ];
  for (const args of cases) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'edit_document', arguments: args } }, { ...CONFIG, fetch });
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
  assert.throws(() => validateDocumentId('doc/path'), /document_id is invalid/);
  assert.throws(() => validateDocumentEditText('', 'replacement'), /non-empty string/);
  assert.throws(() => validateDocumentEditContext('', 'context_before'), /non-empty string/);
  assert.throws(() => validateDocumentEditContext('a'.repeat(2049), 'context_before'), /at most 2048/);
  assert.equal(validateDocumentEditContext('```{r}\n', 'context_before'), '```{r}\n');
});

// An edit_document call with a valid context pair must forward both fields
// to the /edit endpoint, exactly and unmodified -- this is the bridge half
// of the anchored-context contract the native session enforces.
test('document edit forwards a valid context pair to the native /edit endpoint', async () => {
  const { fetch, calls } = recordingFetch({ status: 'approval_required', request_id: 'rai-edit' });
  const config = { ...CONFIG, fetch };

  const edit = await handleRequest({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: {
      name: 'edit_document',
      arguments: {
        document_id: 'doc_42',
        expected_text: 'x <- 1',
        replacement: 'x <- 2',
        context_before: '```{r}\n',
        context_after: '\n```'
      }
    }
  }, config);

  assert.equal(calls[0].url, 'http://127.0.0.1:19090/edit');
  assert.equal(calls[0].options.body.get('document_id'), 'doc_42');
  assert.equal(calls[0].options.body.get('expected_text'), 'x <- 1');
  assert.equal(calls[0].options.body.get('replacement'), 'x <- 2');
  assert.equal(calls[0].options.body.get('context_before'), '```{r}\n');
  assert.equal(calls[0].options.body.get('context_after'), '\n```');
  assert.equal(JSON.parse(edit.result.content[0].text).status, 'approval_required');
});

// Omitting context entirely stays valid (R documents don't require it) and
// must never send half-populated context fields to the native endpoint.
test('document edit omits context fields entirely when neither is supplied', async () => {
  const { fetch, calls } = recordingFetch({ status: 'approval_required', request_id: 'rai-edit' });
  const config = { ...CONFIG, fetch };

  await handleRequest({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'edit_document', arguments: { document_id: 'doc_42', expected_text: 'x <- 1', replacement: 'x <- 2' } }
  }, config);

  assert.equal(calls[0].options.body.has('context_before'), false);
  assert.equal(calls[0].options.body.has('context_after'), false);
});

// The strict proposal boundary has to hold before anything leaves this process:
// a rejected proposal must never reach the native endpoint at all.
test('a malformed proposal is a JSON-RPC error and issues no network call', async () => {
  const cases = [
    { label: 'missing proposal', args: {} },
    { label: 'missing code', args: { proposal: { language: 'R', target: 'console' } } },
    { label: 'wrong language', args: { proposal: { language: 'python', target: 'console', code: 'print(1)' } } },
    { label: 'wrong target', args: { proposal: proposal('20 + 22') && { language: 'R', target: 'terminal', code: '20 + 22' } } },
    { label: 'markdown fences', args: { proposal: proposal('```r\n20 + 22\n```') } },
    { label: 'user prose', args: { proposal: proposal('Please run 20 + 22') } },
    { label: 'smuggled field', args: { proposal: proposal('20 + 22', { approval: 'skip' }) } },
    { label: 'unsupported tool argument', args: { proposal: proposal('20 + 22'), where: 'console' } },
    { label: 'out of range max_lines', args: { proposal: proposal('20 + 22'), max_lines: 0 } }
  ];

  for (const { label, args } of cases) {
    const { fetch, calls } = recordingFetch({ status: 'queued' });
    const message = await callRunR(args, { ...CONFIG, fetch });

    assert.equal(message.error?.code, -32603, label);
    assert.equal(typeof message.error.message, 'string', label);
    assert.ok(message.error.message.length > 0, label);
    assert.equal(message.result, undefined, label);
    assert.equal(calls.length, 0, `${label} must not reach the native endpoint`);
  }
});

// Multi-statement code is rejected by the R broker, not here -- this proves the
// native "error" status surfaces as a usable tool result rather than a crash.
test('a multi-statement proposal surfaces the native single-statement rejection', async () => {
  const { fetch, calls } = recordingFetch({
    status: 'error',
    message: 'run_r accepts exactly one R statement per call'
  });
  const message = await callRunR({ proposal: proposal('1 + 1; 2 + 2') }, { ...CONFIG, fetch });

  assert.equal(calls.length, 1);
  assert.match(JSON.parse(message.result.content[0].text).message, /exactly one R statement/);
});

test('a valid proposal posts form-encoded code and max_lines to /run', async () => {
  const { fetch, calls } = recordingFetch({ status: 'queued', run_id: ['run-abc'], session_id: 'session-current' });
  const message = await callRunR({ proposal: proposal('20 + 22') }, { ...CONFIG, fetch });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/run');
  assert.equal(calls[0].options.headers['X-RAI-Bridge-Token'], undefined);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].options.body.get('code'), '20 + 22');
  assert.match(calls[0].options.body.get('proposal_id'), /^[A-Za-z0-9-]{1,128}$/);
  assert.equal(calls[0].options.body.get('max_lines'), '200');

  // the one-element array R hands back is unwrapped for the wire protocol
  assert.deepEqual(JSON.parse(message.result.content[0].text), { status: 'queued', run_id: 'run-abc', session_id: 'session-current' });
});

test('a supplied proposal_id is preserved across repeated proposals', async () => {
  const { fetch, calls } = recordingFetch({ status: 'queued', run_id: ['run-abc'], session_id: 'session-current' });
  const args = { proposal: proposal('20 + 22'), proposal_id: 'proposal-retry-42' };

  await callRunR(args, { ...CONFIG, fetch });
  await callRunR(args, { ...CONFIG, fetch });

  assert.equal(calls[0].options.body.get('proposal_id'), 'proposal-retry-42');
  assert.equal(calls[1].options.body.get('proposal_id'), 'proposal-retry-42');
});

test('identical omitted-proposal_id retries reuse one pending identity', async () => {
  const { fetch, calls } = recordingFetch({ status: 'approval_required' });
  const config = { ...CONFIG, fetch, proposalIdCache: createProposalIdentityCache() };
  const args = { proposal: proposal('20 + 22') };

  await callRunR(args, config);
  await callRunR(args, config);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.get('proposal_id'), calls[1].options.body.get('proposal_id'));
});

test('changed strict proposal payload receives a different generated identity', async () => {
  const { fetch, calls } = recordingFetch({ status: 'approval_required' });
  const config = { ...CONFIG, fetch, proposalIdCache: createProposalIdentityCache() };

  await callRunR({ proposal: proposal('20 + 22') }, config);
  await callRunR({ proposal: proposal('21 + 21') }, config);

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].options.body.get('proposal_id'), calls[1].options.body.get('proposal_id'));
});

test('a malformed proposal_id is rejected before a network call', async () => {
  const { fetch, calls } = recordingFetch({ status: 'approval_required' });
  const message = await callRunR(
    { proposal: proposal('20 + 22'), proposal_id: 'proposal/retry' },
    { ...CONFIG, fetch, proposalIdCache: createProposalIdentityCache() }
  );

  assert.equal(message.error?.code, -32603);
  assert.match(message.error.message, /proposal_id is invalid/);
  assert.equal(calls.length, 0);
});

test('proposal identity cache expires entries and evicts its oldest entry when bounded', () => {
  const boundedCache = createProposalIdentityCache({ maxEntries: 1, ttlMs: 10 });
  const first = boundedCache.getOrCreate('first');
  boundedCache.getOrCreate('second');
  assert.notEqual(boundedCache.getOrCreate('first'), first, 'oldest entry must be evicted');

  let now = 0;
  const expiringCache = createProposalIdentityCache({ ttlMs: 10, now: () => now });
  const original = expiringCache.getOrCreate('proposal');
  now = 11;
  assert.notEqual(expiringCache.getOrCreate('proposal'), original, 'expired entry must not be reused');
});

test('get_run_result rejects a malformed run_id without a network call', async () => {
  const cases = [{}, { run_id: '' }, { run_id: 'not-a-run' }, { run_id: 42 }, { run_id: 'run-../etc' }];

  for (const args of cases) {
    const { fetch, calls } = recordingFetch({ status: 'ok' });
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_run_result', arguments: args } },
      { ...CONFIG, fetch }
    );

    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('get_debug_info accepts only a valid stored run id and calls the read-only native endpoint', async () => {
  const { fetch, calls } = recordingFetch({
    status: ['error'],
    run_id: ['run-abc'],
    stderr: ['Error in f() : boom'],
    error_detail: { class: ['simpleError', 'error', 'condition'], call: ['f()'], message: ['boom'] },
    warnings: [[]]
  });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_debug_info', arguments: { run_id: 'run-abc' } } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/debug');
  assert.deepEqual([...calls[0].options.body.keys()], ['run_id']);
  const result = JSON.parse(message.result.content[0].text);
  assert.equal(result.run_id, 'run-abc');
  assert.equal(result.error_detail.call, 'f()');
  assert.equal(result.error_detail.message, 'boom');
});

test('get_debug_info forwards only a bounded array of bare identifiers for native global-object summaries', async () => {
  const { fetch, calls } = recordingFetch({
    status: ['ok'], run_id: ['run-abc'], traceback_available: [false],
    traceback_unavailable_reason: ['raw Console error lifecycle does not expose faithful call frames'],
    object_summaries: [{ name: ['safe_name'], found: [true], summary: [' num [1:3] 1 2 3'] }]
  });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'get_debug_info', arguments: { run_id: 'run-abc', object_names: ['safe_name', '.also_safe'] } } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body.get('run_id'), 'run-abc');
  assert.equal(calls[0].options.body.get('object_names'), 'safe_name,.also_safe');
  const result = JSON.parse(message.result.content[0].text);
  assert.equal(result.traceback_available, false);
  assert.match(result.traceback_unavailable_reason, /does not expose/);
  assert.equal(result.object_summaries[0].name, 'safe_name');
});

test('get_debug_info rejects arbitrary expressions, paths, and unsupported reflection arguments before a network call', async () => {
  const cases = [
    {},
    { run_id: 'system("echo unsafe")' },
    { run_id: '../run-abc' },
    { run_id: 'run-abc', object_name: 'x' },
    { run_id: 'run-abc', object_names: [] },
    { run_id: 'run-abc', object_names: ['x', 'x()'] },
    { run_id: 'run-abc', object_names: ['x$y'] },
    { run_id: 'run-abc', object_names: ['x[1]'] },
    { run_id: 'run-abc', object_names: ['base::pi'] },
    { run_id: 'run-abc', object_names: ['../x'] },
    { run_id: 'run-abc', object_names: ['two words'] },
    { run_id: 'run-abc', object_names: Array.from({ length: 21 }, (_, i) => `x${i}`) }
  ];

  for (const args of cases) {
    const { fetch, calls } = recordingFetch({ status: 'ok' });
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_debug_info', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('get_plot_image accepts no arguments and returns only a bounded native PNG as MCP image content', async () => {
  const calls = [];
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': String(png.byteLength) }),
      arrayBuffer: async () => png.buffer
    };
  };

  const message = await handleRequest(
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_plot_image', arguments: {} } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/plot');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body.toString(), '');
  assert.equal(calls[0].options.headers['X-RAI-Bridge-Token'], undefined);
  assert.deepEqual(message.result.content, [{
    type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64')
  }]);
});

test('get_plot_image rejects paths, URLs, content, and every other argument before a network call', async () => {
  for (const args of [{ path: '/tmp/plot.png' }, { url: 'https://example.test/plot.png' }, { content: 'png' }, { run_id: 'run-abc' }]) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_plot_image', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('get_viewer_state accepts no arguments and posts an empty body to /viewer with the token', async () => {
  const { fetch, calls } = recordingFetch({ active: true, kind: 'html_widget', transport: 'session_temp' });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_viewer_state', arguments: {} } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/viewer');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual([...calls[0].options.body.keys()], []);
  assert.equal(calls[0].options.headers['X-RAI-Bridge-Token'], undefined);

  // the native JSON (a plain object, not R-list-derived) is returned
  // unchanged -- this bridge never adds, drops, or renames a field.
  assert.deepEqual(JSON.parse(message.result.content[0].text), { active: true, kind: 'html_widget', transport: 'session_temp' });
});

test('get_viewer_state rejects paths, URLs, html, content, screenshot, and run_id before a network call', async () => {
  const cases = [
    { path: '/tmp/viewer.html' },
    { url: 'https://example.test/widget.html' },
    { html: '<div>widget</div>' },
    { content: 'widget' },
    { screenshot: true },
    { run_id: 'run-abc' }
  ];

  for (const args of cases) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'get_viewer_state', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('get_viewer_state surfaces a bounded JSON-RPC error on a native 4xx or timeout', async () => {
  const { fetch: rejectFetch } = recordingFetch({ status: 'error', message: 'get_viewer_state accepts no arguments' });
  const badFetch = async (...fetchArgs) => {
    const response = await rejectFetch(...fetchArgs);
    return { ...response, ok: false, status: 400 };
  };
  const rejected = await handleRequest(
    { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'get_viewer_state', arguments: {} } },
    { ...CONFIG, fetch: badFetch }
  );
  assert.equal(rejected.error?.code, -32603);
  assert.match(rejected.error.message, /rejected viewer \(400\)/);

  const timeoutFetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const timedOut = await handleRequest(
    { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'get_viewer_state', arguments: {} } },
    { ...CONFIG, fetch: timeoutFetch, timeoutMs: 5 }
  );
  assert.equal(timedOut.error?.code, -32603);
  assert.match(timedOut.error.message, /did not respond to viewer within/);
});

test('get_plot_image rejects a non-PNG or oversized native response before making MCP image content', async () => {
  const cases = [
    { headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '8' }), body: new Uint8Array(8), expected: /not PNG/ },
    { headers: new Headers({ 'content-type': 'image/png', 'content-length': String(4 * 1024 * 1024 + 1) }), body: new Uint8Array(1), expected: /exceeds 4 MB/ }
  ];
  for (const { headers, body, expected } of cases) {
    const fetch = async () => ({ ok: true, status: 200, headers, arrayBuffer: async () => body.buffer });
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_plot_image', arguments: {} } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603);
    assert.match(message.error.message, expected);
  }
});

test('a run from a replaced R session is terminal and never reads a stale result', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    const endpoint = String(url);
    calls.push({ url: endpoint, options });
    if (endpoint.endsWith('/run')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'queued', run_id: 'run-old-session', session_id: 'session-before-restart'
      }) };
    }
    if (endpoint.endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'ok', session_id: 'session-after-restart'
      }) };
    }
    throw new Error(`stale result endpoint must not be called: ${url}`);
  };
  const config = { ...CONFIG, fetch };

  const queued = await callRunR({ proposal: proposal("cat('never replayed\\n')") }, config);
  assert.equal(queued.error, undefined, JSON.stringify(queued));
  assert.equal(JSON.parse(queued.result.content[0].text).status, 'queued');

  const readback = await handleRequest(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_run_result', arguments: { run_id: 'run-old-session' } } },
    config
  );
  assert.equal(readback.error, undefined, JSON.stringify(readback));
  assert.deepEqual(JSON.parse(readback.result.content[0].text), {
    status: 'session_restarted',
    run_id: 'run-old-session',
    message: 'R restarted before this result was read; propose a fresh R expression and request a new approval'
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    'http://127.0.0.1:19090/run',
    'http://127.0.0.1:19090/health'
  ]);
});

test('monitoring a run from a replaced R session is terminal and never reads stale capture or result', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    const endpoint = String(url);
    calls.push({ url: endpoint, options });
    if (endpoint.endsWith('/run')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'queued', run_id: 'run-old-monitored-session', session_id: 'session-before-restart'
      }) };
    }
    if (endpoint.endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'ok', session_id: 'session-after-restart'
      }) };
    }
    throw new Error(`stale monitor/result endpoint must not be called: ${url}`);
  };
  const config = { ...CONFIG, fetch };

  const queued = await callRunR({ proposal: proposal("cat('never monitored after restart\\n')") }, config);
  assert.equal(queued.error, undefined, JSON.stringify(queued));

  const monitored = await handleRequest(
    { jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'monitor_console_run', arguments: { run_id: 'run-old-monitored-session' } } },
    config
  );
  assert.equal(monitored.error, undefined, JSON.stringify(monitored));
  assert.deepEqual(JSON.parse(monitored.result.content[0].text), {
    status: 'session_restarted',
    run_id: 'run-old-monitored-session',
    message: 'R restarted before this result was read; propose a fresh R expression and request a new approval'
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    'http://127.0.0.1:19090/run',
    'http://127.0.0.1:19090/health'
  ]);
});

test('tracked monitor revalidates the R session immediately before reading a settled result', async () => {
  const calls = [];
  let healthChecks = 0;
  const fetch = async (url, options) => {
    const endpoint = String(url);
    calls.push({ url: endpoint, options });
    if (endpoint.endsWith('/run')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'queued', run_id: 'run-restarted-before-result', session_id: 'session-a'
      }) };
    }
    if (endpoint.endsWith('/health')) {
      healthChecks += 1;
      return { ok: true, status: 200, json: async () => ({
        status: 'ok', session_id: healthChecks === 1 ? 'session-a' : 'session-b'
      }) };
    }
    if (endpoint.endsWith('/monitor')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'not_running', run_id: 'run-restarted-before-result'
      }) };
    }
    if (endpoint.endsWith('/result')) {
      throw new Error('stale result endpoint must not be called');
    }
    throw new Error(`unexpected native endpoint: ${url}`);
  };
  const config = { ...CONFIG, fetch };

  const queued = await callRunR({ proposal: proposal("cat('session changes before result\\n')") }, config);
  assert.equal(queued.error, undefined, JSON.stringify(queued));

  const monitored = await handleRequest(
    { jsonrpc: '2.0', id: 83, method: 'tools/call', params: { name: 'monitor_console_run', arguments: { run_id: 'run-restarted-before-result' } } },
    config
  );

  assert.equal(monitored.error, undefined, JSON.stringify(monitored));
  assert.deepEqual(JSON.parse(monitored.result.content[0].text), {
    status: 'session_restarted',
    run_id: 'run-restarted-before-result',
    message: 'R restarted before this result was read; propose a fresh R expression and request a new approval'
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    'http://127.0.0.1:19090/run',
    'http://127.0.0.1:19090/health',
    'http://127.0.0.1:19090/monitor',
    'http://127.0.0.1:19090/health'
  ]);
});

test('an untracked run preserves compatibility by polling the native result', async () => {
  const { fetch, calls } = recordingFetch({ status: 'ok', run_id: ['run-untracked'] });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_run_result', arguments: { run_id: 'run-untracked' } } },
    { ...CONFIG, fetch }
  );
  assert.equal(JSON.parse(message.result.content[0].text).status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/result');
});

test('a tainted result is unwrapped and reaches the caller intact', async () => {
  const fetch = async (url) => {
    if (String(url).endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', session_id: 'session-current' }) };
    }
    return { ok: true, status: 200, json: async () => ({
      status: ['ok'],
      run_id: ['run-abc'],
      tainted: [true],
      taint_reason: ['console input other than the approved source ran during capture'],
      stdout: '[1] 42'
    }) };
  };
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_run_result', arguments: { run_id: 'run-abc' } } },
    { ...CONFIG, fetch, runSessionRegistry: { sessionFor: () => 'session-current' } }
  );

  const result = JSON.parse(message.result.content[0].text);
  assert.equal(result.tainted, true);
  assert.match(result.taint_reason, /during capture/);
  assert.equal(result.status, 'ok');
});

test('a stalled native health check is bounded before a result is read', async () => {
  let healthSignal;
  const fetch = (url, options) => {
    if (String(url).endsWith('/health')) {
      healthSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ok', run_id: 'run-known' }) });
  };

  const message = await handleRequest(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_run_result', arguments: { run_id: 'run-known' } } },
    { ...CONFIG, fetch, timeoutMs: 50, runSessionRegistry: { sessionFor: () => 'session-current' } }
  );

  assert.ok(healthSignal, 'health request must be abortable');
  assert.equal(JSON.parse(message.result.content[0].text).status, 'ok');
});

// A wedged native listener (Console parked on readline()/browser()) would
// otherwise hang the tool call, and with it the assistant's turn, forever.
test('a native endpoint that never responds fails with a bounded timeout error', async () => {
  const neverResolves = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const started = Date.now();
  const message = await callRunR(
    { proposal: proposal('20 + 22') },
    { ...CONFIG, fetch: neverResolves, timeoutMs: 50 }
  );

  assert.equal(message.error?.code, -32603);
  assert.match(message.error.message, /did not respond to run within 50ms/);
  assert.ok(Date.now() - started < 5000, 'must fail fast, not hang');
});

test('the production request timeout is a sane bounded constant', () => {
  assert.equal(NATIVE_REQUEST_TIMEOUT_MS, 30000);
});

test('a non-ok native response is a JSON-RPC error, not an unhandled rejection', async () => {
  const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const message = await callRunR({ proposal: proposal('20 + 22') }, { ...CONFIG, fetch });

  assert.equal(message.error?.code, -32603);
  assert.match(message.error.message, /rejected run \(401\)/);
});

test('a native 4xx rejection surfaces its JSON message to the assistant', async () => {
  const fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ status: 'error', message: 'run_r code exceeds 8000 bytes' })
  });
  const message = await callRunR({ proposal: proposal('20 + 22') }, { ...CONFIG, fetch });

  assert.equal(message.error?.code, -32603);
  assert.match(message.error.message, /rejected run \(400\): run_r code exceeds 8000 bytes/);
});

test('an unknown tool and an unknown method are errors, not throws', async () => {
  const unknownTool = await handleRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } },
    CONFIG
  );
  assert.match(unknownTool.error.message, /unknown tool/);

  const unknownMethod = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, CONFIG);
  assert.match(unknownMethod.error.message, /method not found/);
});

test('a notification (no id) is ignored rather than answered', async () => {
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'initialize' }, CONFIG), undefined);
});

test('initialize echoes the requested protocol version', async () => {
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-01-01' } },
    CONFIG
  );
  assert.equal(message.result.protocolVersion, '2025-01-01');
  assert.equal(message.result.serverInfo.name, 'rai-native-console');
});

test('endpointFor derives sibling endpoints from the health url only', () => {
  assert.equal(endpointFor(TEST_HEALTH_URL, 'run'), 'http://127.0.0.1:19090/run');
  assert.equal(endpointFor(TEST_HEALTH_URL, 'result'), 'http://127.0.0.1:19090/result');
});

test('requireNativeConfig validates injected env at call time, not import time', () => {
  assert.deepEqual(requireNativeConfig({ RAI_BRIDGE_TOKEN: 'tok', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL }), {
    token: 'tok',
    healthUrl: TEST_HEALTH_URL
  });
  assert.throws(() => requireNativeConfig({}), /RAI session endpoint configuration is required/);
  assert.throws(() => requireNativeConfig({ RAI_BRIDGE_TOKEN: 'tok' }), /RAI session endpoint configuration is required/);
});

test('requireNativeConfig exposes the optional loopback inspector URL to the MCP process', () => {
  const inspectorUrl = 'http://127.0.0.1:8790/internal/run-inspector';
  assert.deepEqual(requireNativeConfig({
    RAI_BRIDGE_TOKEN: 'tok',
    RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL,
    RAI_RUN_INSPECTOR_URL: inspectorUrl
  }), {
    token: 'tok',
    healthUrl: TEST_HEALTH_URL,
    inspectorUrl
  });
});

test('argument and identifier validators hold their contracts', () => {
  assert.throws(() => validateToolArguments(null, ['a'], []), /must be an object/);
  assert.throws(() => validateToolArguments([], ['a'], []), /must be an object/);
  assert.throws(() => validateToolArguments({ b: 1 }, ['a'], []), /unsupported fields/);
  assert.throws(() => validateToolArguments({}, ['a'], ['a']), /missing required fields/);

  assert.equal(validateMaxLines(undefined), 200);
  assert.equal(validateMaxLines(1), 1);
  assert.equal(validateMaxLines(1000), 1000);
  assert.throws(() => validateMaxLines(0), /between 1 and 1000/);
  assert.throws(() => validateMaxLines(1001), /between 1 and 1000/);
  assert.throws(() => validateMaxLines(1.5), /between 1 and 1000/);

  assert.equal(validateProposalId(undefined), undefined);
  assert.equal(validateProposalId('proposal-retry-42'), 'proposal-retry-42');
  assert.throws(() => validateProposalId('proposal/retry'), /proposal_id is invalid/);

  assert.equal(validateRunId('run-abc'), 'run-abc');
  assert.throws(() => validateRunId('run-'), /run_id is invalid/);
});

test('normalizeNativeResult unwraps known scalar fields while preserving multi-line output', () => {
  assert.deepEqual(
    normalizeNativeResult({ status: ['ok'], stdout: ['one line'], stderr: ['warning'], value_summary: ['[1] 42'], extra: ['a', 'b'] }),
    { status: 'ok', stdout: 'one line', stderr: 'warning', value_summary: '[1] 42', extra: ['a', 'b'] },
  );
  assert.deepEqual(normalizeNativeResult({ status: ['ok'], stdout: ['a', 'b'] }), { status: 'ok', stdout: ['a', 'b'] });
  assert.equal(normalizeNativeResult(null), null);
  assert.deepEqual(normalizeNativeResult(['x']), ['x']);
});

// The /environment payload is R-list-derived, so every scalar arrives wrapped.
// class and dims must NOT be unwrapped: they are real R vectors, and a field
// that is sometimes a string and sometimes an array is worse than a 1-element
// array the caller can always index.
test('normalizeNativeResult unwraps environment scalars but leaves class and dims as vectors', () => {
  assert.deepEqual(
    normalizeNativeResult({
      bindings: [{ name: ['mtcars'], binding: ['value'], class: ['data.frame'] }],
      binding_count: [1], total_count: [7], truncated: [false], max_bindings: [100]
    }),
    {
      bindings: [{ name: 'mtcars', binding: 'value', class: ['data.frame'] }],
      binding_count: 1, total_count: 7, truncated: false, max_bindings: 100
    }
  );

  assert.deepEqual(
    normalizeNativeResult({
      objects: [{
        name: ['mtcars'], found: [true], binding: ['value'],
        class: ['tbl_df', 'tbl', 'data.frame'], dims: [32, 11],
        row_count: [32], column_count: [11],
        columns: [{ name: ['mpg'], class: ['numeric'], missingness: { scope: ['first_rows'], inspected_rows: [32], missing_count: [2] } }],
        columns_truncated: [false], summary: ['data.frame: 32 obs. of 11 variables']
      }]
    }),
    {
      objects: [{
        name: 'mtcars', found: true, binding: 'value',
        class: ['tbl_df', 'tbl', 'data.frame'], dims: [32, 11],
        row_count: 32, column_count: 11,
        columns: [{ name: 'mpg', class: ['numeric'], missingness: { scope: 'first_rows', inspected_rows: 32, missing_count: 2 } }],
        columns_truncated: false, summary: 'data.frame: 32 obs. of 11 variables'
      }]
    }
  );

  // A single-class object keeps the array form for the same reason.
  assert.deepEqual(normalizeNativeResult({ class: ['data.frame'], dims: [3] }), { class: ['data.frame'], dims: [3] });
});

// Importing this module must stay free of consequence: a top-level env read or
// readline handle would make it untestable and would attach a stdin listener to
// whatever imports it.
test('RAI companion skill requires guarded fresh-plot inspection', () => {
  const prompt = readFileSync(fileURLToPath(new URL('../prompts/RAI-Assistant.md', import.meta.url)), 'utf8');
  assert.match(prompt, /Figure inspection protocol/);
  assert.match(prompt, /get_plot_history` before/);
  assert.match(prompt, /Do not create scratch files or control graphics devices/);
  // Task4: retained guardrails -- protocol is history -> one guarded Console
  // render -> refreshed readback, no source/file devices, no Viewer, no
  // knitr-equivalence, and an explicit statement that native policy refuses
  // plotting calls and withAutoprint.
  const protocolSection = prompt.slice(
    prompt.indexOf('## Figure inspection protocol'),
    prompt.indexOf('## Hard boundaries')
  );
  assert.match(protocolSection, /get_plot_history` again/);
  assert.match(protocolSection, /never use `png`, `jpeg`, `tiff`, `bmp`, `svg`, `pdf`, `postscript`, `cairo_pdf`, `dev\.new`, `dev\.off`, `dev\.copy`, `dev\.print`, `recordPlot`, `replayPlot`, or `source`/);
  assert.match(protocolSection, /knitr-equivalent rendering/);
  assert.doesNotMatch(protocolSection, /Viewer/);
  assert.match(protocolSection, /refuses plotting calls such as `plot\(\)` and also `withAutoprint\(\)`/);
  assert.doesNotMatch(protocolSection, /normal R plotting proposal|wrap them as one statement/);
  assert.equal((prompt.match(/RStudio/g) || []).length, 1);
});

test('RAI companion prompt names RAI-Studio and states the run_r secret-location policy', () => {
  const prompt = readFileSync(fileURLToPath(new URL('../prompts/RAI-Assistant.md', import.meta.url)), 'utf8');
  assert.match(prompt, /inside RAI-Studio, an independent fork of RStudio/);
  assert.match(prompt, /not affiliated with, endorsed by, or sponsored by Posit Software, PBC/);
  assert.doesNotMatch(prompt, /inside RStudio|active RStudio|current RStudio/);
  assert.doesNotMatch(prompt, /Submit exactly one normal R plotting proposal/);
  const boundaries = prompt.slice(prompt.indexOf('## Hard boundaries'), prompt.indexOf('## Read-only IDE context'));
  assert.match(boundaries, /\.Renviron/);
  assert.match(boundaries, /\.env/);
  assert.match(boundaries, /SSH keys/);
  assert.match(boundaries, /refuses these outright/);
  assert.match(boundaries, /subprocess or foreign-code helpers/);
  assert.doesNotMatch(boundaries, /subprocess, network or foreign-code/);
  assert.match(boundaries, /does not block network access/);
  assert.doesNotMatch(prompt, /ordinary environment text buffers/);
  assert.match(prompt, /These guards bind RAI tools only/);
});

test('run_r description states the refusal policy and no longer advises withAutoprint or a plotting proposal', () => {
  const description = tools.find((tool) => tool.name === 'run_r').description;
  assert.doesNotMatch(description, /prefer `?withAutoprint/);
  assert.doesNotMatch(description, /normal R plotting proposal/);
  assert.match(description, /Do not use `withAutoprint\(\)`: native policy refuses it/);
  assert.match(description, /refuses known secret locations \(SSH keys, cloud credentials, \.Renviron, \.env, shell history, browser data, the assistant\'?s own state folder\)/);
  assert.match(description, /full environment dumps and secret-named environment variables/);
  assert.match(description, /subprocess and foreign-code helpers/);
  assert.doesNotMatch(description, /network and foreign-code/);
  assert.match(description, /does not block network access/);
  assert.match(description, /[Pp]lotting calls such as plot\(\) are refused/);
  assert.match(description, /guards bind RAI tools only/);
  assert.doesNotMatch(description, /sandbox(?:es|ed)? (?:the|all|every)|is sandboxed/i);
  assert.doesNotMatch(description, /\bRStudio\b/);
});

test('rai-audit skill snippets avoid withAutoprint and name RAI-Studio', () => {
  for (const name of ['SKILL.md', 'scientific-checks.md']) {
    const text = readFileSync(fileURLToPath(new URL(`../skills/rai-audit/${name}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(text, /withAutoprint\s*\(/, name);
    assert.doesNotMatch(text, /active RStudio session|live RStudio analysis session/, name);
  }
  const plugin = readFileSync(fileURLToPath(new URL('../skills/rai-audit/.claude-plugin/plugin.json', import.meta.url)), 'utf8');
  assert.doesNotMatch(plugin, /RStudio/);
});

test('no tool description names RStudio or claims environment files are readable', () => {
  for (const tool of tools) {
    assert.doesNotMatch(tool.description, /\bRStudio\b/, tool.name);
    assert.doesNotMatch(tool.description, /environment\/profile\/workspace text/i, tool.name);
    assert.doesNotMatch(tool.description, /environment.{0,40}\breadable\b/i, tool.name);
  }
});

test('rai-native-mcp.js has no top-level side effects (importing it is free)', () => {
  const source = readFileSync(fileURLToPath(new URL('../rai-native-mcp.js', import.meta.url)), 'utf8');
  assert.equal(/^const (token|healthUrl) = process\.env/m.test(source), false);
  assert.equal(/^const rl = readline\.createInterface/m.test(source), false);
  assert.equal(/^if \(!token \|\| !healthUrl\) throw/m.test(source), false);
  assert.match(source, /^if \(import\.meta\.main\) main\(\);$/m);
});

// --- Stage 4 read-only context connectors -----------------------------------
//
// get_project_context, get_environment_summary and get_plot_history are the
// same shape as every other read-only connector here: POST-only, token-gated,
// strict unknown-field rejection, and no path/URL/content argument anywhere.
// These tests assert that boundary inside this process, before any request can
// reach the native endpoint.

test('get_project_context accepts no arguments and posts an empty body to /project_context', async () => {
  const { fetch, calls } = recordingFetch({
    project_active: true, root_name: 'workspace', working_directory: '.',
    files: [{ path: 'analysis.R', kind: 'r_script', size_bytes: 42 }],
    file_count: 1, truncated: false, max_files: 200, max_depth: 2
  });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'get_project_context', arguments: {} } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/project_context');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual([...calls[0].options.body.keys()], []);
  assert.equal(calls[0].options.headers['X-RAI-Bridge-Token'], undefined);

  const result = JSON.parse(message.result.content[0].text);
  assert.equal(result.project_active, true);
  assert.deepEqual(result.files, [{ path: 'analysis.R', kind: 'r_script', size_bytes: 42 }]);
});

test('get_project_context rejects any path, directory, glob, depth, or recursion argument before a network call', async () => {
  const cases = [
    { path: '/etc' },
    { directory: '..' },
    { dir: '~' },
    { glob: '**/*.csv' },
    { pattern: '*.R' },
    { max_depth: 99 },
    { recursive: true },
    { contents: true },
    { run_id: 'run-abc' }
  ];
  for (const args of cases) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'get_project_context', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('get_environment_summary lists bindings with no arguments and sends named detail as a comma-joined scalar', async () => {
  const { fetch: listFetch, calls: listCalls } = recordingFetch({
    bindings: [{ name: 'mtcars', binding: 'value', class: 'data.frame' }],
    binding_count: 1, total_count: 1, truncated: false, max_bindings: 100
  });
  await handleRequest(
    { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'get_environment_summary', arguments: {} } },
    { ...CONFIG, fetch: listFetch }
  );
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].url, 'http://127.0.0.1:19090/environment');
  assert.equal(listCalls[0].options.method, 'POST');
  assert.deepEqual([...listCalls[0].options.body.keys()], []);

  const { fetch: detailFetch, calls: detailCalls } = recordingFetch({
    objects: [{ name: 'mtcars', found: true, binding: 'value', class: ['data.frame'], dims: [32, 11] }]
  });
  const detail = await handleRequest(
    { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'get_environment_summary', arguments: { object_names: ['mtcars', 'iris'] } } },
    { ...CONFIG, fetch: detailFetch }
  );
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].url, 'http://127.0.0.1:19090/environment');
  assert.equal(detailCalls[0].options.body.get('object_names'), 'mtcars,iris');
  assert.equal(JSON.parse(detail.result.content[0].text).objects[0].name, 'mtcars');
});

test('get_environment_summary rejects expressions, subsetting, namespaces, and oversized name lists before a network call', async () => {
  const cases = [
    { object_names: 'mtcars' },
    { object_names: [] },
    { object_names: ['1 + 1'] },
    { object_names: ['system("echo pwned")'] },
    { object_names: ['x$y'] },
    { object_names: ['x[1]'] },
    { object_names: ['base::pi'] },
    { object_names: ['mtcars', 'a,b'] },
    { object_names: Array.from({ length: 21 }, (_unused, index) => `x${index}`) },
    { object_names: ['mtcars'], envir: 'baseenv()' },
    { environment: 'globalenv()' },
    { evaluate: true },
    { values: true },
    { path: '/tmp/x.RData' },
    { object_names: ['mtcars'], summary_mode: 'all' },
    { object_names: ['mtcars'], summary_mode: '' },
    { object_names: ['mtcars'], summary_mode: 'nrow; 1+1' },
    { object_names: ['mtcars'], requested_columns: [] },
    { object_names: ['mtcars'], requested_columns: ['mpg$x'] },
    { object_names: ['mtcars'], requested_columns: ['mpg[1]'] },
    { object_names: ['mtcars'], requested_columns: ['1 + 1'] },
    { object_names: ['mtcars'], requested_columns: ['mpg', 'a,b'] },
    { object_names: ['mtcars'], requested_columns: Array.from({ length: 21 }, (_unused, index) => `c${index}`) },
    { requested_columns: ['mpg'] }
  ];
  for (const args of cases) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'get_environment_summary', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
  assert.deepEqual(validateObjectNames(['mtcars']), ['mtcars']);
  assert.equal(validateObjectNames(undefined), undefined);
});

test('get_environment_summary forwards summary_mode and requested_columns as bounded scalars, defaulting summary_mode to full', async () => {
  const { fetch: defaultFetch, calls: defaultCalls } = recordingFetch({ objects: [{ name: 'mtcars', found: true }] });
  await handleRequest(
    { jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'get_environment_summary', arguments: { object_names: ['mtcars'] } } },
    { ...CONFIG, fetch: defaultFetch }
  );
  assert.equal(defaultCalls[0].options.body.has('summary_mode'), false);
  assert.equal(defaultCalls[0].options.body.has('requested_columns'), false);

  const { fetch, calls } = recordingFetch({ objects: [{ name: 'mtcars', found: true, row_count: 32 }] });
  await handleRequest(
    {
      jsonrpc: '2.0', id: 61, method: 'tools/call',
      params: { name: 'get_environment_summary', arguments: { object_names: ['mtcars'], summary_mode: 'nrow' } }
    },
    { ...CONFIG, fetch }
  );
  assert.equal(calls[0].options.body.get('summary_mode'), 'nrow');

  const { fetch: colFetch, calls: colCalls } = recordingFetch({ objects: [{ name: 'mtcars', found: true }] });
  await handleRequest(
    {
      jsonrpc: '2.0', id: 62, method: 'tools/call',
      params: { name: 'get_environment_summary', arguments: { object_names: ['mtcars'], requested_columns: ['mpg', 'cyl'] } }
    },
    { ...CONFIG, fetch: colFetch }
  );
  assert.equal(colCalls[0].options.body.get('requested_columns'), 'mpg,cyl');
});

test('derived-binding request validates name/kind and relays a native approval requirement without an R run', async () => {
  for (const args of [{name:'.rs.secret',kind:'plots'}, {name:'forest.plots',kind:'data'},
    {name:'a;system("x")',kind:'helper'}, {name:'forest.plots',kind:'plots',approve:true}]) {
    const {fetch,calls} = recordingFetch({});
    const message = await handleRequest({jsonrpc:'2.0',id:75,method:'tools/call',params:{
      name:'authorize_existing_derived_binding',arguments:args}}, {...CONFIG,fetch});
    assert.equal(message.error?.code,-32603,JSON.stringify(args));
    assert.equal(calls.length,0,JSON.stringify(args));
  }
  const {fetch,calls} = recordingFetch({status:'approval_required',message:'approval_required: rai-fixture'});
  const result = await handleRequest({jsonrpc:'2.0',id:76,method:'tools/call',params:{
    name:'authorize_existing_derived_binding',arguments:{name:'forest.plots',kind:'plots'}}},
    {...CONFIG,fetch});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'http://127.0.0.1:19090/authorize_derived');
  assert.deepEqual([...calls[0].options.body.entries()],[['name','forest.plots'],['kind','plots']]);
  assert.equal(JSON.parse(result.result.content[0].text).status,'approval_required');
  assert.ok(tools.some(tool=>tool.name==='authorize_existing_derived_binding'));
});

test('get_plot_history accepts no arguments and posts an empty body to /plots', async () => {
  const { fetch, calls } = recordingFetch({
    count: 3, active_index: 2,
    plots: [{ index: 0, rendered: false }, { index: 1, rendered: false }, { index: 2, rendered: true }],
    truncated: false, max_plots: 100
  });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'get_plot_history', arguments: {} } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/plots');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual([...calls[0].options.body.keys()], []);
  assert.equal(calls[0].options.headers['X-RAI-Bridge-Token'], undefined);

  const result = JSON.parse(message.result.content[0].text);
  assert.equal(result.count, 3);
  assert.equal(result.active_index, 2);
});

test('get_plot_history rejects an index or any other argument before a network call', async () => {
  for (const args of [{ index: 0 }, { path: '/tmp/plot.png' }, { count: 3 }, { run_id: 'run-abc' }]) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 46, method: 'tools/call', params: { name: 'get_plot_history', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('get_plot_image forwards only a validated integer history index to /plot', async () => {
  const calls = [];
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngResponse = () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/png', 'content-length': String(png.byteLength) }),
    arrayBuffer: async () => png.buffer
  });
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return pngResponse();
  };

  const message = await handleRequest(
    { jsonrpc: '2.0', id: 47, method: 'tools/call', params: { name: 'get_plot_image', arguments: { index: 2 } } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/plot');
  assert.equal(calls[0].options.body.get('index'), '2');
  assert.deepEqual([...calls[0].options.body.keys()], ['index']);
  assert.deepEqual(message.result.content, [{
    type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64')
  }]);

  // Omitting the index keeps the original argument-free active-plot request
  // byte-for-byte: no index key is invented on the caller's behalf.
  await handleRequest(
    { jsonrpc: '2.0', id: 48, method: 'tools/call', params: { name: 'get_plot_image', arguments: {} } },
    { ...CONFIG, fetch }
  );
  assert.equal(calls.length, 2);
  assert.deepEqual([...calls[1].options.body.keys()], []);
});

test('get_plot_image rejects a non-integer, negative, oversized, or non-index argument before a network call', async () => {
  const cases = [
    { index: -1 },
    { index: 1.5 },
    { index: '2' },
    { index: 1000 },
    { index: null },
    { index: [1] },
    { index: 0, path: '/tmp/plot.png' },
    { plot_index: 0 },
    { history_index: 0 }
  ];
  for (const args of cases) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 49, method: 'tools/call', params: { name: 'get_plot_image', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }

  assert.equal(validatePlotIndex(undefined), undefined);
  assert.equal(validatePlotIndex(0), 0);
  assert.equal(validatePlotIndex(999), 999);
  assert.throws(() => validatePlotIndex(-1), /index must be an integer between 0 and 999/);
  assert.throws(() => validatePlotIndex(1000), /index must be an integer between 0 and 999/);
  assert.throws(() => validatePlotIndex('0'), /index must be an integer between 0 and 999/);
});

test('the new context connectors surface a bounded JSON-RPC error on a native 4xx or timeout', async () => {
  const cases = [
    { tool: 'get_project_context', endpoint: 'project_context' },
    { tool: 'get_environment_summary', endpoint: 'environment' },
    { tool: 'get_plot_history', endpoint: 'plots' }
  ];
  for (const { tool, endpoint } of cases) {
    const { fetch: rejectFetch } = recordingFetch({ status: 'error', message: `${tool} accepts no arguments` });
    const badFetch = async (...fetchArgs) => ({ ...(await rejectFetch(...fetchArgs)), ok: false, status: 400 });
    const rejected = await handleRequest(
      { jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: tool, arguments: {} } },
      { ...CONFIG, fetch: badFetch }
    );
    assert.equal(rejected.error?.code, -32603, tool);
    assert.match(rejected.error.message, new RegExp(`rejected ${endpoint} \\(400\\)`));

    const timeoutFetch = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const timedOut = await handleRequest(
      { jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: tool, arguments: {} } },
      { ...CONFIG, fetch: timeoutFetch, timeoutMs: 5 }
    );
    assert.equal(timedOut.error?.code, -32603, tool);
    assert.match(timedOut.error.message, new RegExp(`did not respond to ${endpoint} within`));
  }
});

// Whether a history index is in range for the live session is the NATIVE
// boundary's decision -- it alone knows plotCount -- and it must arrive as a
// clean tool error rather than as image content.
test('get_plot_image surfaces the native out-of-range rejection for a history index', async () => {
  const fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ status: 'error', message: 'index is outside the current plot history' })
  });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'get_plot_image', arguments: { index: 9 } } },
    { ...CONFIG, fetch }
  );
  assert.equal(message.error?.code, -32603);
  assert.match(message.error.message, /rejected plot \(400\): index is outside the current plot history/);
});

// --- read_project_file --------------------------------------------------
//
// The bridge is deliberately a thin, revalidating relay for this tool: every
// wire-boundary rejection below must happen BEFORE any network call, and the
// only filesystem access anywhere in this pipeline is inside the native
// session process, never in this Node bridge.

test('read_project_file forwards only the encoded relative path to /file', async () => {
  const { fetch, calls } = recordingFetch({ path: 'notes.txt', text: 'hello project', truncated: false });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'notes.txt' } } },
    { ...CONFIG, fetch }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/file');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual([...calls[0].options.body.keys()], ['path']);
  assert.equal(calls[0].options.body.get('path'), 'notes.txt');
  assert.equal(calls[0].options.headers['X-RAI-Bridge-Token'], undefined);

  const result = JSON.parse(message.result.content[0].text);
  assert.equal(result.path, 'notes.txt');
  assert.equal(result.text, 'hello project');
  assert.equal(result.truncated, false);
});

test('read_project_file relays environment source reads with original spelling, paging and token', async () => {
  for (const path of ['.Renviron', '.Rprofile', '.env', 'nested/.env.local', '.ENVRC',
    'renv.lock', 'session.RData', 'nested\\.Renviron']) {
    const { fetch, calls } = recordingFetch({ path, offset: 65536, text: 'RAI_DUMMY_ENV=unchanged',
      truncated: false, next_offset: null, total_bytes: 65560 });
    const response = await handleRequest({ jsonrpc: '2.0', id: 603, method: 'tools/call',
      params: { name: 'read_project_file', arguments: { path, offset: 65536 } } }, { ...CONFIG, fetch });
    assert.equal(response.error, undefined, path);
    assert.equal(calls.length, 1, path);
    assert.equal(calls[0].url, 'http://127.0.0.1:19090/file');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['X-RAI-Bridge-Token'], undefined);
    assert.deepEqual([...calls[0].options.body.keys()], ['path', 'offset']);
    assert.equal(calls[0].options.body.get('path'), path);
    assert.equal(calls[0].options.body.get('offset'), '65536');
    assert.equal(JSON.parse(response.result.content[0].text).text, 'RAI_DUMMY_ENV=unchanged');
  }
});

test('read_project_file refuses internal auth/state before any native fetch', async () => {
  for (const path of ['.raistudio/assistant.json', 'nested/.RAISTUDIO/mcp.json',
    'nested\\.raistudio\\state.json']) {
    const { fetch, calls } = recordingFetch({});
    const response = await handleRequest({ jsonrpc: '2.0', id: 604, method: 'tools/call',
      params: { name: 'read_project_file', arguments: { path } } }, { ...CONFIG, fetch });
    assert.equal(response.error?.code, -32603, path);
    assert.match(response.error.message, /protected environment/i);
    assert.equal(calls.length, 0, path);
  }
});

test('open-document read descriptions refuse secret locations and keep environment writes refused', () => {
  for (const name of ['list_open_documents', 'get_active_document_context', 'read_open_document']) {
    const description = tools.find(tool => tool.name === name).description;
    assert.doesNotMatch(description, /environment.*readable/i, name);
    assert.match(description, /internal.*\.raistudio.*refused/i, name);
    assert.match(description, /known secret locations/i, name);
    assert.match(description, /environment writes remain refused/i, name);
  }
  assert.match(tools.find(tool => tool.name === 'list_open_documents').description, /not RAI edit permission/i);
  assert.match(tools.find(tool => tool.name === 'read_open_document').description, /selected model provider/i);
});

test('read_project_file description refuses the same secret files as run_r', () => {
  const description = tools.find(tool => tool.name === 'read_project_file').description;
  assert.doesNotMatch(description, /environment.*readable/i);
  assert.match(description, /refuses known secret locations \(SSH keys, cloud credentials, \.Renviron, \.env, shell history, browser data, the assistant\'?s own state folder\)/);
  assert.match(description, /internal.*\.raistudio.*refused/i);
  assert.match(description, /selected model provider/i);
});

test('read_project_file forwards a nested project-relative path unchanged', async () => {
  const { fetch, calls } = recordingFetch({ path: 'analysis/scripts/notes.txt', text: 'nested', truncated: false });
  await handleRequest(
    { jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'analysis/scripts/notes.txt' } } },
    { ...CONFIG, fetch }
  );
  assert.equal(calls[0].options.body.get('path'), 'analysis/scripts/notes.txt');
});

test('read_project_file rejects empty, absolute, traversal, NUL, and unsupported/duplicate fields before a network call', async () => {
  const cases = [
    {},
    { path: '' },
    { path: '/etc/passwd' },
    { path: '\\Windows\\System32' },
    { path: 'C:\\secrets.txt' },
    { path: '..' },
    { path: '../secrets.txt' },
    { path: 'analysis/../../secrets.txt' },
    { path: 'analysis/..' },
    { path: 'notes.txt\u0000.R' },
    { path: 'notes.txt', extra: 'nope' },
    { path: 'notes.txt', directory: 'analysis' },
    { path: 'a'.repeat(4097) },
    { path: 123 },
    { path: null },
    { path: ['notes.txt'] }
  ];
  for (const args of cases) {
    const { fetch, calls } = recordingFetch({});
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'read_project_file', arguments: args } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('read_project_file forwards a validated continuation offset to /file', async () => {
  const { fetch, calls } = recordingFetch({ path: 'notes.txt', offset: 65536, text: 'page 2', truncated: false, next_offset: null, total_bytes: 70000 });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 601, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'notes.txt', offset: 65536 } } },
    { ...CONFIG, fetch }
  );
  assert.equal(message.error, undefined);
  assert.equal(calls.length, 1);
  const body = String(calls[0].options.body);
  assert.match(body, /path=notes.txt/);
  assert.match(body, /offset=65536/);
  for (const offset of [-1, 1.5, '65536', 10485761]) {
    const { fetch: rejectedFetch, calls: rejectedCalls } = recordingFetch({});
    const rejected = await handleRequest(
      { jsonrpc: '2.0', id: 602, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'notes.txt', offset } } },
      { ...CONFIG, fetch: rejectedFetch }
    );
    assert.equal(rejected.error?.code, -32603);
    assert.equal(rejectedCalls.length, 0);
  }
});

test('validateProjectFilePath accepts ordinary project-relative paths and rejects escapes directly', () => {
  assert.equal(validateProjectFilePath('notes.txt'), 'notes.txt');
  assert.equal(validateProjectFilePath('analysis/scripts/run.R'), 'analysis/scripts/run.R');
  assert.throws(() => validateProjectFilePath(''), /non-empty string/);
  assert.throws(() => validateProjectFilePath('/etc/passwd'), /not absolute/);
  assert.throws(() => validateProjectFilePath('../secrets'), /"\.\." component/);
  assert.throws(() => validateProjectFilePath('a/../../b'), /"\.\." component/);
  assert.throws(() => validateProjectFilePath('a\u0000b'), /NUL byte/);
  assert.throws(() => validateProjectFilePath('C:\\secrets.txt'), /not absolute/);
  assert.throws(() => validateProjectFilePath(42), /non-empty string/);
});

test('read_project_file preserves the native rejection message for no-project, directory, binary, and oversized files', async () => {
  const cases = [
    'read_project_file requires an active RStudio project',
    'path is a directory, not a file',
    'file is not valid UTF-8/plain text',
    'file exceeds 64 KB',
    'path resolves outside the active project',
    'path does not exist in the active project'
  ];
  for (const nativeMessage of cases) {
    const fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ status: 'error', message: nativeMessage })
    });
    const message = await handleRequest(
      { jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'notes.txt' } } },
      { ...CONFIG, fetch }
    );
    assert.equal(message.error?.code, -32603, nativeMessage);
    assert.match(message.error.message, new RegExp(`rejected file \\(400\\): ${nativeMessage.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  }
});

test('read_project_file independently caps an oversized native text response at 64 KB even if malformed', async () => {
  const oversizedText = 'x'.repeat(64 * 1024 + 1);
  const fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ path: 'notes.txt', text: oversizedText, truncated: false })
  });
  const message = await handleRequest(
    { jsonrpc: '2.0', id: 64, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'notes.txt' } } },
    { ...CONFIG, fetch }
  );
  assert.equal(message.error?.code, -32603);
  assert.match(message.error.message, /exceeding the 64 KB page bound/);
});

test('read_project_file times out cleanly like every other native connector', async () => {
  const timeoutFetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const timedOut = await handleRequest(
    { jsonrpc: '2.0', id: 65, method: 'tools/call', params: { name: 'read_project_file', arguments: { path: 'notes.txt' } } },
    { ...CONFIG, fetch: timeoutFetch, timeoutMs: 5 }
  );
  assert.equal(timedOut.error?.code, -32603);
  assert.match(timedOut.error.message, /did not respond to file within/);
});

// The monitor is a read-only observer: it samples the native capture every five
// seconds, identifies a five-minute quiet interval, and ends monitoring at two
// hours. It never posts R code, never interrupts R, and never stretches a test
// over real time -- all time is injected.
test('monitorConsoleRun detects a quiet long-running run without mutating the Console', async () => {
  let now = 0;
  const calls = [];
  const samples = [
    { status: 'running', run_id: 'run-long', elapsed_ms: 0, stdout: 'phase 1\n', stderr: '', output_bytes: 8, tainted: false },
    { status: 'running', run_id: 'run-long', elapsed_ms: 300000, stdout: 'phase 1\n', stderr: '', output_bytes: 8, tainted: false }
  ];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const sample = calls.length === 1 ? samples[0] : samples[1];
    return { ok: true, status: 200, json: async () => sample };
  };
  const result = await monitorConsoleRun('run-long', {
    ...CONFIG,
    fetch,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    pollIntervalMs: 5000,
    noOutputMs: 300000,
    monitorTimeoutMs: 7200000
  });

  assert.equal(result.status, 'timed_out');
  assert.equal(result.run_id, 'run-long');
  assert.equal(result.elapsed_ms, 300000);
  assert.equal(calls.length, 1441);
  assert.ok(calls.every((call) => call.url.endsWith('/monitor')));
  assert.ok(calls.every((call) => call.options.body.get('run_id') === 'run-long'));
  assert.equal(calls.some((call) => /\/(run|interrupt|kill)$/.test(call.url)), false);
});

test('monitorConsoleRun emits metadata-only running and settled browser inspector snapshots', async () => {
  let now = 1000;
  const snapshots = [];
  const samples = [
    { status: 'running', run_id: 'run-visible', elapsed_ms: 1000, output_bytes: 3000, stdout: 'x'.repeat(3000), stderr: '' },
    { status: 'ok', run_id: 'run-visible', elapsed_ms: 6000, output_bytes: 3004, stdout: `${'x'.repeat(3000)}done`, stderr: '' }
  ];
  const result = await monitorConsoleRun('run-visible', {
    ...CONFIG,
    fetch: async () => ({ ok: true, status: 200, json: async () => samples.shift() }),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    onSnapshot: (snapshot) => { snapshots.push(snapshot); }
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(snapshots, [
    {
      state: 'running', elapsed_ms: 1000, quiet_ms: 0, output_bytes: 3000,
      output_growth_bytes: 3000, deadline_ms: 7200000
    },
    {
      state: 'settled', elapsed_ms: 6000, quiet_ms: 0, output_bytes: 3004,
      output_growth_bytes: 4, deadline_ms: 7195000
    }
  ]);
});

test('monitorConsoleRun retains output bytes when terminal not_running omits capture fields', async () => {
  let now = 1000;
  const snapshots = [];
  const terminalSnapshot = { status: 'not_running', run_id: 'run-terminal', elapsed_ms: 6000 };
  const samples = [
    {
      status: 'running', run_id: 'run-terminal', elapsed_ms: 1000,
      output_bytes: 18, stdout: 'browser-secret-output', stderr: ''
    },
    terminalSnapshot
  ];

  const result = await monitorConsoleRun('run-terminal', {
    ...CONFIG,
    fetch: async () => ({ ok: true, status: 200, json: async () => samples.shift() }),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    onSnapshot: (snapshot) => { snapshots.push(snapshot); }
  });

  assert.deepEqual(result, terminalSnapshot, 'tool return must remain the native terminal result');
  assert.deepEqual(snapshots, [
    {
      state: 'running', elapsed_ms: 1000, quiet_ms: 0, output_bytes: 18,
      output_growth_bytes: 18, deadline_ms: 7200000
    },
    {
      state: 'awaiting_result', elapsed_ms: 6000, quiet_ms: 5000, output_bytes: 18,
      output_growth_bytes: 0, deadline_ms: 7195000
    }
  ]);
  assert.equal(JSON.stringify(snapshots).includes('browser-secret-output'), false);
  assert.ok(snapshots.every((snapshot) =>
    Object.keys(snapshot).every((key) =>
      ['state', 'elapsed_ms', 'quiet_ms', 'output_bytes', 'output_growth_bytes', 'deadline_ms'].includes(key))));
});

test('stalled monitoring reports bounded unavailable recovery context when Console remains busy', async () => {
  let now = 0;
  const calls = [];
  const fetch = async (url, options) => {
    const endpoint = String(url);
    calls.push({ url: endpoint, options });
    if (endpoint.endsWith('/monitor')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'running', run_id: 'run-busy-context', output_bytes: 0, stdout: '', stderr: ''
      }) };
    }
    if (/\/(environment|active_document|documents)$/.test(endpoint)) {
      throw new Error(`native R session did not respond to ${endpoint.split('/').pop()} within 5ms`);
    }
    throw new Error(`unexpected native endpoint: ${endpoint}`);
  };

  const response = await handleRequest(
    { jsonrpc: '2.0', id: 82, method: 'tools/call', params: { name: 'monitor_console_run', arguments: { run_id: 'run-busy-context' } } },
    {
      ...CONFIG,
      fetch,
      runSessionRegistry: { sessionFor: () => undefined },
      now: () => now,
      sleep: async (ms) => { now += ms; },
      pollIntervalMs: 300000,
      noOutputMs: 300000,
      monitorTimeoutMs: 7200000
    }
  );

  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, 'timed_out');
  assert.deepEqual(result.recovery, {
    context: {
      status: 'unavailable_while_console_busy',
      message: 'R is still busy; recovery context was not read and no R code was run'
    }
  });
  assert.equal(calls.filter(({ url }) => /\/(run|interrupt|kill|cancel|retry)$/.test(url)).length, 0);
});

test('monitorConsoleRun returns a settled native result immediately and stops at its two-hour monitor budget', async () => {
  const settledCalls = [];
  const settled = await monitorConsoleRun('run-settled', {
    ...CONFIG,
    fetch: async (url, options) => {
      settledCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ status: 'ok', run_id: 'run-settled', stdout: '[1] 42' }) };
    },
    sleep: async () => { throw new Error('settled monitor must not sleep'); }
  });
  assert.equal(settled.status, 'ok');
  assert.equal(settledCalls.length, 1);

  let now = 0;
  const timeoutCalls = [];
  const timedOut = await monitorConsoleRun('run-timeout', {
    ...CONFIG,
    fetch: async (url, options) => {
      timeoutCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ status: 'running', run_id: 'run-timeout', output_bytes: 0, stdout: '', stderr: '' }) };
    },
    now: () => now,
    sleep: async (ms) => { now += ms; },
    pollIntervalMs: 7200000,
    noOutputMs: 7200001,
    monitorTimeoutMs: 7200000
  });
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.monitor_elapsed_ms, 7200000);
  assert.equal(timeoutCalls.length, 2);
  assert.ok(timeoutCalls.every((call) => call.url.endsWith('/monitor')));
});

test('editor tool advertises automatic application, native revalidation and legacy pending-request observation', () => {
  const description=tools.find(tool=>tool.name==='edit_document').description;
  assert.match(description,/automatically approved.*without an approval card.*applying/i);
  assert.doesNotMatch(description,/Full Auto|when disabled|requires exact native Allow-once/i);
  assert.match(description,/legacy.*approval_required/i);
  assert.match(description,/revalidates document identity, the unique anchor\/context, read-only state and the buffer audit/i);
  assert.match(description,/Undo/);
  assert.match(description,/\.Rprofile.*refused outright and never offered for approval/i);
  assert.match(description,/applying or approval_required.*identical arguments/i);
  assert.doesNotMatch(description,/Allow-once.*regardless/i);
});
test('run_r advertises the original-data refusal and durable exact-code trace without an immutability claim', () => {
  const description=tools.find(tool=>tool.name==='run_r').description;
  assert.match(description,/Original data is never edited directly/);
  assert.match(description,/refused outright.*never offered for approval/i);
  assert.match(description,/NEW object name or a NEW literal file path/);
  assert.match(description,/durable local trace/);
  assert.match(description,/not complete lineage/);
  assert.doesNotMatch(description,/Full Auto|when disabled|exact native approval is required/i);
  assert.match(description,/automatically approved/);
  assert.doesNotMatch(description,/guarantee/i);
});
test('pending automatic editor result explains polling to a terminal native outcome', async () => {
  const calls=[];
  const config={token:'test',healthUrl:'http://127.0.0.1:1234/health',fetch:async(url)=>{
    calls.push(url);return {ok:true,json:async()=>({status:'applying',request_id:'request-auto',approval:'autonomous'})};
  }};
  const result=await handleRequest({id:1,method:'tools/call',params:{name:'edit_document',arguments:{document_id:'doc-a',expected_text:'old',replacement:'new'}}},config);
  const value=JSON.parse(result.result.content[0].text);
  assert.equal(value.status,'applying');
  assert.match(value.approval_observation,/identical arguments.*applied or error/i);
  assert.equal(calls.length,1);
});
test('editor target validation is unchanged: invalid document ids never reach native', async () => {
  const calls=[];
  const config={token:'test',healthUrl:'http://127.0.0.1:1234/health',fetch:async(url)=>{calls.push(url);return {ok:true,json:async()=>({status:'applying'})};}};
  const result=await handleRequest({id:1,method:'tools/call',params:{name:'edit_document',arguments:{document_id:'../.Rprofile',expected_text:'old',replacement:'new'}}},config);
  assert.ok(result.error || result.result?.isError, JSON.stringify(result));
  assert.equal(calls.length,0);
});
test('pending editor result explains status polling without creating another edit', async () => {
  const calls=[];
  const config={token:'test',healthUrl:'http://127.0.0.1:1234/health',fetch:async(url,options)=>{
    calls.push(url);return {ok:true,json:async()=>({status:'approval_required',request_id:'request-one'})};
  }};
  const result=await handleRequest({id:1,method:'tools/call',params:{name:'edit_document',arguments:{document_id:'doc-a',expected_text:'old',replacement:'new'}}},config);
  const value=JSON.parse(result.result.content[0].text);
  assert.equal(value.status,'approval_required');
  assert.match(value.approval_observation,/identical arguments.*same request/i);
  assert.equal(calls.length,1);
});

test('S10c whole-buffer mode sends empty and large contents; rejects mixed and incomplete arguments before fetch', async () => {
  const h = recordingFetch({status:'applying',approval:'autonomous'});
  const call = arguments_ => handleRequest({id:1,method:'tools/call',params:{name:'edit_document',arguments:arguments_}}, {...CONFIG,fetch:h.fetch});
  const base = {document_id:'doc_42',expected_digest:'a'.repeat(64),contents:''};
  for (const args of [{document_id:'doc_42'}, {...base,expected_text:'old'}, {...base,replacement:'x'},
    {...base,context_before:'x',context_after:'y'}, {document_id:'doc_42',contents:''},
    {document_id:'doc_42',expected_digest:'a'.repeat(64)}, {...base,expected_digest:'bad'},
    {...base,contents:'x'.repeat(10*1024*1024+1)}]) {
    assert.ok((await call(args)).error); assert.equal(h.calls.length,0);
  }
  for (const contents of ['', 'x'.repeat(1048577)]) {
    const result = await call({...base,contents}); assert.equal(result.error,undefined);
    const sent = h.calls.at(-1); assert.equal(new URL(sent.url).pathname,'/edit');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(sent.options.body)),{...base,contents});
  }
});


test('S10d write tool exists and relays whole contents only to write', async () => {
  const listed=await handleRequest({id:1,method:'tools/list'},CONFIG);
  const tool=listed.result.tools.find(t=>t.name==='write_project_file'); assert.ok(tool,'write tool absent');
  assert.deepEqual(tool.inputSchema.required,['path','expected_digest','contents']);
  const h=recordingFetch({status:'applied',approval:'autonomous'});
  const args={path:'src/a.R',expected_digest:'a'.repeat(64),contents:''};
  for (const contents of ['', 'x'.repeat(1048577)]) {
    const response=await handleRequest({id:1,method:'tools/call',params:{name:'write_project_file',arguments:{...args,contents}}},{...CONFIG,fetch:h.fetch});
    assert.equal(response.error,undefined,'write route absent');
    assert.equal(new URL(h.calls.at(-1).url).pathname,'/write');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(h.calls.at(-1).options.body)),{...args,contents});
  }
});
test('S10d write syntactic refusals never fetch',async()=> {
  const h=recordingFetch({status:'applied'});
  const base={path:'src/a.R',expected_digest:'a'.repeat(64),contents:'x'};
  for (const args of [{...base,path:'/a.R'},{...base,path:'../a.R'},{...base,path:'.raistudio/a.R'},
    {...base,path:'a\0.R'},{...base,contents:'x'.repeat(10*1024*1024+1)},{...base,contents:'x\0'},
    {...base,contents:'\ud800'},{...base,expected_digest:'bad'},{...base,extra:1},
    {path:'src/a.R',contents:'x'}]) {
    assert.ok((await handleRequest({id:1,method:'tools/call',params:{name:'write_project_file',arguments:args}},{...CONFIG,fetch:h.fetch})).error);
    assert.equal(h.calls.length,0);
  }
});


test('S10d write call reaches native route',async()=> {
  const h=recordingFetch({status:'applied',approval:'autonomous'});
  const response=await handleRequest({id:1,method:'tools/call',params:{name:'write_project_file',arguments:{path:'a.R',expected_digest:'a'.repeat(64),contents:'new'}}},{...CONFIG,fetch:h.fetch});
  assert.equal(response.error,undefined,'write route absent');
  assert.equal(h.calls.length,1); assert.equal(new URL(h.calls[0].url).pathname,'/write');
});

for (const name of ['edit_document', 'write_project_file']) test(`S10e tools/list ${name} policy`, async () => {
  const response = await handleRequest({id:1,method:'tools/list'}, CONFIG);
  const description = response.result.tools.find(t => t.name === name).description;
  assert.match(description, /read whole file first/i, 'S10e read-first');
  assert.match(description, /code files only/i, 'S10e code-only');
  assert.match(description, /RAI saves its own applied edits to disk automatically and no setting turns this off/, 'S11 always-on save statement');
  assert.match(description, /raw, reference, data, environment, config and unknown/i, 'S10e denied classes');
  assert.match(description, /must be edited by the user/i, 'S10e user refusal');
  assert.match(description, /deny wins/i, 'S10e deny precedence');
  assert.match(description, /native Bash\/Edit.*unaffected/i, 'S10e native boundary');
  assert.doesNotMatch(description, /config files are editable/i, 'S10e no config permission');
  if (name === 'edit_document') {
    assert.match(description, /expected_digest.*contents.*mutually exclusive.*expected_text.*replacement/i, 'S10e both edit modes');
    assert.doesNotMatch(description, /never writes a file to disk/, 'S10e no false persistence promise');
  } else {
    assert.match(description, /existing.*unopened.*project/i, 'S10e existing unopened target');
    assert.match(description, /no file creation/i, 'S10e no creation');
    assert.match(description, /\/write/, 'S10e write route');
  }
});
for (const name of ['read_open_document','read_project_file']) test(`S10e tools/list ${name} authority`, async () => {
  const response = await handleRequest({id:1,method:'tools/list'}, CONFIG);
  const description = response.result.tools.find(t => t.name === name).description;
  assert.match(description, /only.*full.*code.*read.*token/i, 'S10e full code read authority');
  assert.match(description, /contiguous.*zero/i, 'S10e contiguous pages');
  assert.match(description, /partial.*final-page-only.*run_r.*do not mint/i, 'S10e no partial or Console authority');
});

for (const [name, text] of [
  ['tool', tools.find(tool=>tool.name==='edit_document').description],
  ['companion', readFileSync(new URL('../prompts/RAI-Assistant.md',import.meta.url),'utf8')],
  ['audit', readFileSync(new URL('../skills/rai-audit/SKILL.md',import.meta.url),'utf8')]
]) test(`S11 fix2 exact buffer persistence description ${name}`, () => {
  const expected="edit_document waits for the editor preimage acknowledgement. A conflict preserves the human buffer and reports conflict. A clean named UTF-8/LF code document is saved automatically through the common editor save core after completion tracing and a durable pre-edit backup, without formatting or source-on-save execution. Native rechecks authorization, path, classifier and authorized disk identity/bytes at the write boundary. Untitled documents stay unsaved; unrelated dirty state is refused. Only saved=true confirms disk persistence; save failures report Edit applied; file not saved and retain dirty state. Identical polling and acknowledgements are cached, and a settled applied or failure result is replayed to an identical call only within 30 seconds after the edit settled; never replay an uncertain disk write. Editor Undo changes the buffer only. Disk rollback requires matching editor and disk postimages. A filesystem check/write race remains because arbitrary external writers do not participate in compare-and-swap.";
  assert.equal(text.includes(expected),true,'S11 fix2 exact buffer persistence contract');
  assert.equal(text.includes('save/rollback checks'),false,'S11 fix2 no disk-save overclaim');
  assert.equal(text.includes('save/rollback diagnostics'),false,'S11 fix2 no ambiguous save diagnostics');
});
