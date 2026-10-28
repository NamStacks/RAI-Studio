import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This is a visibility hint, not proof that the model actually loaded a
// skill. No project/home files are read or changed, only exact known paths
// for one bounded name are tested. Actual invocation requires provider E2E.
export function skillSourceStatus(provider, name, { home = os.homedir(), cwd = process.cwd(), bridgeDir } = {}) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name))
    throw new TypeError('Invalid skill name');
  if (!['claude', 'codex', 'opencode', 'grok'].includes(provider))
    throw new TypeError('Unsupported skill provider');
  const relative = provider === 'claude'
    ? [`.claude/skills/${name}/SKILL.md`, `.claude/commands/${name}.md`]
    : provider === 'codex'
      ? [`.agents/skills/${name}/SKILL.md`, `.codex/skills/${name}/SKILL.md`]
      : provider === 'grok'
        ? [`.grok/skills/${name}/SKILL.md`, `.agents/skills/${name}/SKILL.md`, `.cursor/skills/${name}/SKILL.md`, `.claude/skills/${name}/SKILL.md`]
        : [`.opencode/skills/${name}/SKILL.md`, `.agents/skills/${name}/SKILL.md`, `.claude/skills/${name}/SKILL.md`];
  const candidates = [
    ...relative.map(file => [path.join(cwd, file), 'project']),
    ...relative.map(file => [path.join(home, file), 'user'])
  ];
  if (provider === 'opencode')
    candidates.push([path.join(home, '.config/opencode/skills', name, 'SKILL.md'), 'user']);
  // The bridge registers its bundled skill for the launched session in Claude Code, Grok Build and OpenCode.
  if (provider !== 'codex' && bridgeDir)
    candidates.push([path.join(bridgeDir, 'skills', name, 'SKILL.md'), 'bundled']);
  const found = candidates.find(([file]) => existsSync(file));
  return { provider, name, source: found?.[1] || null,
    availability: found ? 'source_found_invocation_unverified' : 'not_found_in_known_paths',
    message: found
      ? 'Skill source found; provider loading and execution are unverified. Invoke it and verify provider loading and output. RAI does not install skills.'
      : 'No skill source found in RAI’s checked locations; the provider may use a different working directory or plugin. Verify in the provider before sending. RAI does not install skills.' };
}
