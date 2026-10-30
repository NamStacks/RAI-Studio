import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRetainedTerminal } from '../terminal-session.js';

// A controllable timer queue so grace/idle timers fire on demand, not by clock.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    set(fn) { const id = ++seq; pending.set(id, fn); return id; },
    clear(id) { pending.delete(id); },
    fireAll() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    size() { return pending.size; }
  };
}

// A stand-in for the node-pty term the bridge would retain.
function fakeTerm(pid = 1234) {
  return { pid, killed: false, kill() { this.killed = true; } };
}

test('detach then reconnect keeps the SAME pty and cancels the reap', () => {
  const timers = fakeTimers();
  let reaped = null;
  const store = createRetainedTerminal({
    graceMs: 1000,
    onReap: t => { reaped = t; },
    setTimer: timers.set,
    clearTimer: timers.clear
  });
  const term = fakeTerm();
  store.term = term;

  const first = {};
  assert.equal(store.attach(first), null);

  // "Restart R" closes the iframe socket.
  store.detach(first);
  assert.equal(store.term, term, 'pty is retained, not killed, on client detach');
  assert.equal(reaped, null);
  assert.equal(timers.size(), 1, 'a bounded reap is armed');

  // The fresh post-Restart-R iframe reconnects before the grace elapses.
  const second = {};
  assert.equal(store.attach(second), null, 'the detached client is gone, nothing to close');
  assert.equal(store.term, term, 'the reconnecting client attaches to the SAME conversation');
  assert.equal(store.client, second);
  assert.equal(timers.size(), 0, 'reconnect cancels the reap');

  timers.fireAll();
  assert.equal(reaped, null, 'no reap fires after a reconnect');
  assert.equal(store.term, term);
});

test('recent output is buffered and replayed on reconnect', () => {
  const store = createRetainedTerminal();
  store.term = fakeTerm();
  assert.equal(store.snapshotOutput(), null, 'nothing to replay before any output');

  store.appendOutput(Buffer.from('hello '));
  store.appendOutput(Buffer.from('world'));

  const snapshot = store.snapshotOutput();
  assert.equal(snapshot.toString(), 'hello world', 'reconnect replays the buffered conversation');
});

test('the replay buffer is bounded to its byte limit', () => {
  const store = createRetainedTerminal({ bufferLimit: 10 });
  store.appendOutput(Buffer.from('abcdefgh')); // 8 bytes
  store.appendOutput(Buffer.from('ijklmn'));   // +6 = 14 > 10 -> trim to the last 10

  const snapshot = store.snapshotOutput();
  assert.equal(snapshot.length, 10);
  assert.equal(snapshot.toString(), 'efghijklmn', 'oldest bytes are dropped, tail is kept');
});

test('a single oversized write is capped to its tail', () => {
  const store = createRetainedTerminal({ bufferLimit: 4 });
  store.appendOutput(Buffer.from('0123456789'));
  const snapshot = store.snapshotOutput();
  assert.equal(snapshot.length, 4);
  assert.equal(snapshot.toString(), '6789');
});

test('a non-Buffer write is coerced so replay never throws', () => {
  // node-pty is spawned with encoding:null (Buffers), but coerce defensively:
  // a stray string must not break the ring math or Buffer.concat on replay.
  const store = createRetainedTerminal();
  store.appendOutput('plain string');
  store.appendOutput(Buffer.from(' + buffer'));
  assert.equal(store.snapshotOutput().toString(), 'plain string + buffer');
});

test('clearOutput empties the replay buffer (fresh spawn / restart)', () => {
  const store = createRetainedTerminal();
  store.appendOutput(Buffer.from('stale conversation'));
  store.clearOutput();
  assert.equal(store.snapshotOutput(), null);
});

test('no reconnect within the grace window reaps and cleans up the pty', () => {
  const timers = fakeTimers();
  let reaped = null;
  const store = createRetainedTerminal({
    graceMs: 1000,
    onReap: t => { reaped = t; },
    setTimer: timers.set,
    clearTimer: timers.clear
  });
  const term = fakeTerm(4321);
  store.term = term;
  store.appendOutput(Buffer.from('an in-progress conversation'));

  const client = {};
  store.attach(client);
  store.detach(client);
  assert.equal(store.term, term, 'pty is retained through the grace window');

  timers.fireAll(); // grace elapses with no reconnect

  assert.equal(reaped, term, 'the unattached pty is handed to onReap for cleanup');
  assert.equal(store.term, null, 'the reaped pty is cleared');
  assert.equal(store.snapshotOutput(), null, 'the replay buffer is cleared on reap');
});

test('a pty that exits during the grace window is not reaped again', () => {
  const timers = fakeTimers();
  let reaped = null;
  const store = createRetainedTerminal({
    graceMs: 1000,
    onReap: t => { reaped = t; },
    setTimer: timers.set,
    clearTimer: timers.clear
  });
  store.term = fakeTerm();
  const client = {};
  store.attach(client);
  store.detach(client);

  store.term = null; // the pty exited on its own; server.js clears it in onExit
  timers.fireAll();

  assert.equal(reaped, null, 'onReap is never called for an already-gone pty');
});

test('exactly one client at a time; attach returns the client to close', () => {
  const timers = fakeTimers();
  const store = createRetainedTerminal({ setTimer: timers.set, clearTimer: timers.clear });
  store.term = fakeTerm();

  const first = {};
  const second = {};
  assert.equal(store.attach(first), null);
  assert.equal(store.attach(second), first, 'the previous client is returned so the caller can close it');
  assert.equal(store.client, second);

  // A late close from the replaced client must not detach the live one.
  store.detach(first);
  assert.equal(store.client, second, 'a stale detach is a no-op');
  assert.equal(timers.size(), 0, 'a stale detach arms no reap');
});

test('busy/idle activity tracking reports transitions to the current client', () => {
  const timers = fakeTimers();
  const store = createRetainedTerminal({ idleMs: 1000, setTimer: timers.set, clearTimer: timers.clear });
  const states = [];
  const onStatus = s => states.push(s);

  store.noteActivity(onStatus);
  assert.equal(store.busy, true);
  store.noteActivity(onStatus); // still busy -> no repeated 'busy'
  assert.deepEqual(states, ['busy']);

  timers.fireAll(); // idle debounce elapses
  assert.equal(store.busy, false);
  assert.deepEqual(states, ['busy', 'idle']);

  store.stopActivity();
  assert.equal(store.busy, false);
});
