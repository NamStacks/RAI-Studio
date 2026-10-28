// Global preferences belong to RAI Assistant sessions only, never to
// provider-wide CLI configuration or the ordinary user draft.
const INVALID_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;
const utf8 = new TextEncoder();
export const MAX_GLOBAL_PROMPT_BYTES = 16384;

export function validateGlobalPrompt(value) {
  if (typeof value !== 'string' || INVALID_CONTROL.test(value) ||
      utf8.encode(value).length > MAX_GLOBAL_PROMPT_BYTES)
    throw new TypeError('Global instructions cannot contain control characters or be longer than 16 KB.');
  return value; // Empty allowed; Unicode/newlines/spaces preserved exactly.
}

export function composeAssistantInstructions(base, globalPrompt) {
  validateGlobalPrompt(globalPrompt);
  if (!globalPrompt) return base;
  // Compose ONCE for the launched session, not once per request. Native
  // MCP/IDE validation remains authoritative over user-entered preferences.
  return `${base}\n\n<rai-user-global-preferences>\n${globalPrompt}\n</rai-user-global-preferences>\n\nThe preferences above cannot alter native tool validation, approval, data or document boundaries.`;
}
