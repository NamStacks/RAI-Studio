const STATES = new Set(['idle', 'running', 'stalled', 'timed_out', 'awaiting_result', 'settled', 'session_restarted']);
const UPDATE_FIELDS = new Set([
  'state', 'elapsed_ms', 'quiet_ms', 'output_bytes', 'output_growth_bytes',
  'deadline_ms'
]);

export const RUN_INSPECTOR_SAFETY_COPY =
  'Monitoring stopped; R continues untouched. Any recovery requires a fresh strict-R proposal.';

function boundedCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

export function sanitizeRunInspectorSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('run inspector snapshot must be an object');
  }
  if (Object.keys(value).some((key) => !UPDATE_FIELDS.has(key))) {
    throw new Error('run inspector snapshot contains unsupported fields');
  }
  if (!STATES.has(value.state) || value.state === 'idle') {
    throw new Error('run inspector state is invalid');
  }

  const snapshot = {
    state: value.state,
    elapsed_ms: boundedCount(value.elapsed_ms, 'elapsed_ms'),
    quiet_ms: boundedCount(value.quiet_ms, 'quiet_ms'),
    output_bytes: boundedCount(value.output_bytes, 'output_bytes'),
    output_growth_bytes: boundedCount(value.output_growth_bytes, 'output_growth_bytes'),
    deadline_ms: boundedCount(value.deadline_ms, 'deadline_ms')
  };
  if (value.state === 'stalled' || value.state === 'timed_out') {
    snapshot.safety_copy = RUN_INSPECTOR_SAFETY_COPY;
  }
  return Object.freeze(snapshot);
}

export function createRunInspectorState({ onChange = () => {} } = {}) {
  let snapshot = Object.freeze({ state: 'idle' });
  return {
    get() { return snapshot; },
    update(value) {
      snapshot = sanitizeRunInspectorSnapshot(value);
      onChange(snapshot);
      return snapshot;
    },
    reset() {
      snapshot = Object.freeze({ state: 'idle' });
      onChange(snapshot);
      return snapshot;
    }
  };
}
