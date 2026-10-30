// Pure status-line logic for the provider Sign-in panel, importable in plain Node.

export const INSTALL_GUIDANCE = {
  claude: { label: 'claude', url: 'https://docs.claude.com/en/docs/claude-code/setup' },
  codex: { label: 'codex', url: 'https://github.com/openai/codex#installation' },
  opencode: { label: 'opencode', url: 'https://opencode.ai/docs/' },
  grok: { label: 'grok', hint: 'run curl -fsSL https://x.ai/cli/install.sh | bash' }
};

// Native CLIs this panel lists, in display order.
export const NATIVE_CLIS = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  grok: 'Grok Build'
};

const SHORT_STATE = {
  authenticated: 'Signed in',
  unauthenticated: 'Sign in needed',
  unavailable: 'Not installed',
  unknown: 'Unknown',
  'api-configured': 'API mode',
  checking: 'Checking…'
};

export function summarizeNativeCli(status) {
  if (status === undefined) return { authState: 'checking', text: SHORT_STATE.checking };
  const authState = status?.commandAvailable === false ? 'unavailable' : (status?.authState || 'unknown');
  return { authState, text: SHORT_STATE[authState] || SHORT_STATE.unknown };
}

const PROVIDER_STATUS_LABELS = {
  authenticated: 'Signed in with your subscription.',
  unauthenticated: 'Sign in through the provider CLI',
  unavailable: 'Command not available on PATH.',
  unknown: 'Could not check sign-in.',
  'api-configured': 'API mode; keys stay in the provider CLI.'
};

export function resolveProviderStatusDisplay(status, providerKey, guidance = INSTALL_GUIDANCE) {
  const authState = status?.authState || 'unknown';
  const commandMissing = !status?.commandAvailable;
  const disabled = commandMissing || status?.authMode === 'api';

  if (commandMissing) {
    const guide = guidance[providerKey];
    return {
      authState,
      disabled,
      text: guide
        ? `${guide.label} isn't installed. ${guide.hint ? guide.hint.replace(/^run /, 'Run ') + '. ' : ''}`
        : (PROVIDER_STATUS_LABELS.unavailable + ' '),
      link: guide?.url ? { text: 'Install instructions', url: guide.url } : null
    };
  }

  return {
    authState,
    disabled,
    text: PROVIDER_STATUS_LABELS[authState] || 'Provider status unavailable',
    link: null
  };
}
