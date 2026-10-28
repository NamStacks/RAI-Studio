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
    if (slash) return { name: slash[1], supported: false, message: '/skill is Claude syntax; inserted unchanged.' };
    return dollar ? { name: dollar[1], supported: true, message: 'Codex $skill mention. Press Tab to select it, then Enter to send.' }
      : { name: null, supported: null, message: 'Codex: start a snippet with $skill-name.' };
  }
  const name = slash?.[1] || dollar?.[1] || null;
  if (provider === 'grok') return { name, supported: false, message: 'Grok Build: snippets are inserted as plain text.' };
  if (provider === 'opencode') return { name, supported: false, message: 'OpenCode: ask its native skill tool by name.' };
  return { name, supported: false, message: 'Ask the provider CLI for a skill by name.' };
}
