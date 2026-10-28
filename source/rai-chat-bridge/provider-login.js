import { resolveBinary } from './mcp.js';

const LOGIN_COMMANDS = Object.freeze({
  // Codex opens its OAuth browser flow when `login` has no API-key option.
  codex: ['login'],
  // Claude Code's documented CLI authentication command.
  claude: ['auth', 'login'],
  // OpenCode's documented credential command (interactive provider/method
  // picker backed by https://opencode.ai/docs/cli/#auth).
  opencode: ['auth', 'login'],
  // Browser OAuth from the embedded PTY cannot finish the loopback callback.
  // Device-code prints the URL and code in the same terminal a normal shell uses.
  grok: ['login', '--device-auth']
});

export function providerLoginArgs(provider) {
  const args = LOGIN_COMMANDS[provider];
  return args ? [...args] : null;
}

// Starts only the provider's interactive OAuth CLI flow. The bridge token is
// never required for sign-in and must not reach a provider process.
export function createProviderLoginSession({
  provider,
  profile,
  cwd,
  env = process.env,
  spawn,
  resolve = resolveBinary
}) {
  const args = providerLoginArgs(provider);
  if (!args) throw new Error(`${provider} does not support browser-terminal sign-in`);
  if (!profile || typeof profile.command !== 'string' || profile.command.length === 0) {
    throw new Error('provider command is required for browser-terminal sign-in');
  }
  if (typeof spawn !== 'function') throw new Error('PTY spawn function is required for browser-terminal sign-in');

  const childEnv = { ...env, TERM: 'xterm-256color' };
  delete childEnv.RAI_BRIDGE_TOKEN;
  delete childEnv.RAI_OWNER_TOKEN;

  return spawn(resolve(profile.command), args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd,
    env: childEnv, encoding: null
  });
}
