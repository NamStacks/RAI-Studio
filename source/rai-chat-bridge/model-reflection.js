function stripAnsi(value) {
  return String(value).replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
}

function modelFromBanner(provider, output) {
  const text = stripAnsi(output);
  if (provider === 'claude') {
    // Current Claude Code banner: "Sonnet 5 with high effort · Claude Max".
    const current = text.match(/(?:^|\n)\s*(?:[│|]\s*)?((?:Opus|Sonnet|Haiku)(?:\s+[0-9][A-Za-z0-9._-]*)?)\s+with\s+/im);
    if (current) return current[1];
    // Older Claude Code banner: "Claude Code ... Model: claude-sonnet-4-5".
    const legacy = text.match(/\bClaude Code\b[\s\S]{0,2048}?\bModel\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s*(?:\r?\n|[│╰]))/i);
    return legacy?.[1] || null;
  }
  if (provider === 'opencode') {
    // OpenCode's TUI has no documented, stable startup banner format for its
    // active "provider/model" selection. Guessing a regex here risks a false
    // match against unrelated TUI chrome, so this intentionally returns null
    // (same "don't guess" fallback already used for unrecognized providers).
    return null;
  }
  const providerBanner = /\bcodex\b/i;
  if (!providerBanner.test(text)) return null;
  const match = text.match(/(?:^|\n)[^\n]*\bmodel\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  return match?.[1] || null;
}

export function parseActiveModelBanner(provider, output) {
  return modelFromBanner(provider, output);
}

export function parseConfirmedModelChange(output) {
  const text = stripAnsi(output);
  const match = text.match(/\b(?:model\s+(?:changed|switched|set)\s+(?:to|:)|using\s+model\s*:)\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  return match?.[1] || null;
}

export class ActiveModelTracker {
  #provider;
  #startupOutput = '';
  #acceptStartupBanner = true;
  #expectModelChange = false;

  constructor(provider) {
    this.#provider = provider;
  }

  noteInput(data) {
    this.#acceptStartupBanner = false;
    if (/(?:^|[\r\n])\s*\/model(?:\s|$)/i.test(String(data))) this.#expectModelChange = true;
  }

  observe(output) {
    let model = null;
    if (this.#acceptStartupBanner) {
      this.#startupOutput = (this.#startupOutput + String(output)).slice(-65536);
      model = parseActiveModelBanner(this.#provider, this.#startupOutput);
    }
    if (!model && this.#expectModelChange) {
      model = parseConfirmedModelChange(output);
      if (model) this.#expectModelChange = false;
    }
    return model;
  }
}

function uniqueModels(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.trim() !== ''))];
}

export function resolveVerifiedModelAlias(value, reportedModels) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return { ok: true, model: '' };
  const needle = input.toLowerCase();
  const matches = uniqueModels(reportedModels).filter(model => {
    const candidate = model.toLowerCase();
    return candidate === needle || candidate.endsWith(`-${needle}`);
  });
  // An unknown alias must not become a guessed model ID. Fall back to the
  // provider's authenticated default by returning an empty model override.
  return matches.length === 1
    ? { ok: true, model: matches[0] }
    : { ok: true, model: '', fallback: true };
}

export function resolveRequestedModel({ provider, authMode, value, activeModel }) {
  const requested = typeof value === 'string' ? value.trim().toLowerCase() : '';
  // Claude's documented family selectors are subscription-only and must not
  // bleed into API or Codex profiles.
  if (provider === 'claude' && authMode === 'subscription' && ['opus', 'sonnet', 'haiku'].includes(requested)) {
    return { ok: true, model: requested };
  }
  // RAI-Studio's approved Codex subscription aliases are explicit model IDs,
  // not inferred from banners or API catalog output.
  if (provider === 'codex' && authMode === 'subscription') {
    const codexAliases = {
      sol: 'gpt-5.6-sol',
      terra: 'gpt-5.6-terra',
      luna: 'gpt-5.6-luna'
    };
    if (codexAliases[requested]) return { ok: true, model: codexAliases[requested] };
  }
  // Every other selector must be proven by the provider's live active
  // terminal. Unknown inputs clear the override and use account default.
  return resolveVerifiedModelAlias(value, activeModel ? [activeModel] : []);
}

export function settingsCatalogForActiveModels(config, activeModels = {}) {
  const providers = structuredClone(config.providers || {});
  for (const [key, provider] of Object.entries(providers)) {
    const active = activeModels[key];
    const reportedModels = uniqueModels(Array.isArray(active) ? active : [active]);
    delete provider.models;
    delete provider.modelsSource;
    provider.reportedModels = reportedModels;
    if (reportedModels[0]) provider.activeModel = reportedModels[0];
  }
  return { ...config, providers };
}
