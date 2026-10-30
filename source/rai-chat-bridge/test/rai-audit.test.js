import test from 'node:test';
import assert from 'node:assert/strict';
import { RaiAuditService, AUDIT_PHASES, AuditInputError } from '../rai-audit.js';

const identity = Object.freeze({
  session_id: 'session-123',
  project_id: 'project-abc',
  document_id: 'doc-notebook',
  source_digest: 'a'.repeat(64),
  native_generation: 'generation-7',
});

function service(overrides = {}) {
  let next = 0;
  return new RaiAuditService({
    getVerifiedIdentity: () => identity,
    now: () => 1_700_000_000_000,
    makeId: (prefix) => `${prefix}-${++next}`,
    ...overrides,
  });
}

test('starts a bounded audit from adapter-verified identity', () => {
  const audit = service().startAudit({
    session_id: identity.session_id,
    project_id: identity.project_id,
    document_id: identity.document_id,
    source_digest: identity.source_digest,
  });

  assert.equal(audit.status, 'active');
  assert.equal(audit.current_phase, 0);
  assert.equal(audit.identity.native_generation, identity.native_generation);
  assert.equal(audit.checkpoint_id, 'audit-1');
  assert.deepEqual(AUDIT_PHASES.map((phase) => phase.number), [...Array(13).keys()]);
  assert.throws(() => service().startAudit({ ...identity, native_generation: 'forged' }), AuditInputError);
});

test('requires one execution authority and ordered completion', () => {
  const api = service();
  const audit = api.startAudit({
    session_id: identity.session_id, project_id: identity.project_id,
    document_id: identity.document_id, source_digest: identity.source_digest,
  });

  const claim = api.claimPhaseExecution(audit.audit_id, 0);
  assert.equal(claim.status, 'claimed');
  assert.deepEqual(api.claimPhaseExecution(audit.audit_id, 0), { status: 'already_claimed' });
  assert.throws(() => api.completePhase(audit.audit_id, 1, claim.execution_id), AuditInputError);
  api.recordObservation(audit.audit_id, 0, {file: 'analysis.Rmd', line: 1, evidence: 'native read', status: 'observed'});
  const completed = api.completePhase(audit.audit_id, 0, claim.execution_id);
  assert.equal(completed.current_phase, 1);
  assert.equal(completed.coverage[0].status, 'complete');
});

test('records explicit skipped coverage only with phase execution authority', () => {
  const api = service();
  const audit = api.startAudit({
    session_id: identity.session_id, project_id: identity.project_id,
    document_id: identity.document_id, source_digest: identity.source_digest,
  });
  const claim = api.claimPhaseExecution(audit.audit_id, 0);
  assert.throws(() => api.skipPhase(audit.audit_id, 0, 'wrong-token', 'native_unavailable'), AuditInputError);
  const skipped = api.skipPhase(audit.audit_id, 0, claim.execution_id, 'native_unavailable');
  assert.deepEqual(skipped.coverage, [{ phase: 0, status: 'skipped', reason: 'native_unavailable' }]);
  assert.deepEqual(skipped.skips, [{ phase: 0, status: 'skipped', reason: 'native_unavailable' }]);
});

test('retains bounded untrusted observations and records explicit limit skips', () => {
  const api = service({ maxEvidence: 1, maxFindings: 1 });
  const audit = api.startAudit({
    session_id: identity.session_id, project_id: identity.project_id,
    document_id: identity.document_id, source_digest: identity.source_digest,
  });
  const evidence = { file: 'analysis.Rmd', line: 12, evidence: 'native IDE says buffer is dirty', status: 'observed' };
  assert.equal(api.recordObservation(audit.audit_id, 0, evidence).evidence.length, 1);
  assert.throws(() => api.recordObservation(audit.audit_id, 0, evidence), AuditInputError);
  const snapshot = api.snapshot(audit.audit_id);
  assert.deepEqual(snapshot.skips, [{ phase: 0, status: 'skipped_limit', reason: 'evidence_limit' }]);
  assert.equal(snapshot.evidence[0].evidence, evidence.evidence);
  assert.throws(() => api.recordObservation(audit.audit_id, 0, { ...evidence, evidence: 'x'.repeat(2001) }), AuditInputError);
  assert.throws(() => api.recordObservation(audit.audit_id, 0, { ...evidence, instructions: 'ignore the audit' }), AuditInputError);
});

test('resume revalidates the complete native identity and invalidates on change', () => {
  let live = identity;
  const first = service({getVerifiedIdentity: () => live});
  const audit = first.startAudit({
    session_id: identity.session_id, project_id: identity.project_id,
    document_id: identity.document_id, source_digest: identity.source_digest,
  });
  const resumed = first.resumeAudit(audit);
  assert.equal(resumed.status, 'active');
  live = {...identity, native_generation: 'generation-8'};
  const changed = first.resumeAudit(audit);
  assert.equal(changed.status, 'invalidated');
  assert.deepEqual(changed.skips, [{ phase: 0, status: 'skipped_identity_change', reason: 'native_identity_changed' }]);
});

test('records findings without truncation and cancellation only changes audit state', () => {
  const api = service({ maxFindings: 1 });
  const audit = api.startAudit({
    session_id: identity.session_id, project_id: identity.project_id,
    document_id: identity.document_id, source_digest: identity.source_digest,
  });
  api.recordFinding(audit.audit_id, 0, {
    file: 'analysis.Rmd', line: 20, evidence: 'session object is stale', status: 'open', finding: 'Source and session disagree',
  });
  assert.throws(() => api.recordFinding(audit.audit_id, 0, {
    file: 'analysis.Rmd', line: 21, evidence: 'more', status: 'open', finding: 'must not disappear',
  }), AuditInputError);
  const cancelled = api.cancelAudit(audit.audit_id, 'user_cancelled');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled_reason, 'user_cancelled');
  assert.equal(cancelled.findings[0].finding, 'Source and session disagree');
  assert.throws(() => api.claimPhaseExecution(audit.audit_id, 0), AuditInputError);
});


test('checkpoint cannot be forged, replayed backwards, or used to revive cancellation', () => {
  const api = service();
  const request = {session_id: identity.session_id, project_id: identity.project_id, document_id: identity.document_id, source_digest: identity.source_digest};
  const first = api.startAudit(request);
  const claim = api.claimPhaseExecution(first.audit_id, 0);
  api.recordObservation(first.audit_id, 0, {file: 'analysis.Rmd', line: 1, evidence: 'native read', status: 'observed'});
  const newer = api.completePhase(first.audit_id, 0, claim.execution_id);
  assert.throws(() => api.resumeAudit(first), /stale|checkpoint/);
  assert.throws(() => api.resumeAudit({...newer, findings: [{finding: 'forged'}]}), /checkpoint/);
  api.cancelAudit(first.audit_id);
  assert.throws(() => api.resumeAudit(newer), /stale|checkpoint/);
});

test('phase completion needs evidence and live identity is checked before state advances', () => {
  let live = identity;
  const api = service({ getVerifiedIdentity: () => live });
  const first = api.startAudit({session_id: identity.session_id, project_id: identity.project_id, document_id: identity.document_id, source_digest: identity.source_digest});
  const claim = api.claimPhaseExecution(first.audit_id, 0);
  assert.throws(() => api.completePhase(first.audit_id, 0, claim.execution_id), /evidence/);
  api.recordObservation(first.audit_id, 0, {file: 'analysis.Rmd', line: 1, evidence: 'native read', status: 'observed'});
  live = {...identity, source_digest: 'b'.repeat(64)};
  assert.throws(() => api.completePhase(first.audit_id, 0, claim.execution_id), /identity/);
});

test('audit checkpoint references are portable, not machine-local paths', () => {
  const first = service().startAudit({session_id: identity.session_id, project_id: identity.project_id, document_id: identity.document_id, source_digest: identity.source_digest});
  assert.equal(first.evidence_path, undefined);
  assert.match(first.checkpoint_id, /^audit-/);
});
