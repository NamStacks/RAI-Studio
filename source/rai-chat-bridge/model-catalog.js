// Settings must never derive model availability from provider API/debug commands.
// The only safe source is a model observed in the active provider PTY banner
// or an explicit model-change confirmation, passed in by the bridge server.
import { settingsCatalogForActiveModels } from './model-reflection.js';

export function catalogForSettings(config, activeModels = {}) {
  return settingsCatalogForActiveModels(config, activeModels);
}
