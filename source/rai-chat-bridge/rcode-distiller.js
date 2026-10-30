// Strict boundary between assistant language and RStudio Console execution.
// Only this schema may cross from the LLM harness to the native R session.
export class RConsoleProposalError extends Error {}

export function validateRConsoleProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RConsoleProposalError('run_r requires an R Console proposal object');
  }
  if (value.language !== 'R' || value.target !== 'console') {
    throw new RConsoleProposalError('proposal must declare language="R" and target="console"');
  }
  const allowed = new Set(['language', 'target', 'code']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RConsoleProposalError('proposal contains unsupported fields');
  }
  try {
    return distillRCode(value.code);
  } catch (error) {
    throw new RConsoleProposalError(error instanceof Error ? error.message : String(error));
  }
}

// Converts a model-provided R payload into a Console-safe code chunk.
// It does not infer code from prose. The native R parser remains the final gate.
export class RCodeDistillError extends Error {}

export function distillRCode(value) {
  if (typeof value !== 'string') {
    throw new RCodeDistillError('run_r requires an R code string');
  }

  const source = value.trim();
  if (!source) throw new RCodeDistillError('run_r requires executable R code');

  // Markdown is never a Console payload. The assistant must submit only the
  // already-distilled raw R source, with no fences or surrounding prose.
  if (source.includes('```')) {
    throw new RCodeDistillError('run_r accepts raw R code only; Markdown fences are not allowed');
  }

  // A complete JSON value is data for another interpreter, not R source. Parse
  // only object/array-shaped payloads so R strings and ordinary braced blocks
  // remain valid candidates for the native R parser.
  if (/^[{[]/.test(source)) {
    try {
      const parsed = JSON.parse(source);
      if (parsed && typeof parsed === 'object') {
        throw new RCodeDistillError('run_r rejects JSON payloads; submit raw R code only');
      }
    } catch (error) {
      if (error instanceof RCodeDistillError) throw error;
      // Not complete JSON: leave braced R source for the native R parser.
    }
  }

  // A hashbang selects a shell interpreter. It is never executable R Console
  // source, even though ordinary # comments remain valid R source.
  if (/^#!/.test(source)) {
    throw new RCodeDistillError('run_r rejects hashbang scripts; submit raw R code only');
  }

  // NOTE: single-vs-multi-statement enforcement is deliberately NOT done here.
  // Legitimate single R statements routinely span multiple lines (comments,
  // pipes, multi-line calls), so a JS-side line/`;`-scanner is unsound and
  // rejects valid code (see git history/security review 2026-07-27). The
  // real R parser on the native side is the authoritative, syntax-correct
  // gate for "exactly one statement" (enforced R-side; a violation surfaces
  // back through this same proposal path as a native rejection message, see
  // test/rai-native-mcp.test.js). The approval-card UI is the human-facing
  // defense against a multi-statement proposal being approved unreviewed.

  // Raw payloads are allowed only when they do not look like a natural-language
  // request. Syntactic validation occurs again inside the active R session.
  if (/^(?:run|execute|please|can you|could you|use|tell me|show me)\s+\w/i.test(source)) {
    throw new RCodeDistillError('run_r requires the generated R code, not the user request');
  }
  return source;
}
