import { NATIVE_CLIS, resolveProviderStatusDisplay, summarizeNativeCli } from './provider-status-display.js';
import { DEFAULT_SNIPPETS, normalizeSnippets, validateSnippets, SNIPPET_PROMPT_LIMIT, snippetPromptLength, snippetHasLineBreak, reviewDraft, terminalDraftInput } from './scoped-guidance.js';
import { validateGlobalPrompt } from './global-prompt.js';
import { skillHint } from './skill-hints.js';
import { PendingDraftHistory } from './pending-draft.js';

// Browser terminal: xterm.js <-> /pty WebSocket <-> real interactive claude.
// Protocol: server sends pty bytes as binary frames, control as JSON text.
// We send {type:"input",data} keystrokes and {type:"resize",cols,rows}.

const statusEl = document.getElementById('term-status');
const wsSessionToken = typeof window.__RAI_WS_SESSION_TOKEN__ === 'string' ? window.__RAI_WS_SESSION_TOKEN__ : '';
const inspectorEl = document.getElementById('run-inspector');
const inspectorSummaryEl = document.getElementById('run-inspector-summary');
const inspectorSafetyEl = document.getElementById('run-inspector-safety');

const FONT_SIZE_KEY = 'rai-terminal-font-size';
const THEME_KEY = 'rai-terminal-theme';
const savedFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10) || 10;
const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
const savedThemeMode = ['dark', 'light', 'system'].includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : 'dark';
const savedTheme = savedThemeMode === 'system' ? (systemAppearance.matches ? 'dark' : 'light') : savedThemeMode;
const terminalThemes = {
  dark: {
    background: '#1c1c1e', foreground: '#e5e5e7', cursor: '#e5e5e7', cursorAccent: '#1c1c1e',
    selectionBackground: 'rgba(120,150,255,0.35)', black: '#1c1c1e', brightBlack: '#5c5c60',
    red: '#ff6b68', brightRed: '#ff8a87', green: '#5ad67d', brightGreen: '#7ff099',
    yellow: '#f5d76e', brightYellow: '#ffe58a', blue: '#6aa8ff', brightBlue: '#8fc0ff',
    magenta: '#d58cff', brightMagenta: '#e3adff', cyan: '#6fe0e0', brightCyan: '#9af0f0',
    white: '#e5e5e7', brightWhite: '#ffffff'
  },
  light: {
    background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(47,111,237,0.22)', black: '#1d1d1f', brightBlack: '#6e6e73',
    red: '#b3261e', brightRed: '#d93025', green: '#167c3a', brightGreen: '#278c4d',
    yellow: '#8a5a00', brightYellow: '#a86f00', blue: '#1558c0', brightBlue: '#2f6fed',
    magenta: '#8e3ab4', brightMagenta: '#a64ac9', cyan: '#007c91', brightCyan: '#0097b2',
    white: '#f5f5f7', brightWhite: '#ffffff'
  }
};
document.documentElement.dataset.theme = savedTheme;

const term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
  fontSize: savedFontSize,
  lineHeight: 1.2,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 10000,
  // Lifts only the foreground and background pairs a CLI prints unreadably (black on black, white on white).
  minimumContrastRatio: 4.5,
  theme: terminalThemes[savedTheme]
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();

// Accept embedded iTerm2 image data only, with explicit byte/pixel/storage
// limits. No URL fetch or file download path; SIXEL and size reports off.
window.__raiImageAddonReady = false;
try {
  const image = new ImageAddon.ImageAddon({
    enableSizeReports: false,
    sixelSupport: false,
    iipSupport: true,
    iipSizeLimit: 4 * 1024 * 1024,
    pixelLimit: 4 * 1024 * 1024,
    storageLimit: 24,
    showPlaceholder: false
  });
  term.loadAddon(image);
  window.__raiImageAddon = image;
  window.__raiImageAddonReady = true;
} catch (error) {
  console.warn('[terminal] inline image rendering unavailable', error);
}


// Test hook: module scope hides term from external evaluate().
window.__raiTerm = term;

// WebGL renderer for heavy output, default renderer if unavailable.
try {
  const webgl = new WebglAddon.WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  term.loadAddon(webgl);
} catch (e) {
  console.warn('[terminal] WebGL renderer unavailable, using default renderer', e);
}

let ws;
let reconnectTimer = null;
let terminalState = 'unknown';
let composerDead = false;
let replaying = false;
const shortcutsEl = document.getElementById('scoped-shortcuts');
const scopedStatus = document.getElementById('scoped-guidance-status');
const pendingPanel = document.getElementById('pending-draft');
const pendingText = document.getElementById('pending-draft-text');
const pendingUndo = document.getElementById('pending-undo');
const pendingHistory = new PendingDraftHistory();
let transferringPending = false;
const restartPendingBtn = document.getElementById('restart-pending');
let restartConfirmPending = false;
restartPendingBtn.hidden = sessionStorage.getItem('rai-restart-pending') !== 'true';
let snippets = structuredClone(DEFAULT_SNIPPETS);
let currentProvider = 'claude';
function applySnippets(value, { canonical = false } = {}) {
  snippets = canonical ? validateSnippets(value, { stored: true }) : normalizeSnippets(value);
  shortcutsEl.replaceChildren();
  for (const [id, item] of Object.entries(snippets)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.name;
    button.title = item.name;
    button.setAttribute('aria-label', `Insert ${item.name} into the provider composer; not sent`);
    button.addEventListener('click', () => {
      let draft;
      try { draft = reviewDraft(id, snippets[id].prompt); }
      catch { showStatus('Snippet prompt is invalid. Reset it in Settings.'); return; }
      const composerReady = (terminalState === 'idle' || terminalState === 'drafting') && ws?.readyState === WebSocket.OPEN;
      if (composerReady) {
        let input;
        try { input = terminalDraftInput(draft, { bracketedPasteMode: term.modes?.bracketedPasteMode === true }); }
        catch (error) { showStatus(draftErrorText(error)); return; }
        ws.send(JSON.stringify({ type: 'input', data: input }));
        terminalState = 'drafting';
        scopedStatus.textContent = 'Inserted into provider draft. Not sent; review before Enter.';
        term.focus();
        updateScopedButtons();
        return;
      }
      pendingText.value = pendingHistory.stage(pendingText.value, draft);
      pendingPanel.hidden = false;
      scopedStatus.textContent = `${item.name} queued. It inserts automatically when the assistant is ready. Not sent.`;
      updateScopedButtons();
    });
    shortcutsEl.append(button);
  }
  updateScopedButtons();
}
applySnippets(snippets);
async function fetchSettings() {
  const response = await fetch('/api/settings', { headers: { 'X-RAI-Session-Token': wsSessionToken } });
  if (!response.ok) throw Object.assign(new Error('could not load settings'), { status: response.status });
  return response.json();
}
// Restore canonical saved appearance as well as snippets on a fresh origin.
// A later Settings transaction owns its preview; ignore a stale startup read.
fetchSettings().then(cfg => {
  if (settingsReadGeneration !== 0 || settingsLoading || settingsSaving || !panel.hidden) return;
  currentProvider = cfg.provider;
  applySnippets(cfg.snippets, { canonical: true });
  draftThemeMode = cfg.theme || 'dark';
  applyFontSize(cfg.fontSize || 10, { persist: false });
  applyTheme(draftThemeMode, { persist: false });
}).catch(() => {});
function updateScopedButtons() {
  // Staging always works, including startup, active turns and disconnects.
  // Transfer requires an explicit click at a known idle/drafting prompt.
  const ready = (terminalState === 'idle' || terminalState === 'drafting') && ws?.readyState === WebSocket.OPEN;
  window.__raiComposerReady = ready;
  pendingUndo.disabled = !pendingHistory.canUndo || transferringPending;
  restartPendingBtn.disabled = !['idle', 'drafting'].includes(terminalState) || ws?.readyState !== WebSocket.OPEN;
  // A queued draft moves into the provider composer as soon as it is ready,
  // unless the user is still editing it. Nothing is ever submitted.
  if (ready && pendingText.value && !transferringPending && document.activeElement !== pendingText) {
    queueMicrotask(transferPending);
  }
}
restartPendingBtn.addEventListener('click', () => {
  if (restartPendingBtn.disabled || restartPendingBtn.hidden) return;
  if (!restartConfirmPending) {
    restartConfirmPending = true;
    restartPendingBtn.textContent = 'Confirm restart';
    showStatus('Restart replaces only this Assistant session. Current conversation/composer draft may be lost; staged pending draft remains. Click Confirm restart to proceed.');
    return;
  }
  restartConfirmPending = false;
  restartPendingBtn.hidden = true;
  sessionStorage.removeItem('rai-restart-pending');
  restartPendingBtn.textContent = 'Restart Assistant';
  ws.send(JSON.stringify({ type: 'restart' }));
});
pendingText.addEventListener('input', () => { pendingHistory.observe(pendingText.value); updateScopedButtons(); });
pendingUndo.addEventListener('click', () => {
  const result = pendingHistory.undo(pendingText.value);
  if (!result.undone) { scopedStatus.textContent = result.reason; return; }
  pendingText.value = result.value;
  pendingPanel.hidden = !pendingText.value;
  scopedStatus.textContent = 'Last staging undone. Other draft edits preserved; nothing sent.';
  if (!pendingPanel.hidden) pendingText.focus();
  updateScopedButtons();
});
function draftErrorText(error) {
  if (/bracketed paste/i.test(error?.message || '')) return 'The assistant is not accepting multi-line paste yet. Use a single line, or try again when it is ready.';
  return 'Pending draft contains unsafe terminal control text.';
}
function transferPending() {
  if (transferringPending || !pendingText.value ||
      !['idle', 'drafting'].includes(terminalState) || ws?.readyState !== WebSocket.OPEN) return;
  const draft = pendingText.value;
  let input;
  try { input = terminalDraftInput(draft, { bracketedPasteMode: term.modes?.bracketedPasteMode === true }); }
  catch (error) { showStatus(draftErrorText(error)); return; }
  transferringPending = true;
  updateScopedButtons();
  try {
    ws.send(JSON.stringify({ type: 'input', data: input }));
    pendingHistory.clear();
    pendingText.value = '';
    pendingPanel.hidden = true;
    terminalState = 'drafting';
    scopedStatus.textContent = 'Inserted into provider draft. Not sent; review before Enter. Undo in the native composer if supported.';
    if (panel.hidden) term.focus();
  } catch { showStatus('Transfer failed; pending draft retained.'); }
  finally { transferringPending = false; updateScopedButtons(); }
}
pendingText.addEventListener('blur', () => updateScopedButtons());
document.getElementById('pending-clear').addEventListener('click', () => {
  pendingHistory.clear();
  pendingText.value = '';
  pendingPanel.hidden = true;
  updateScopedButtons();
});

// Exposed only as local iframe state so e2e can wait on the real WebSocket handshake, as input sent before it opens is dropped.
window.__raiTerminalConnectionState = 'idle';

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}
function hideStatus() { statusEl.hidden = true; }

function renderRunInspector(snapshot) {
  if (!snapshot || snapshot.state === 'idle') {
    inspectorEl.hidden = true;
    fit.fit();
    return;
  }
  const seconds = (value) => `${Math.floor((value || 0) / 1000)}s`;
  inspectorEl.dataset.state = snapshot.state;
  inspectorSummaryEl.textContent =
    `${snapshot.state} · elapsed ${seconds(snapshot.elapsed_ms)} · quiet ${seconds(snapshot.quiet_ms)} · ` +
    `output ${snapshot.output_bytes} B (+${snapshot.output_growth_bytes} B) · deadline ${seconds(snapshot.deadline_ms)}`;
  inspectorSafetyEl.textContent = snapshot.safety_copy || '';
  inspectorSafetyEl.hidden = !snapshot.safety_copy;
  inspectorEl.hidden = false;
  fit.fit();
}

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

// Status frames are ignored while composerDead is set because the bridge can send an idle frame after the provider ends.
function composerGone(dead = true) {
  composerDead = dead;
  terminalState = 'unknown';
  updateScopedButtons();
  window.parent.postMessage({ type: 'assistant-status', state: '' }, '*');
}

function connect() {
  hideStatus();
  if (!wsSessionToken) {
    showStatus('Terminal session credential is unavailable. Reload the Assistant pane.');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const endpoint = new URL(`${proto}://${location.host}/pty`);
  endpoint.searchParams.set('token', wsSessionToken);
  window.__raiTerminalConnectionState = 'connecting';
  ws = new WebSocket(endpoint);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    window.__raiTerminalConnectionState = 'connected';
    terminalState = 'unknown';
    composerDead = false;
    replaying = false;
    updateScopedButtons();
    hideStatus();
    fit.fit();
    sendResize();
    if (panel.hidden) term.focus();
  };

  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      // JSON control frame
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'run_inspector') {
        renderRunInspector(msg.snapshot);
      } else if (msg.type === 'exit') {
        composerGone();
        showStatus(`${NATIVE_CLIS[currentProvider] || 'The assistant'} exited (code ${msg.exitCode ?? '?'}${msg.signal ? `, signal ${msg.signal}` : ''}). Press any key to start a fresh session.`);
      } else if (msg.type === 'replay_start') {
        // The bridge retained this conversation's pty across a reconnect (e.g.
        // "Restart R") and is about to replay its recent output. Reset first so
        // the replay reconstructs the terminal once rather than doubling any
        // content this page may still be showing from before the socket drop.
        replaying = true;
        term.reset();
        hideStatus();
      } else if (msg.type === 'restarted') {
        // A new provider owns this PTY. clear() retains the old current line,
        // cursor and DEC modes, corrupting the next provider's first redraw.
        term.reset();
        hideStatus();
        composerGone(false);
      } else if (msg.type === 'profile_error') {
        composerGone();
        showStatus(`terminal profile invalid: ${msg.error || 'check provider settings'}`);
      } else if (msg.type === 'bridge_config_error') {
        showStatus(`RAI bridge configuration error: ${msg.error || 'set RAI_BRIDGE_TOKEN and restart the bridge'}`);
      } else if (msg.type === 'already_signed_in') {
        composerDead = false;
        showStatus('Grok is already signed in. Opening the terminal.');
      } else if (msg.type === 'signin_started') {
        composerGone();
        term.reset();
        showStatus('Sign in through the provider flow in this terminal.');
      } else if (msg.type === 'signin_complete') {
        composerGone(false);
        showStatus('Sign-in ended. Restarting the assistant…');
        refreshProviderStatus();
      } else if (msg.type === 'signin_unavailable') {
        showStatus('Provider sign-in is unavailable. Install the provider CLI and select it in Settings.');
      } else if (msg.type === 'launch_failed') {
        composerGone();
        showStatus(`${msg.command || msg.provider || 'Provider command'} not found on PATH. Install it or pick another provider in Settings.`);
      } else if (msg.type === 'active_model') {
        const provider = providersConfig[msg.provider];
        if (provider && typeof msg.model === 'string') {
          provider.activeModel = msg.model;
          provider.reportedModels = [msg.model];
        }
      } else if (msg.type === 'status') {
        if (composerDead) return;
        terminalState = msg.state;
        updateScopedButtons();
        // Relay the bridge's busy/idle heuristic to the parent GWT window
        // so the assistant toolbar button can reflect it without the pane
        // needing to be open. Same object-shaped postMessage convention as
        // 'assistant-error'/'assistant-connected' etc.
        window.parent.postMessage({ type: 'assistant-status', state: msg.state }, '*');
      }
      return;
    }
    // binary: raw pty bytes
    if (replaying) term.write(new Uint8Array(ev.data), () => { replaying = false; });
    else term.write(new Uint8Array(ev.data));
  };

  ws.onclose = () => {
    window.__raiTerminalConnectionState = 'disconnected';
    terminalState = 'unknown';
    replaying = false;
    updateScopedButtons();
    showStatus('Disconnected. Reconnecting…');
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1000);
    }
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

// keystrokes -> pty
term.onData(data => {
  if (replaying) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }));
  }
});

// ---- settings panel: pick provider/model/font size, restart the pty ----
const gearBtn = document.getElementById('settings-gear');
gearBtn.hidden = window.parent !== window;
let settingsRevision = null;
let settingsLoading = false;
let settingsSaving = false;
let settingsReadGeneration = 0;
let settingsOpenPromise = null;
const caffeinateInput = document.getElementById('settings-caffeinate');
const panel = document.getElementById('settings-panel');
const providerSel = document.getElementById('settings-provider');
const fontSizeSel = document.getElementById('settings-fontsize');
const themeButtons = document.querySelectorAll('.settings-theme-toggle button[data-theme]');
const fontGroup = document.querySelector('.settings-fontsize-toggle');
const providerStatusEl = document.getElementById('settings-provider-status');
const signInProviderBtn = document.getElementById('settings-sign-in-provider');
const testProviderBtn = document.getElementById('settings-test-provider');
const settingsError = document.getElementById('settings-error');
const settingsSave = document.getElementById('settings-save');
const settingsTabs = {
  general: document.getElementById('settings-tab-general'),
  global: document.getElementById('settings-tab-global'),
  snippets: document.getElementById('settings-tab-snippets')
};
const settingsPanes = {
  general: document.getElementById('settings-general'),
  global: document.getElementById('settings-global'),
  snippets: document.getElementById('settings-snippets')
};
const globalPromptInput = document.getElementById('settings-global-prompt');
const resetSnippetsBtn = document.getElementById('settings-reset-snippets');
const snippetList = document.getElementById('snippet-list');
const snippetEditor = document.getElementById('snippet-editor');
const snippetNameInput = document.getElementById('snippet-edit-name');
const snippetPromptInput = document.getElementById('snippet-edit-prompt');
const snippetCount = document.getElementById('snippet-count');
const snippetPromptCount = document.getElementById('snippet-prompt-count');
const addSnippetBtn = document.getElementById('settings-add-snippet');
let savedGlobalPrompt = '';
let savedSettings = null;
let savedAppearance = null;
let draftThemeMode = savedThemeMode;
let draftSnippets = structuredClone(DEFAULT_SNIPPETS);
let selectedSnippetId = 'writing';
let resetConfirmationPending = false;
let deleteConfirmationPending = false;

function showSettingsTab(tab) {
  for (const kind of ['general', 'global', 'snippets']) {
    settingsTabs[kind].setAttribute('aria-selected', String(kind === tab));
    settingsTabs[kind].tabIndex = kind === tab ? 0 : -1;
    settingsPanes[kind].hidden = kind !== tab;
  }
  resetConfirmationPending = false;
  resetSnippetsBtn.textContent = 'Reset defaults';
  settingsError.hidden = true;
  if (tab === 'snippets') void refreshSnippetSkillStatus();
}
function legacySnippet(id) {
  const item = draftSnippets[id];
  return item && savedSettings?.snippets && Object.hasOwn(savedSettings.snippets, id) &&
    savedSettings.snippets[id].prompt === item.prompt &&
    (snippetPromptLength(item.prompt) > SNIPPET_PROMPT_LIMIT || snippetHasLineBreak(item.prompt));
}
function updateSnippetPromptFeedback() {
  const item = draftSnippets[selectedSnippetId];
  if (!item) { snippetPromptCount.textContent = ''; return; }
  const used = snippetPromptLength(item.prompt);
  const legacy = legacySnippet(selectedSnippetId);
  const invalid = !legacy && (used > SNIPPET_PROMPT_LIMIT || snippetHasLineBreak(item.prompt));
  snippetPromptInput.setAttribute('aria-invalid', String(invalid));
  snippetPromptCount.textContent = `${used}/${SNIPPET_PROMPT_LIMIT}` +
    (legacy ? ' · Legacy saved prompt kept. Shorten it to edit.' :
      invalid ? ' · Use one line, up to 300 characters. Draft kept.' : '');
  const selected = snippetList.querySelector('[aria-selected="true"]');
  if (selected) selected.textContent = (item.name || 'Untitled snippet') + (legacy ? ' · Legacy' : '');
}
function renderSnippetEditor() {
  const restoreListFocus = snippetList.contains(document.activeElement);
  const ids = Object.keys(draftSnippets);
  if (!draftSnippets[selectedSnippetId]) selectedSnippetId = ids[0] || null;
  const shown = document.createElement('span');
  shown.setAttribute('aria-hidden', 'true');
  shown.textContent = `${ids.length}/5`;
  const spoken = document.createElement('span');
  spoken.className = 'sr-only';
  spoken.textContent = `${ids.length} of 5 snippets`;
  snippetCount.replaceChildren(shown, spoken);
  addSnippetBtn.disabled = ids.length >= 5;
  addSnippetBtn.title = ids.length >= 5 ? 'Five snippets maximum' : 'Add snippet';
  snippetList.replaceChildren();
  for (const id of ids) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = (draftSnippets[id].name || 'Untitled snippet') + (legacySnippet(id) ? ' · Legacy' : '');
    button.title = button.textContent;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(id === selectedSnippetId));
    button.tabIndex = id === selectedSnippetId ? 0 : -1;
    button.addEventListener('click', () => { selectedSnippetId = id; renderSnippetEditor(); });
    button.addEventListener('keydown', event => {
      const index = ids.indexOf(id);
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, ids.length - 1) :
        event.key === 'ArrowUp' ? Math.max(index - 1, 0) :
        event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      selectedSnippetId = ids[next];
      renderSnippetEditor();
      snippetList.querySelector('[aria-selected="true"]')?.focus();
    });
    snippetList.append(button);
  }
  if (restoreListFocus) snippetList.querySelector('[aria-selected="true"]')?.focus();
  snippetEditor.hidden = !selectedSnippetId;
  if (selectedSnippetId) {
    snippetNameInput.value = draftSnippets[selectedSnippetId].name;
    snippetPromptInput.value = draftSnippets[selectedSnippetId].prompt;
  }
  const index = ids.indexOf(selectedSnippetId);
  document.getElementById('snippet-move-up').disabled = index <= 0;
  document.getElementById('snippet-move-down').disabled = index < 0 || index === ids.length - 1;
  deleteConfirmationPending = false;
  document.getElementById('snippet-delete').textContent = '−';
  document.getElementById('snippet-delete').disabled = !selectedSnippetId;
  document.getElementById('snippet-delete').setAttribute('aria-label', 'Delete selected snippet');
  updateSnippetPromptFeedback();
}
function fillSnippetInputs(value) {
  draftSnippets = structuredClone(normalizeSnippets(value));
  selectedSnippetId = Object.keys(draftSnippets)[0] || null;
  renderSnippetEditor();
}
function snippetInputValue() { return draftSnippets; }
for (const [field, input] of [['name', snippetNameInput], ['prompt', snippetPromptInput]])
  input.addEventListener('input', () => {
    if (!selectedSnippetId) return;
    draftSnippets[selectedSnippetId][field] = input.value;
    if (field === 'name') {
      const selected = snippetList.querySelector('[aria-selected="true"]');
      if (selected) selected.textContent = input.value || 'Untitled snippet';
    }
    updateSnippetPromptFeedback();
    void refreshSnippetSkillStatus();
  });
addSnippetBtn.addEventListener('click', () => {
  if (Object.keys(draftSnippets).length >= 5) return;
  const id = `s-${crypto.randomUUID()}`;
  draftSnippets[id] = { name: '', prompt: '' };
  selectedSnippetId = id;
  renderSnippetEditor();
  snippetNameInput.focus();
});
for (const [id, delta] of [['snippet-move-up', -1], ['snippet-move-down', 1]])
  document.getElementById(id).addEventListener('click', () => {
    const ids = Object.keys(draftSnippets);
    const from = ids.indexOf(selectedSnippetId), to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    draftSnippets = Object.fromEntries(ids.map(key => [key, draftSnippets[key]]));
    renderSnippetEditor();
    document.getElementById(id).focus();
  });
document.getElementById('snippet-delete').addEventListener('click', event => {
  if (!selectedSnippetId) return;
  if (!deleteConfirmationPending) {
    deleteConfirmationPending = true;
    event.currentTarget.textContent = 'Confirm delete';
    event.currentTarget.setAttribute('aria-label', 'Confirm delete selected snippet');
    return;
  }
  delete draftSnippets[selectedSnippetId];
  renderSnippetEditor();
});
let skillStatusRequest = 0;
async function refreshSnippetSkillStatus() {
  const request = ++skillStatusRequest;
  const output = document.getElementById('settings-skill-status');
  const messages = [];
  for (const [kind, item] of Object.entries(draftSnippets)) {
    const hint = skillHint(currentProvider, item.prompt);
    if (!hint.name) continue;
    let detail = hint.message;
    if (hint.supported) {
      try {
        const res = await fetch(`/api/skill-status?name=${encodeURIComponent(hint.name)}`, {
          headers: { 'X-RAI-Session-Token': wsSessionToken }
        });
        const status = await res.json();
        detail = res.ok ? status.message : 'Skill check failed; nothing was installed.';
      } catch { detail = 'Skill check failed; nothing was installed.'; }
    }
    messages.push(`${item.name || kind}: ${detail}`);
  }
  if (request === skillStatusRequest)
    output.textContent = messages.join(' ') || skillHint(currentProvider, '').message;
}

function showSettingsError(message) {
  settingsError.textContent = message;
  settingsError.hidden = false;
}

let providersConfig = {};

function renderProviderStatusUnknown() {
  providerStatusEl.dataset.state = 'unknown';
  providerStatusEl.textContent = 'Could not check sign-in.';
  signInProviderBtn.textContent = 'Sign in';
  signInProviderBtn.disabled = false;
}

function renderProviderStatus(status, providerKey) {
  const display = resolveProviderStatusDisplay(status, providerKey);
  providerStatusEl.dataset.state = display.authState;
  providerStatusEl.innerHTML = '';
  providerStatusEl.appendChild(document.createTextNode(display.text));
  if (display.link) {
    const link = document.createElement('a');
    link.href = display.link.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = display.link.text;
    providerStatusEl.appendChild(link);
  }
  signInProviderBtn.textContent = display.authState === 'authenticated' ? 'Sign in again' : 'Sign in';
  signInProviderBtn.disabled = display.disabled;
}

const providerListEl = document.getElementById('settings-provider-list');
function renderNativeCliList(statuses) {
  const focusedProvider = providerListEl.contains(document.activeElement) ? document.activeElement.dataset.provider : null;
  providerListEl.replaceChildren();
  for (const key of Object.keys(providersConfig)) {
    const summary = summarizeNativeCli(statuses == null ? statuses : (statuses[key] ?? null));
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'native-cli';
    row.dataset.state = summary.authState;
    row.dataset.provider = key;
    row.setAttribute('aria-pressed', String(key === providerSel.value));
    const dot = document.createElement('span');
    dot.className = 'native-cli-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'native-cli-name';
    name.textContent = NATIVE_CLIS[key] || key;
    const state = document.createElement('span');
    state.className = 'native-cli-state';
    state.textContent = summary.text;
    row.append(dot, name, state);
    row.addEventListener('click', () => {
      if (providerSel.value === key) return;
      providerSel.value = key;
      for (const chip of providerListEl.children) chip.setAttribute('aria-pressed', String(chip === row));
      providerSel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    providerListEl.append(row);
  }
  if (focusedProvider) [...providerListEl.children].find(chip => chip.dataset.provider === focusedProvider)?.focus();
}

async function refreshProviderStatus() {
  providerStatusEl.dataset.state = 'checking';
  providerStatusEl.textContent = 'Checking sign-in…';
  signInProviderBtn.textContent = 'Sign in';
  signInProviderBtn.disabled = true;
  testProviderBtn.disabled = true;
  try {
    const response = await fetch('/api/provider-status', {
      headers: { 'X-RAI-Session-Token': wsSessionToken }
    });
    const providers = response.ok ? (await response.json())?.providers ?? null : null;
    if (providers) renderProviderStatus(providers[providerSel.value], providerSel.value);
    else renderProviderStatusUnknown();
    renderNativeCliList(providers);
  } catch {
    renderProviderStatusUnknown();
    renderNativeCliList(null);
  } finally {
    testProviderBtn.disabled = false;
  }
}

async function startProviderSignIn() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showStatus('Terminal is disconnected. Wait for it to reconnect before signing in.');
    return;
  }
  signInProviderBtn.disabled = true;
  try { validateGlobalPrompt(globalPromptInput.value); validateSnippets(draftSnippets, { previous: savedSettings?.snippets }); }
  catch (error) { showSettingsError(error.message); signInProviderBtn.disabled = false; return; }
  if (!await persistSettings()) {
    signInProviderBtn.disabled = false;
    showStatus('save failed');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    signInProviderBtn.disabled = false;
    showStatus('Settings saved, but the terminal disconnected. Wait for it to reconnect, then press Sign in again.');
    return;
  }
  applySnippets(draftSnippets);
  applyFontSize(parseInt(fontSizeSel.value, 10));
  applyTheme(draftThemeMode);
  savedAppearance = null;
  closePanelDiscard();
  ws.send(JSON.stringify({ type: 'sign_in' }));
}

function selectSavedFontSize(size) {
  // Preserve an already-saved larger font without adding new default choices.
  fontGroup.querySelector('[data-saved-font-size]')?.remove();
  if ([16, 18].includes(size)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.fontSize = String(size);
    button.dataset.savedFontSize = 'true';
    button.textContent = `${size} (saved)`;
    fontGroup.append(button);
  }
  fontSizeSel.value = String(size);
  markFontSize();
}
function markFontSize() {
  for (const button of fontGroup.querySelectorAll('button')) {
    const selected = button.dataset.fontSize === fontSizeSel.value;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

async function openPanel() {
  if (settingsLoading) return settingsOpenPromise;
  if (!panel.hidden) return; // preserve raw draft on repeated host activation
  const generation = ++settingsReadGeneration;
  settingsLoading = true;
  settingsRevision = null;
  settingsOpenPromise = (async () => {
  try {
    const cfg = await fetchSettings();
    if (generation !== settingsReadGeneration) return;
    settingsRevision = cfg.settings_revision;
    currentProvider = cfg.provider;
    applySnippets(cfg.snippets, { canonical: true });
    savedGlobalPrompt = cfg.globalPrompt || '';
    globalPromptInput.value = savedGlobalPrompt;
    caffeinateInput.checked = cfg.caffeinate !== false;
    savedSettings = { provider: cfg.provider, globalPrompt: savedGlobalPrompt,
      snippets: structuredClone(snippets), autoApproveReadOnly: true,
      caffeinate: caffeinateInput.checked, saveOnEdit: true, theme: cfg.theme || 'dark', fontSize: cfg.fontSize || 10 };
    fillSnippetInputs(snippets);
    showSettingsTab('general');
    if (cfg.settingsRecovery) showSettingsError(cfg.settingsRecovery);
    providersConfig = cfg.providers || {};
    providerSel.value = cfg.provider;
    renderNativeCliList(undefined);
    selectSavedFontSize(cfg.fontSize || 10);
    draftThemeMode = cfg.theme || 'dark';
    savedAppearance = { fontSize: cfg.fontSize || 10, theme: draftThemeMode };
    applyFontSize(savedAppearance.fontSize, { persist: false });
    applyTheme(draftThemeMode, { persist: false });
    panel.hidden = false;
    refreshProviderStatus();
  } catch {
    showStatus('could not load native settings; draft retained');
  } finally { settingsLoading = false; settingsOpenPromise = null; }
  })();
  return settingsOpenPromise;
}

function closePanel() {
  if (settingsLoading || settingsSaving) return;
  const appearanceChanged = savedAppearance &&
    (term.options.fontSize !== savedAppearance.fontSize || draftThemeMode !== savedAppearance.theme);
  if (!panel.hidden && savedSettings && (appearanceChanged || JSON.stringify(settingsBody()) !== JSON.stringify(savedSettings))) {
    document.getElementById('settings-close-confirm').hidden = false;
    document.getElementById('settings-confirm-continue').focus();
    return;
  }
  closePanelDiscard();
}
function closePanelDiscard() {
  if (settingsLoading || settingsSaving) return;
  if (savedAppearance) {
    applyFontSize(savedAppearance.fontSize, { persist: false });
    draftThemeMode = savedAppearance.theme;
    applyTheme(draftThemeMode, { persist: false });
    savedAppearance = null;
  }
  panel.hidden = true;
  document.getElementById('settings-close-confirm').hidden = true;
  savedSettings = null;
  term.focus();
}
document.getElementById('settings-confirm-discard').addEventListener('click', closePanelDiscard);
document.getElementById('settings-confirm-continue').addEventListener('click', () => {
  document.getElementById('settings-close-confirm').hidden = true;
  settingsSave.focus();
});
document.getElementById('settings-confirm-save').addEventListener('click', () => void saveSettings());
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== window.__RAI_PARENT_ORIGIN__ ||
      event.data?.type !== 'rai-open-settings' || typeof event.data.request_id !== 'string') return;
  const wasHidden = panel.hidden;
  void openPanel().then(() => { if (wasHidden) focusSettings(); window.parent.postMessage({type:'rai-settings-opened',
    request_id:event.data.request_id, ok:!panel.hidden && Boolean(settingsRevision)}, event.origin); });
});

function applyFontSize(size, { persist = true } = {}) {
  term.options.fontSize = size;
  if (persist) localStorage.setItem(FONT_SIZE_KEY, String(size));
  fit.fit();
  sendResize();
}

function applyTheme(theme, { persist = true } = {}) {
  const mode = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
  const resolved = mode === 'system' ? (systemAppearance.matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = resolved;
  term.options.theme = terminalThemes[resolved];
  if (persist) localStorage.setItem(THEME_KEY, mode);
  themeButtons.forEach(button => {
    const selected = button.dataset.theme === mode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function settingsBody() {
  return { provider: providerSel.value, globalPrompt: globalPromptInput.value,
    snippets: snippetInputValue(), autoApproveReadOnly: true,
    caffeinate: caffeinateInput.checked, saveOnEdit: true, theme: draftThemeMode, fontSize: Number(fontSizeSel.value) };
}

// Unchanged snippet prompts are sent as name-only so a huge legacy prompt is not resent.
// The baseline is whatever the bridge held when the draft was built, so a retry rebuilds it.
function slimSnippets(snippets, baseline) {
  return Object.fromEntries(Object.entries(snippets).map(([id, item]) => [id,
    baseline && Object.hasOwn(baseline, id) && baseline[id].prompt === item.prompt ? { name: item.name } : { ...item }]));
}

async function persistSettings(outcome = {}) {
  if (!settingsRevision) { showSettingsError('Load native settings before Save; draft retained.'); return false; }
  let body, draftSnippets;
  try {
    body = settingsBody();
    draftSnippets = body.snippets;
    body.snippets = slimSnippets(draftSnippets, savedSettings?.snippets);
  } catch (error) {
    showStatus(error.message);
    return false;
  }
  const notResponding = 'The assistant is not responding. Nothing saved; draft kept. Restart the assistant and try again.';
  const staleToken = 'The assistant restarted and this pane is out of date. Reload the Assistant pane, then save again.';
  // Save always wins: when the settings changed underneath (409), take the newest
  // revision and send the same draft again instead of asking the user to retry.
  let res, data, overwrote = false;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RAI-Session-Token': wsSessionToken },
        body: JSON.stringify({ ...body, expected_revision: settingsRevision })
      });
    } catch {
      showSettingsError(notResponding);
      return false;
    }
    data = await res.json().catch(() => null);
    if (res.status !== 409) break;
    if (attempt >= 2) {
      showSettingsError('Settings keep changing elsewhere. Nothing saved; draft kept. Try Save again.');
      return false;
    }
    try {
      const latest = await fetchSettings();
      settingsRevision = latest?.settings_revision || settingsRevision;
      body = { ...body, snippets: slimSnippets(draftSnippets, latest?.snippets) };
    } catch (error) {
      showSettingsError(error?.status === 401 ? staleToken : error?.status === 503
        ? 'The native settings are unavailable. Nothing saved; draft kept. Try again in a moment.' : notResponding);
      return false;
    }
    overwrote = true;
  }
  if (res.status === 401) {
    showSettingsError(staleToken);
    return false;
  }
  if (!res.ok) {
    showSettingsError(data?.error || 'save failed; draft retained');
    return false;
  }
  const notices = [];
  if (overwrote) notices.push('Settings had changed elsewhere. Your values replaced them.');
  if (data?.fallback) notices.push(data.message || 'Unknown model alias; using the provider account default.');
  outcome.notice = notices.join(' ');
  if (outcome.notice) showStatus(outcome.notice);
  settingsRevision = data?.settings_revision;
  currentProvider = data?.provider || currentProvider;
  return true;
}

async function saveSettings() {
  if (settingsLoading || settingsSaving || !settingsRevision) return;
  try { validateGlobalPrompt(globalPromptInput.value); validateSnippets(snippetInputValue(), { previous: savedSettings?.snippets }); }
  catch (error) { showSettingsError(error.message); return; }
  if (settingsSave.disabled) return;
  settingsSave.disabled = true;
  settingsSaving = true;
  const returnTo = settingsSave.ownerDocument?.activeElement;
  panel.inert = true;
  panel.setAttribute('aria-busy', 'true');
  let persisted = false;
  try {
    const before = savedSettings;
    const outcome = {};
    if (!await persistSettings(outcome)) return;
    persisted = true;
    applySnippets(draftSnippets);
    savedGlobalPrompt = globalPromptInput.value;
    savedSettings = settingsBody();
    applyFontSize(parseInt(fontSizeSel.value, 10));
    applyTheme(draftThemeMode);
    savedAppearance = null;
    const restart = before?.provider !== providerSel.value ||
      before?.globalPrompt !== savedGlobalPrompt;
    settingsSaving = false;
    closePanelDiscard();
    if (restart) {
      restartPendingBtn.hidden = false;
      sessionStorage.setItem('rai-restart-pending', 'true');
      restartConfirmPending = false;
      restartPendingBtn.textContent = 'Restart Assistant';
      updateScopedButtons();
      showStatus(`${outcome.notice ? outcome.notice + ' ' : ''}Settings saved; restart pending. It will not interrupt active work. Use Restart Assistant when idle; current conversation/composer draft may be lost.`);
    } else if (outcome.notice) showStatus(outcome.notice);
  } catch (error) {
    showSettingsError(persisted
      ? `Saved, but the panel could not finish updating (${error.message}). Reopen Settings.`
      : `Could not save settings (${error.message}); changes remain in the editor.`);
  }
  finally {
    settingsSaving = false; panel.inert = false; panel.removeAttribute('aria-busy'); settingsSave.disabled = false;
    // inert drops focus to the body; put it back when the panel stays open after a failed save.
    if (!panel.hidden) (returnTo?.isConnected && !returnTo.disabled ? returnTo : settingsSave).focus?.();
  }
}

resetSnippetsBtn.addEventListener('click', () => {
  if (!resetConfirmationPending) {
    resetConfirmationPending = true;
    resetSnippetsBtn.textContent = 'Confirm reset defaults';
    return;
  }
  fillSnippetInputs(DEFAULT_SNIPPETS); // Save persists; Cancel discards.
  resetConfirmationPending = false;
  resetSnippetsBtn.textContent = 'Reset defaults';
  settingsError.hidden = true;
});
for (const tab of ['general', 'global', 'snippets'])
  settingsTabs[tab].addEventListener('click', () => showSettingsTab(tab));
for (const tab of ['general', 'global', 'snippets'])
  settingsTabs[tab].addEventListener('keydown', event => {
    const ids = ['general', 'global', 'snippets'];
    const index = ids.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % ids.length :
      event.key === 'ArrowLeft' ? (index + ids.length - 1) % ids.length :
      event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    showSettingsTab(ids[next]);
    settingsTabs[ids[next]].focus();
  });

const focusSettings = () => { if (!panel.hidden) settingsTabs.general.focus(); };
gearBtn.addEventListener('click', () => (panel.hidden ? openPanel().then(focusSettings) : closePanel()));
panel.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || panel.hidden || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  const confirm = document.getElementById('settings-close-confirm');
  if (!confirm.hidden) { confirm.hidden = true; settingsSave.focus(); return; }
  closePanel();
});
providerSel.addEventListener('change', () => {
  refreshProviderStatus();
});
fontGroup.addEventListener('click', event => {
  const button = event.target.closest('button[data-font-size]');
  if (!button) return;
  fontSizeSel.value = button.dataset.fontSize;
  markFontSize();
  applyFontSize(Number(fontSizeSel.value), { persist: false });
});
themeButtons.forEach(button => button.addEventListener('click', () => {
  draftThemeMode = button.dataset.theme;
  applyTheme(draftThemeMode, { persist: false });
}));
systemAppearance.addEventListener('change', () => {
  const mode = panel.hidden ? localStorage.getItem(THEME_KEY) : draftThemeMode;
  if (mode === 'system') applyTheme('system', { persist: false });
});
document.getElementById('settings-save').addEventListener('click', saveSettings);
document.getElementById('settings-cancel').addEventListener('click', closePanel);
signInProviderBtn.addEventListener('click', startProviderSignIn);
testProviderBtn.addEventListener('click', refreshProviderStatus);

// keep the terminal fitted to the pane and tell the pty
const refit = () => { fit.fit(); sendResize(); };
window.addEventListener('resize', refit);
if (window.ResizeObserver) {
  new ResizeObserver(refit).observe(document.getElementById('term'));
}

connect();
