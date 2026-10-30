// Converts user-entered effort text to a provider-supported value. An empty
// value means Auto: let the provider choose its own default. Aliases never
// create a level that the active provider does not advertise.
const EFFORT_ALIASES = {
  max: 'ultra'
};

export function resolveEffortInput(value, supportedEfforts) {
  if (typeof value !== 'string' || !Array.isArray(supportedEfforts)) return null;

  const input = value.trim().toLowerCase();
  if (!input) return '';

  const supported = new Map(
    supportedEfforts
      .filter(effort => typeof effort === 'string')
      .map(effort => [effort.toLowerCase(), effort])
  );
  if (supported.has(input)) return supported.get(input);
  const alias = EFFORT_ALIASES[input];
  if (alias && supported.has(alias)) return supported.get(alias);
  return null;
}
