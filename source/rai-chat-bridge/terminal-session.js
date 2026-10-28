// Bridge-level retained terminal state.
//
// The provider pty is owned here, not by any single browser WebSocket, so an
// "Restart R" iframe reload can reconnect to the SAME conversation instead of
// spawning a new one. Exactly one client is attached at a time; recent pty
// output is kept in a bounded ring buffer and replayed on reconnect; an
// unattached pty is reaped after a bounded grace window.
//
// This module owns no provider, node-pty, or ws details. server.js spawns the
// pty and wires provider I/O, then hands it here for retention -- keeping the
// lifecycle logic pure and testable without a real pty or socket.

const DEFAULT_BUFFER_LIMIT = 512 * 1024; // bytes of recent output replayed on reconnect
const DEFAULT_GRACE_MS = 60_000;         // keep an unattached pty this long before reaping
const DEFAULT_IDLE_MS = 1000;            // no output for this long => CLI idle at its prompt

export function createRetainedTerminal({
  bufferLimit = DEFAULT_BUFFER_LIMIT,
  graceMs = DEFAULT_GRACE_MS,
  idleMs = DEFAULT_IDLE_MS,
  onReap,                       // (term) => void: kill + clean up an unattached pty
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let term = null;
  let client = null;
  let busy = false;
  let idleTimer = null;
  let reapTimer = null;
  const chunks = [];
  let bufferBytes = 0;

  // Ring buffer of recent output. Trims whole chunks from the front, slicing
  // the oldest survivor when needed, so bufferBytes never exceeds the limit --
  // even a single write larger than the limit is capped to its tail. server.js
  // spawns node-pty with encoding:null so this is a Buffer; coerce defensively
  // so a stray string can never throw in the ring math or in Buffer.concat.
  function appendOutput(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    chunks.push(buf);
    bufferBytes += buf.length;
    while (bufferBytes > bufferLimit && chunks.length) {
      const head = chunks[0];
      const over = bufferBytes - bufferLimit;
      if (head.length <= over) {
        chunks.shift();
        bufferBytes -= head.length;
      } else {
        chunks[0] = head.subarray(over);
        bufferBytes -= over;
        break;
      }
    }
  }

  function snapshotOutput() {
    return chunks.length ? Buffer.concat(chunks) : null;
  }

  function clearOutput() {
    chunks.length = 0;
    bufferBytes = 0;
  }

  // Output-activity heuristic: any byte means the CLI is working; no new bytes
  // for idleMs means it has settled at its prompt. A debounce, not a poll.
  function noteActivity(onStatus) {
    if (!busy) {
      busy = true;
      onStatus?.('busy');
    }
    clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      busy = false;
      onStatus?.('idle');
    }, idleMs);
  }

  function stopActivity() {
    clearTimer(idleTimer);
    idleTimer = null;
    busy = false;
  }

  function cancelReap() {
    clearTimer(reapTimer);
    reapTimer = null;
  }

  function scheduleReap() {
    cancelReap();
    if (!term) return;
    reapTimer = setTimer(() => {
      reapTimer = null;
      if (client || !term) return; // a client re-attached, or the pty already exited
      const dead = term;
      term = null;
      clearOutput();
      onReap?.(dead);
    }, graceMs);
  }

  // Attach a new client, returning any previous one so the caller can close it
  // -- exactly one client at a time. Cancels a pending reap.
  function attach(nextClient) {
    const previous = client;
    client = nextClient;
    cancelReap();
    return previous === nextClient ? null : previous;
  }

  // Detach a client. A no-op if it was already replaced by a newer one. Never
  // kills the pty; it stays retained until a reconnect or the grace reap.
  function detach(prevClient) {
    if (client !== prevClient) return;
    client = null;
    scheduleReap();
  }

  return {
    get term() { return term; },
    set term(t) { term = t; },
    get client() { return client; },
    get busy() { return busy; },
    appendOutput,
    snapshotOutput,
    clearOutput,
    noteActivity,
    stopActivity,
    attach,
    detach,
    cancelReap
  };
}
