// One settings authority. Embedded IDE mode delegates the complete transaction
// to its owning rsession; native failure never falls back to a local writer.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { CONFIG_FILE, readConfigSnapshot, writeConfig } from './config.js';
import { validateSnippets } from './public/scoped-guidance.js';
import { validateGlobalPrompt } from './public/global-prompt.js';
import { validateProfile } from './mcp.js';

function validateSettingsSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid settings');
  if (!Object.hasOwn(value.providers || {}, value.provider)) throw new Error('unknown provider; no fallback applied');
  for (const field of ['caffeinate', 'autoApproveReadOnly', 'saveOnEdit'])
    if (typeof value[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  if (!['dark', 'light', 'system'].includes(value.theme ?? 'dark')) throw new Error('invalid theme');
  if (![10, 12, 14, 16, 18].includes(value.fontSize ?? 10)) throw new Error('invalid font size');
  validateGlobalPrompt(value.globalPrompt);
  validateSnippets(value.snippets, { stored: true });
  const profile = validateProfile(value);
  if (!profile.ok) throw new Error(profile.error);
  return value;
}

function fileRevision() {
  const bytes = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE) : Buffer.alloc(0);
  return createHash('sha256').update(bytes).digest('hex');
}

export function createSettingsAuthority({ nativeCall } = {}) {
  const authority = {
    async read({ persistMigration = true } = {}) {
      if (nativeCall) {
        const result = await nativeCall('settings', { operation: 'read' });
        if (!result?.settings || typeof result.settings !== 'object' || Array.isArray(result.settings) ||
            typeof result.settings_revision !== 'string')
          throw new Error('Native settings acknowledgement missing; no fallback applied.');
        return result;
      }
      // Standalone mode retains its existing migration/recovery contract.
      // Embedded native mode returned above and can never reach this writer.
      const { settings, bytes } = readConfigSnapshot({ persistMigration });
      return { settings, settings_revision: createHash('sha256').update(bytes).digest('hex'), authority: 'standalone' };
    },
    async save(settings, expectedRevision) {
      if (typeof expectedRevision !== 'string' || !expectedRevision) throw new Error('settings revision required');
      // Reread without migration writes; caller-supplied legacy identity is not authority.
      const current = await authority.read({ persistMigration: false });
      if (current.settings_revision !== expectedRevision) throw new Error('Settings changed; reload before saving.');
      // Native reads are raw stored JSON, not a fully backfilled UI snapshot.
      const previous = validateSnippets(Object.hasOwn(current.settings, 'snippets')
        ? current.settings.snippets : {}, { stored: true });
      validateSettingsSnapshot(settings);
      validateSnippets(settings.snippets, { previous });
      if (nativeCall) {
        const result = await nativeCall('settings', { operation: 'save',
          expected_revision: expectedRevision, settings: JSON.stringify(settings) });
        if (result?.status === 'conflict') throw new Error(result.message || 'Settings changed; reload before saving.');
        if (result?.status !== 'committed' || !result.settings || typeof result.settings_revision !== 'string')
          throw new Error('Native settings commit acknowledgement missing; reload to resolve the outcome, no fallback applied.');
        // saveOnEdit is a retired legacy field: the native side may drop or ignore it.
        for (const field of ['provider', 'caffeinate', 'autoApproveReadOnly', 'theme', 'fontSize', 'globalPrompt', 'snippets']) {
          if (!isDeepStrictEqual(result.settings[field], settings[field]))
            throw new Error('Native settings readback differs from submitted draft; reload to resolve outcome. No runtime switch acknowledged.');
        }
        return result;
      }
      if (fileRevision() !== expectedRevision) throw new Error('Settings changed; reload before saving.');
      writeConfig(settings);
      const { settings: readback, bytes } = readConfigSnapshot({ persistMigration: false });
      return { status: 'committed', settings: readback,
        settings_revision: createHash('sha256').update(bytes).digest('hex'), authority: 'standalone' };
    }
  };
  return authority;
}
