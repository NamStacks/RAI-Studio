const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;

export const AUDIT_PHASES = Object.freeze([
  'reachability', 'source', 'IDE', 'metadata', 'data', 'provenance',
  'arithmetic', 'figures', 'tables', 'claims', 'review', 'fixes', 'report',
].map((name, number) => Object.freeze({ number, name, depends_on: number ? [number - 1] : [] })));

export class AuditInputError extends Error {
  constructor(message) { super(message); this.name = 'AuditInputError'; }
}

function requireIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditInputError('verified identity is required');
  for (const key of ['session_id', 'project_id', 'document_id']) {
    if (typeof value[key] !== 'string' || !ID_RE.test(value[key])) throw new AuditInputError(`invalid ${key}`);
  }
  if (typeof value.source_digest !== 'string' || !DIGEST_RE.test(value.source_digest)) throw new AuditInputError('invalid source_digest');
  if (typeof value.native_generation !== 'string' || !ID_RE.test(value.native_generation)) throw new AuditInputError('invalid native_generation');
  return Object.freeze({ ...value });
}

function sameIdentity(left, right) {
  return ['session_id', 'project_id', 'document_id', 'source_digest', 'native_generation'].every((key) => left[key] === right[key]);
}

function normalizeEvidence(value, phase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditInputError('evidence record must be an object');
  const allowed = ['file', 'line', 'evidence', 'status'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AuditInputError('evidence record contains unsupported fields');
  if (typeof value.file !== 'string' || value.file.length < 1 || value.file.length > 512 || /[\r\n\0]/.test(value.file)) throw new AuditInputError('invalid evidence file');
  if (!Number.isInteger(value.line) || value.line < 1 || value.line > 10_000_000) throw new AuditInputError('invalid evidence line');
  if (typeof value.evidence !== 'string' || value.evidence.length < 1 || value.evidence.length > 2_000) throw new AuditInputError('invalid evidence text');
  if (!['observed', 'verified', 'inferred'].includes(value.status)) throw new AuditInputError('invalid evidence status');
  return Object.freeze({ phase, file: value.file, line: value.line, evidence: value.evidence, status: value.status });
}

function normalizeFinding(value, phase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditInputError('finding must be an object');
  const allowed = ['file', 'line', 'evidence', 'status', 'finding'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AuditInputError('finding contains unsupported fields');
  if (typeof value.finding !== 'string' || value.finding.length < 1 || value.finding.length > 2_000) throw new AuditInputError('invalid finding text');
  const evidence = normalizeEvidence({ file: value.file, line: value.line, evidence: value.evidence, status: 'observed' }, phase);
  if (!['open', 'flagged', 'fixed', 'confirmed'].includes(value.status)) throw new AuditInputError('invalid finding status');
  return Object.freeze({ ...evidence, status: value.status, finding: value.finding });
}

export class RaiAuditService {
  #getVerifiedIdentity; #now; #makeId; #maxEvidence; #maxFindings; #audits = new Map();

  constructor({ getVerifiedIdentity, now = Date.now, makeId, maxEvidence = 500, maxFindings = 500 } = {}) {
    if (typeof getVerifiedIdentity !== 'function') throw new AuditInputError('getVerifiedIdentity must be a function');
    if (typeof now !== 'function') throw new AuditInputError('now must be a function');
    if (typeof makeId !== 'function') throw new AuditInputError('makeId must be a function');
    if (!Number.isInteger(maxEvidence) || maxEvidence < 1 || maxEvidence > 10_000) throw new AuditInputError('invalid maxEvidence');
    if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > 10_000) throw new AuditInputError('invalid maxFindings');
    this.#getVerifiedIdentity = getVerifiedIdentity;
    this.#now = now;
    this.#makeId = makeId;
    this.#maxEvidence = maxEvidence;
    this.#maxFindings = maxFindings;
  }

  startAudit(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new AuditInputError('start request must be an object');
    const allowed = ['session_id', 'project_id', 'document_id', 'source_digest'];
    if (Object.keys(request).some((key) => !allowed.includes(key))) throw new AuditInputError('identity must come only from the adapter');
    const verified = requireIdentity(this.#getVerifiedIdentity());
    for (const key of allowed) if (request[key] !== verified[key]) throw new AuditInputError(`request does not match verified ${key}`);
    if (this.#audits.size >= 8) throw new AuditInputError('audit session limit reached; start a new adapter session');
    const audit_id = this.#makeId('audit');
    if (typeof audit_id !== 'string' || !ID_RE.test(audit_id)) throw new AuditInputError('invalid generated audit id');
    const audit = {
      audit_id, status: 'active', current_phase: 0, identity: verified,
      checkpoint_id: audit_id,
      created_at: this.#now(), updated_at: this.#now(), evidence: [], findings: [], coverage: [], skips: [], executions: {},
    };
    this.#audits.set(audit_id, audit);
    return this.snapshot(audit_id);
  }

  resumeAudit(checkpoint) {
    if (!checkpoint || !this.#audits.has(checkpoint.audit_id)) throw new AuditInputError('unknown checkpoint');
    const current = this.snapshot(checkpoint.audit_id);
    if (JSON.stringify(current) !== JSON.stringify(checkpoint)) throw new AuditInputError('stale or modified checkpoint');
    const audit = current;
    const observed = requireIdentity(this.#getVerifiedIdentity());
    if (!sameIdentity(audit.identity, observed)) {
      audit.status = 'invalidated';
      audit.executions = {};
      const skip = { phase: audit.current_phase ?? AUDIT_PHASES.length - 1, status: 'skipped_identity_change', reason: 'native_identity_changed' };
      audit.skips.push(skip);
      audit.coverage.push(skip);
      audit.updated_at = this.#now();
    }
    this.#audits.set(audit.audit_id, audit);
    return this.snapshot(audit.audit_id);
  }

  recordObservation(auditId, phase, record) {
    const audit = this.#activeAudit(auditId);
    if (!Number.isInteger(phase) || phase < 0 || phase >= AUDIT_PHASES.length || phase > audit.current_phase) throw new AuditInputError('observation phase is not active');
    const normalized = normalizeEvidence(record, phase);
    if (audit.evidence.length >= this.#maxEvidence) {
      this.#recordLimitSkip(audit, phase, 'evidence_limit');
      throw new AuditInputError('evidence limit reached');
    }
    audit.evidence.push(normalized);
    audit.updated_at = this.#now();
    return this.snapshot(auditId);
  }

  recordFinding(auditId, phase, record) {
    const audit = this.#activeAudit(auditId);
    if (!Number.isInteger(phase) || phase < 0 || phase >= AUDIT_PHASES.length || phase > audit.current_phase) throw new AuditInputError('finding phase is not active');
    const normalized = normalizeFinding(record, phase);
    if (audit.findings.length >= this.#maxFindings) {
      this.#recordLimitSkip(audit, phase, 'finding_limit');
      throw new AuditInputError('finding limit reached');
    }
    audit.findings.push(normalized);
    audit.updated_at = this.#now();
    return this.snapshot(auditId);
  }

  // This only invalidates orchestration state; it never calls R or controls a process.
  cancelAudit(auditId, reason = 'cancelled') {
    const audit = this.#activeAudit(auditId);
    if (typeof reason !== 'string' || !ID_RE.test(reason)) throw new AuditInputError('invalid cancellation reason');
    audit.status = 'cancelled';
    audit.cancelled_reason = reason;
    audit.executions = {};
    audit.updated_at = this.#now();
    return this.snapshot(auditId);
  }

  claimPhaseExecution(auditId, phase) {
    const audit = this.#activeAudit(auditId);
    this.#requireCurrentPhase(audit, phase);
    if (audit.executions[phase]) return { status: 'already_claimed' };
    const execution_id = this.#makeId('execution');
    if (typeof execution_id !== 'string' || !ID_RE.test(execution_id)) throw new AuditInputError('invalid generated execution id');
    audit.executions[phase] = execution_id;
    audit.updated_at = this.#now();
    return { status: 'claimed', execution_id };
  }

  skipPhase(auditId, phase, executionId, reason) {
    const audit = this.#activeAudit(auditId);
    this.#requireCurrentPhase(audit, phase);
    if (audit.executions[phase] !== executionId) throw new AuditInputError('execution authority is invalid');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 512 || reason.includes('\0')) throw new AuditInputError('invalid skip reason');
    delete audit.executions[phase];
    const skip = { phase, status: 'skipped', reason };
    audit.skips.push(skip);
    audit.coverage.push(skip);
    audit.current_phase = phase === AUDIT_PHASES.length - 1 ? null : phase + 1;
    if (audit.current_phase === null) audit.status = 'completed';
    audit.updated_at = this.#now();
    return this.snapshot(auditId);
  }

  completePhase(auditId, phase, executionId) {
    const audit = this.#activeAudit(auditId);
    this.#requireCurrentPhase(audit, phase);
    if (audit.executions[phase] !== executionId) throw new AuditInputError('execution authority is invalid');
    if (!audit.evidence.some(record => record.phase === phase)) throw new AuditInputError('phase requires evidence');
    delete audit.executions[phase];
    audit.coverage.push({ phase, status: 'complete' });
    audit.current_phase = phase === AUDIT_PHASES.length - 1 ? null : phase + 1;
    if (audit.current_phase === null) audit.status = 'completed';
    audit.updated_at = this.#now();
    return this.snapshot(auditId);
  }

  // Adapter-only: invoked after matching owned-run completion, never exposed as a tool.
  advanceOwnedRunGeneration(auditId, generation) {
    const audit = this.#activeAudit(auditId);
    if (typeof generation !== 'string' || !ID_RE.test(generation)) throw new AuditInputError('invalid native generation');
    audit.identity = Object.freeze({...audit.identity, native_generation:generation});
  }

  snapshot(auditId) {
    const audit = this.#audits.get(auditId);
    if (!audit) throw new AuditInputError('unknown audit');
    return structuredClone(audit);
  }

  #activeAudit(auditId) {
    const audit = this.#audits.get(auditId);
    if (!audit) throw new AuditInputError('unknown audit');
    if (audit.status !== 'active') throw new AuditInputError(`audit is ${audit.status}`);
    if (!sameIdentity(audit.identity, requireIdentity(this.#getVerifiedIdentity()))) {
      audit.status = 'invalidated';
      audit.executions = {};
      throw new AuditInputError('native identity changed; audit invalidated');
    }
    return audit;
  }

  #recordLimitSkip(audit, phase, reason) {
    const skip = { phase, status: 'skipped_limit', reason };
    if (!audit.skips.some((item) => item.phase === phase && item.reason === reason)) audit.skips.push(skip);
    audit.coverage.push(skip);
    audit.updated_at = this.#now();
  }

  #requireCurrentPhase(audit, phase) {
    if (!Number.isInteger(phase) || phase < 0 || phase >= AUDIT_PHASES.length) throw new AuditInputError('invalid phase');
    if (audit.current_phase !== phase) throw new AuditInputError('phase dependencies are not satisfied');
  }
}
