import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RaiAuditService, AUDIT_PHASES } from './rai-audit.js';
import { validateRConsoleProposal } from './rcode-distiller.js';

// Claude Code and Codex show MCP tools as mcp__<server>__<tool>. OpenCode shows <server>.<tool> and Grok <server>__<tool>, so those two get the bare server name, which every form contains.
const BARE_SERVER_NAME_PROVIDERS = new Set(['opencode', 'grok']);
export function renderSessionInstructions(text, serverName = 'rai', provider = 'claude') {
  if (typeof serverName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(serverName)) throw new Error('invalid RAI MCP server name');
  const name = BARE_SERVER_NAME_PROVIDERS.has(provider) ? serverName : `mcp__${serverName}__*`;
  return text.replaceAll('{{RAI_MCP_SERVER}}', () => name);
}

const sessions = new WeakMap();
const digest = value => createHash('sha256').update(value).digest('hex');
const scalar = value => Array.isArray(value) && value.length === 1 ? value[0] : value;
const toolNames = new Set(['get_audit_workflow', 'audit_session']);
const boundReadTools = new Set(['get_active_document_context', 'list_open_documents', 'read_open_document', 'get_project_context', 'read_project_file', 'get_environment_summary', 'get_plot_history', 'list_notebook_outputs', 'get_viewer_state']);
// A source page is up to 64 KB of text (MAX_PROJECT_FILE_TEXT_BYTES in rai-native-mcp.js); JSON escaping of newlines, quotes and backslashes can double it, and the path and page fields ride along. With the 500-record bound, stored evidence text can reach about 74M chars (500 x 147456), up from about 33M under a flat 64 KB cap.
const MAX_EVIDENCE_CHARS = 64 * 1024, MAX_PAGE_EVIDENCE_CHARS = 2 * 64 * 1024 + 16 * 1024;
export const auditTools = [
  {name:'get_audit_workflow', description:'Load the packaged portable rai-audit workflow and its evidence-linked phases. This reads only the fixed packaged skill, never project instructions or memory.',
    inputSchema:{type:'object', properties:{}, additionalProperties:false}},
  {name:'audit_session', description:'Start, checkpoint, inspect, resume, or cancel a session-owned audit. Cancellation stops orchestration only, never R. Checkpoints require IDs from actual native evidence plus explicit expected-output checks. Resume is supported only in this owning MCP session; process/session/source changes invalidate evidence. It cannot execute R or edit documents.',
    inputSchema:{type:'object', properties:{action:{type:'string',enum:['start','status','resume','checkpoint','cancel']},audit_id:{type:'string'},phase:{type:'integer',minimum:0,maximum:12},evidence_ids:{type:'array',minItems:1,maxItems:20,items:{type:'string'}},checks:{type:'array',minItems:1,maxItems:20,items:{type:'string',minLength:1,maxLength:2000}},skip_reason:{type:'string',maxLength:512},findings:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['file','line','finding','status','evidence_id'],properties:{file:{type:'string'},line:{type:'integer',minimum:1},finding:{type:'string'},status:{type:'string',enum:['open','flagged','confirmed','fixed']},evidence_id:{type:'string'}}}}},required:['action'],additionalProperties:false}}
];

function stateFor(config) {
  if (!sessions.has(config)) {
    const state = {identity:null, activeId:null, evidence:new Map(), ownedRuns:new Map(), rejectedRuns:new Map(), pendingProposals:new Set()};
    state.service = new RaiAuditService({getVerifiedIdentity:()=>state.identity, makeId:prefix=>`${prefix}-${randomUUID()}`});
    sessions.set(config,state);
  }
  return sessions.get(config);
}

const identityError = (message, cause) => Object.assign(new Error(message), {auditCause: cause});

const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
export function isTransientNativeFailure(error) {
  if (error?.name === 'AbortError') return true;
  if (error instanceof TypeError && error.message === 'fetch failed') return true;
  if (NETWORK_ERROR_CODES.has(error?.code) || NETWORK_ERROR_CODES.has(error?.cause?.code)) return true;
  return /^native R session did not respond to \S+ within \d+ms$/.test(error?.message ?? '');
}

async function identityFor(config, io) {
  const before = await io.health(config);
  if (!before?.session_id || before.console_busy !== false || typeof before.console_epoch !== 'string' || typeof before.source_revision !== 'string') throw identityError('audit requires an idle native session with busy/epoch evidence; busy or unavailable', 'transient');
  const active = await io.endpoint('active_document',{},config);
  if (!active.document_id) throw identityError('audit requires an active open document', 'no_document');
  const project = await io.endpoint('project_context',{},config);
  if (project.project_active !== true) throw identityError('audit requires an active project', 'no_project');
  // New native sessions expose a digest of the entire live buffer without
  // transferring it. Older sessions remain supported for <=64 KB documents.
  const digestFromActive = typeof active.content_digest === 'string' && /^[a-f0-9]{64}$/.test(active.content_digest)
    ? active.content_digest : null;
  const document = digestFromActive ? null : await io.endpoint('document',{document_id:active.document_id},config);
  if (!digestFromActive && (document.document_id !== active.document_id || typeof document.contents !== 'string' || document.next_offset !== undefined))
    throw new Error('audit document identity unavailable; native full-buffer digest required for paging');
  const after = await io.health(config);
  if (before.session_id !== after.session_id) throw identityError('native identity changed while reading audit context', 'session_changed');
  if (before.console_epoch !== after.console_epoch || before.source_revision !== after.source_revision || after.console_busy !== false) throw identityError('native identity changed while reading audit context', 'transient');
  return {session_id:before.session_id, project_id:digest(JSON.stringify({project,source_revision:before.source_revision})), document_id:active.document_id,
    source_digest:digestFromActive ?? digest(document.contents), native_generation:before.console_epoch};
}

const sameSource = (a,b) => ['session_id','project_id','document_id','source_digest'].every(key=>a[key]===b[key]);
const sameIdentity = (a,b) => sameSource(a,b) && a.native_generation===b.native_generation;

function requireOwnedCompletionFirst(state,live,auditId=state.activeId) {
  if(auditId===state.activeId && state.service.snapshot(auditId).status==='active' &&
     sameSource(live,state.identity) && live.native_generation!==state.identity.native_generation && state.ownedRuns.size) {
    const id=[...state.ownedRuns.keys()].at(-1);
    throw new Error(`owned Console run ${id} requires verified completion: use monitor_console_run/get_run_result for the SAME run before audit reads or checkpoints; do not resubmit R`);
  }
}

export async function beginAuditEvidence(config,io) {
  const state=sessions.get(config);
  if (!state?.activeId || state.service.snapshot(state.activeId).status !== 'active') return undefined;
  let live;
  try { live=await identityFor(config,io); }
  catch (error) {
    if (['no_document','no_project','session_changed'].includes(error?.auditCause)) state.service.invalidateAudit(state.activeId,error.auditCause);
    else if (error?.auditCause !== 'transient' && !isTransientNativeFailure(error)) throw error;
    return undefined;
  }
  if (!sameIdentity(live,state.identity)) {
    requireOwnedCompletionFirst(state,live);
    const prior=state.service.snapshot(state.activeId);
    state.identity=live;
    state.service.resumeAudit(prior);
    throw new Error('audit identity changed before evidence collection');
  }
  return live;
}

export async function handleAuditTool(name,args,config,io) {
  if (!toolNames.has(name)) return undefined;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid audit arguments');
  if (name === 'get_audit_workflow') {
    if (Object.keys(args).length) throw new Error('unsupported workflow arguments');
    if (!process.env.RAI_MCP_SERVER_NAME) throw new Error('RAI_MCP_SERVER_NAME is required for get_audit_workflow; set it to the registered MCP server name (rai only for an explicit bare rai registration)');
    return {phases:AUDIT_PHASES, instructions:renderSessionInstructions(readFileSync(new URL('./skills/rai-audit/SKILL.md',import.meta.url),'utf8') + '\n' + readFileSync(new URL('./skills/rai-audit/scientific-checks.md',import.meta.url),'utf8'), process.env.RAI_MCP_SERVER_NAME, process.env.RAI_MCP_PROVIDER),
      coverage:'bounded; native metadata is not a complete element-level audit', checkpoint_scope:'owning MCP process only'};
  }
  const fields = {start:['action'],status:['action','audit_id'],resume:['action','audit_id'],cancel:['action','audit_id'],checkpoint:['action','audit_id','phase','evidence_ids','checks','skip_reason','findings']}[args.action];
  if (!fields || Object.keys(args).some(k=>!fields.includes(k))) throw new Error('unsupported audit arguments');
  if (args.action !== 'start' && (typeof args.audit_id !== 'string' || !/^audit-[a-f0-9-]{36}$/.test(args.audit_id))) throw new Error('invalid audit_id');
  const state = stateFor(config);
  if (args.action === 'start') {
    if (state.activeId && state.service.snapshot(state.activeId).status === 'active') throw new Error('another audit is active');
    state.identity = await identityFor(config,io);
    const {native_generation,...request} = state.identity;
    const audit = state.service.startAudit(request);
    state.activeId = audit.audit_id;
    state.evidence.clear(); state.ownedRuns.clear(); state.rejectedRuns.clear(); state.pendingProposals.clear();
    return audit;
  }
  const audit = state.service.snapshot(args.audit_id);
  if (args.action === 'status') return audit;
  if (args.action === 'cancel') return state.service.cancelAudit(args.audit_id);
  const liveIdentity=await identityFor(config,io);
  requireOwnedCompletionFirst(state,liveIdentity,args.audit_id);
  state.identity = liveIdentity;
  if (args.action === 'resume') return state.service.resumeAudit(audit);
  if (!Number.isInteger(args.phase) || args.phase !== audit.current_phase) throw new Error('phase dependencies are not satisfied');
  const ids = args.evidence_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error('checkpoint requires bounded unique native evidence IDs');
  const evidence = ids.map(id=>state.evidence.get(id));
  if (evidence.some(item=>!item || item.audit_id !== args.audit_id || item.phase !== args.phase)) throw new Error('unknown or stale native evidence');
  for (const item of evidence) {
    if (!sameSource(item.binding,state.identity)) throw new Error('evidence belongs to a different source identity');
    if (item.resource) {
      const value=await io.endpoint(item.resource.endpoint,item.resource.values,config);
      if (value.audit_revision!==item.resource.revision || typeof value[item.resource.field] !== 'string' || digest(value[item.resource.field])!==item.resource.hash) throw new Error('source resource changed since evidence collection');
    }
  }
  if (!sameIdentity(state.identity,await identityFor(config,io))) throw new Error('audit identity changed while verifying evidence');
  if (!Array.isArray(args.checks) || args.checks.length < 1 || args.checks.length > 20 || args.checks.some(check=>typeof check !== 'string' || !check.length || check.length > 2000)) throw new Error('checkpoint requires explicit bounded outcome checks');
  const text = evidence.map(item=>item.outcome_text ?? item.text).join('\n');
  if (args.checks.some(check=>!text.includes(check))) throw new Error('audit outcome check failed');
  if (args.skip_reason !== undefined && (typeof args.skip_reason !== 'string' || !args.skip_reason.trim() || args.skip_reason.length > 512 || args.skip_reason.includes('\0'))) throw new Error('invalid skip reason');
  const findings = args.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 20) throw new Error('findings exceed checkpoint bound');
  for (const finding of findings) {
    if (!finding || Object.keys(finding).some(k=>!['file','line','finding','status','evidence_id'].includes(k)) || !ids.includes(finding.evidence_id)) throw new Error('finding requires matching native evidence');
    if (finding.status === 'fixed') throw new Error('fixed status requires independent applied-edit and recheck evidence; use flagged until verified');
    if (typeof finding.file !== 'string' || !finding.file.length || finding.file.length>512 || /[\r\n\0]/.test(finding.file) || !Number.isInteger(finding.line) || finding.line<1 || finding.line>10000000 || typeof finding.finding !== 'string' || !finding.finding.length || finding.finding.length>2000 || !['open','flagged','confirmed'].includes(finding.status)) throw new Error('invalid finding');
  }
  const claim = state.service.claimPhaseExecution(args.audit_id,args.phase);
  if (claim.status !== 'claimed') throw new Error('phase already claimed');
  try {
    for (const item of evidence) state.service.recordObservation(args.audit_id,args.phase,{file:item.file,line:1,evidence:`${item.id} ${item.tool} sha256:${item.hash}\n${item.text.slice(0,1600)}`,status:'verified'});
    for (const {evidence_id,...finding} of findings) state.service.recordFinding(args.audit_id,args.phase,{...finding,evidence:evidence_id});
    return args.skip_reason ? state.service.skipPhase(args.audit_id,args.phase,claim.execution_id,args.skip_reason) : state.service.completePhase(args.audit_id,args.phase,claim.execution_id);
  } catch (error) {
    state.service.releasePhaseExecution(args.audit_id,args.phase,claim.execution_id);
    throw error;
  }
}

function retireAuditRun(state,id,reason) {
  state.ownedRuns.delete(id);
  state.rejectedRuns.set(id,reason);
  while(state.rejectedRuns.size>64) state.rejectedRuns.delete(state.rejectedRuns.keys().next().value);
}

export async function captureAuditEvidence(name,args,result,config,io,binding) {
  const state = sessions.get(config);
  if (!state?.activeId || toolNames.has(name) || !result || typeof result !== 'object') return result;
  const audit = state.service.snapshot(state.activeId);
  if (audit.status !== 'active') return result;
  if (name==='get_debug_info') return {...result,audit_evidence_unavailable:'historical debug is diagnostic only; use verified get_run_result evidence'};
  if (!binding && boundReadTools.has(name)) return {...result,audit_evidence_unavailable:'audit identity could not be verified for this read; coverage incomplete. Retry when R is idle, or call audit_session cancel'};
  let proposalKey;
  if(name==='run_r') {
    proposalKey=digest(JSON.stringify([validateRConsoleProposal(args.proposal),args.proposal_id ?? null,args.max_lines ?? 200]));
    if(scalar(result.status)==='approval_required') {
      state.pendingProposals.add(proposalKey);
      while(state.pendingProposals.size>64) state.pendingProposals.delete(state.pendingProposals.values().next().value);
    }
  }
  if (name === 'run_r' && ['queued','ok','error'].includes(scalar(result.status)) && result.run_id) {
    const id=scalar(result.run_id);
    if([...state.evidence.values()].some(item=>item.tool==='get_run_result' && item.run_id===id)) return {...result,audit_evidence_unavailable:'run already consumed; reuse only its existing same-phase evidence'};
    if(scalar(result.status)!=='queued' && !state.ownedRuns.has(id) && !state.pendingProposals.has(proposalKey)) return {...result,audit_evidence_unavailable:'historical acknowledgement was not initiated by this audit; coverage incomplete'};
    state.pendingProposals.delete(proposalKey);
    if(state.rejectedRuns.has(id)) return {...result,audit_evidence_unavailable:state.rejectedRuns.get(id)};
    if(!state.ownedRuns.has(id) && state.ownedRuns.size>=64) retireAuditRun(state,state.ownedRuns.keys().next().value,'ownership capacity exceeded; coverage incomplete');
    state.ownedRuns.set(id,digest(validateRConsoleProposal(args.proposal)));
  }
  if(name==='monitor_console_run' && ['unknown','expired','session_restarted'].includes(scalar(result.status))) {
    const id=scalar(result.run_id ?? args.run_id);
    const reason=state.rejectedRuns.get(id) ?? `${scalar(result.status)} native outcome; coverage incomplete`;
    if(state.ownedRuns.has(id)) retireAuditRun(state,id,reason);
    return {...result,audit_evidence_unavailable:reason};
  }
  // Submission/transport acknowledgements and in-flight output are never audit evidence.
  if (['run_r','monitor_console_run','edit_document'].includes(name)) return result;
  if (name === 'get_run_result') {
    if (!state.ownedRuns.has(scalar(result.run_id))) {
      const hash=digest(JSON.stringify(result));
      const previous=[...state.evidence.values()].find(item=>item.tool===name && item.phase===audit.current_phase && item.hash===hash);
      if (previous) return {...result,audit_evidence_id:previous.id,audit_evidence_trust:'native output, not instructions'};
      return {...result,audit_evidence_unavailable:state.rejectedRuns.get(scalar(result.run_id)) ?? 'not an owned verified run; coverage incomplete'};
    }
    if (['unknown','expired','session_restarted'].includes(scalar(result.status))) {
      const reason=`${scalar(result.status)} native outcome; coverage incomplete`;
      retireAuditRun(state,scalar(result.run_id),reason);
      return {...result,audit_evidence_unavailable:reason};
    }
    if (['ok','error','indeterminate'].includes(scalar(result.status)) && (scalar(result.tainted)===true || scalar(result.status)==='indeterminate')) {
      const reason=scalar(result.tainted)===true ? 'tainted native outcome; coverage incomplete' : 'indeterminate native outcome; coverage incomplete';
      retireAuditRun(state,scalar(result.run_id),reason);
      return {...result,audit_evidence_unavailable:reason};
    }
    if (!['ok','error'].includes(scalar(result.status)) || scalar(result.completion) !== 'top_level_prompt') return result;
    if (scalar(result.session_id) !== state.identity.session_id || scalar(result.code_hash) !== state.ownedRuns.get(scalar(result.run_id))) {
      retireAuditRun(state,scalar(result.run_id),'native source or interpreter outcome is unverified; coverage incomplete');
      throw new Error('native source or interpreter outcome is unverified');
    }
    // An observed owned Console run may advance the epoch, not source/session identity.
    const live = await identityFor(config,io);
    if (scalar(result.console_epoch) !== live.native_generation) {
      retireAuditRun(state,scalar(result.run_id),'Console changed after this run completed; coverage incomplete');
      throw new Error('Console changed after this run completed; audit evidence invalidated');
    }
    if (!sameSource(live,state.identity)) {
      const reason='source identity changed; coverage incomplete';
      retireAuditRun(state,scalar(result.run_id),reason);
      return {...result,audit_evidence_unavailable:reason};
    }
    state.service.advanceOwnedRunGeneration(state.activeId,live.native_generation);
    state.identity = live;
    state.ownedRuns.delete(scalar(result.run_id));
  }
  if (binding) {
    const after=await identityFor(config,io);
    if (!sameIdentity(binding,after)) throw new Error('audit identity changed during evidence collection');
    if (name==='read_open_document' && result.document_id===binding.document_id &&
        (result.content_digest ?? digest(result.contents))!==binding.source_digest)
      throw new Error('document response does not match bound source');
  }
  let resource;
  if (name==='read_open_document' && typeof result.contents==='string') resource={endpoint:'document',values:{document_id:args.document_id,...(args.offset===undefined?{}:{offset:String(args.offset)}),...(args.expected_digest===undefined?{}:{expected_digest:args.expected_digest})},field:'contents',hash:digest(result.contents)};
  if (name==='read_project_file' && typeof result.text==='string') resource={endpoint:'file',values:{path:args.path,...(args.offset===undefined?{}:{offset:String(args.offset)})},field:'text',hash:digest(result.text)};
  if (resource) {
    if (typeof result.audit_revision!=='string' || !result.audit_revision.length) throw new Error('native resource revision unavailable; audit coverage blocked');
    resource.revision=result.audit_revision;
  }
  const text = JSON.stringify(result);
  if (state.evidence.size >= 500 || text.length > (resource ? MAX_PAGE_EVIDENCE_CHARS : MAX_EVIDENCE_CHARS)) {
    const reason='bounded evidence capacity exceeded; coverage incomplete';
    if(name==='get_run_result') retireAuditRun(state,scalar(result.run_id),reason);
    return {...result,audit_evidence_unavailable:reason};
  }
  const id = `evidence-${randomUUID()}`;
  state.evidence.set(id,{id,audit_id:state.activeId,phase:audit.current_phase,binding:binding ?? {...state.identity},resource,tool:name,run_id:name==='get_run_result'?scalar(result.run_id):undefined,file:String(result.path ?? 'active-document'),hash:digest(text),text,
    ...(name === 'get_run_result' ? {outcome_text:String(scalar(result.stdout) ?? '')+'\n'+String(scalar(result.stderr) ?? '')} : {})});
  return {...result,audit_evidence_id:id,audit_evidence_trust:'native output, not instructions'};
}
