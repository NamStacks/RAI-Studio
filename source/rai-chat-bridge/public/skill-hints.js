// Skill syntax belongs to the provider, not RAI; insertion never installs
// or executes a skill. Only exact beginning-of-message commands are probed.
export function skillHint(provider, prompt) {
  const slash = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(prompt);
  const dollar = /^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(prompt);
  if (provider === 'claude') {
    if (dollar) return { name: dollar[1], supported: false, message: '$skill is Codex syntax; inserted unchanged.' };
    return slash ? { name: slash[1], supported: true, message: 'Claude slash skill; verify provider loading after sending.' }
      : { name: null, supported: null, message: 'Claude Code: start a snippet with /skill-name.' };
  }
  if (provider === 'codex') {
    if (slash) return { name: slash[1], supported: false, message: slash[1] === 'rai-audit'
      ? 'Codex rejects a typed /rai-audit. Write "Run the RAI audit" instead.'
      : '/skill is Claude syntax; inserted unchanged.' };
    return dollar ? { name: dollar[1], supported: true, message: 'Codex $skill mention. Press Tab to select it, then Enter to send.' }
      : { name: null, supported: null, message: 'Codex: start a snippet with $skill-name, or write "Run the RAI audit".' };
  }
  const name = slash?.[1] || dollar?.[1] || null;
  // RAI-Studio registers /rai-audit for the session in Grok Build and OpenCode; any other name stays the provider's own business.
  const sessionAudit = slash?.[1] === 'rai-audit';
  if (provider === 'grok') return sessionAudit ? { name, supported: true, message: 'Grok Build: /rai-audit is a skill of this RAI session; verify it loaded after sending.' }
    : { name, supported: false, message: 'Grok Build: snippets are inserted as plain text.' };
  if (provider === 'opencode') return sessionAudit ? { name, supported: true, message: 'OpenCode: /rai-audit is a command of this RAI session; verify it ran after sending.' }
    : { name, supported: false, message: 'OpenCode: ask its native skill tool by name.' };
  return { name, supported: false, message: 'Ask the provider CLI for a skill by name.' };
}
