// Deterministic regression for the scripted RAI suite's bridge precondition.
// Run: npx tsx tests/panes/rai-assistant/bridge-bundle-guard.unit.ts [bundle.app ...]
//
// Not a Playwright spec (the name does not match *.test.ts), so it needs no app
// launch and no GUI: it exercises bundledBridgeProblem() against synthetic
// bundle layouts, then against any real .app bundles given on the command line.
// Exit status is non-zero on any unexpected result.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bundledBridgeProblem } from './scripted-rai.fixture';

function makeBundle(root: string, withBridge: boolean): string {
  const exe = path.join(root, 'X.app', 'Contents', 'MacOS', 'RAI-Studio');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  const bridge = path.join(root, 'X.app', 'Contents', 'Resources', 'app', 'rai-chat-bridge');
  fs.mkdirSync(bridge, { recursive: true });
  if (withBridge)
    fs.writeFileSync(path.join(bridge, 'server.js'), '');
  return exe;
}

const saved = process.env.RAI_BRIDGE_DIR;
delete process.env.RAI_BRIDGE_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-guard-'));
let checks = 0;
try {
  // Bundled bridge present: no problem, the tests run and assert as before.
  assert.equal(bundledBridgeProblem(makeBundle(path.join(tmp, 'good'), true)), undefined); checks++;

  // Bundle packaged without the bridge (the hosted-CI failure): a named reason.
  const missing = bundledBridgeProblem(makeBundle(path.join(tmp, 'bad'), false));
  assert.ok(missing && missing.includes('no bundled RAI bridge'), String(missing)); checks++;
  assert.ok(missing!.includes(path.join('rai-chat-bridge', 'server.js'))); checks++;

  // Explicit override honoured exactly as the product does, both ways.
  const override = path.join(tmp, 'override');
  fs.mkdirSync(override);
  process.env.RAI_BRIDGE_DIR = override;
  assert.ok(bundledBridgeProblem(makeBundle(path.join(tmp, 'bad2'), false))?.includes('has no server.js')); checks++;
  fs.writeFileSync(path.join(override, 'server.js'), '');
  assert.equal(bundledBridgeProblem(makeBundle(path.join(tmp, 'bad3'), false)), undefined); checks++;
  delete process.env.RAI_BRIDGE_DIR;

  // Non-bundle layouts (Linux /usr/bin/rstudio, Windows .exe) are not judged here.
  assert.equal(bundledBridgeProblem('/usr/bin/rstudio'), undefined); checks++;

  // Real bundles passed on the command line: report the verdict for each.
  // Prefix "expect-missing:" or "expect-present:" to assert it.
  for (const arg of process.argv.slice(2)) {
    const [mode, bundle] = arg.includes(':') ? arg.split(/:(.*)/s) : ['report', arg];
    const macos = path.join(bundle, 'Contents', 'MacOS');
    const exe = fs.readdirSync(macos).map((n) => path.join(macos, n))[0];
    const verdict = bundledBridgeProblem(exe);
    console.log(`${bundle}: ${verdict ?? 'bridge bundled'}`);
    if (mode === 'expect-missing') { assert.ok(verdict, `${bundle} unexpectedly has a bridge`); checks++; }
    if (mode === 'expect-present') { assert.equal(verdict, undefined); checks++; }
    if (mode !== 'expect-missing') {
      assert.equal(verdict, undefined, `${bundle} lacks bundled bridge`);
      const bridgeRoot = path.join(bundle, 'Contents', 'Resources', 'app', 'rai-chat-bridge');
      for (const relative of ['public/scoped-guidance.js', 'public/vendor/addon-image.js',
        'prompts/RAI-Assistant.md']) {
        const item = path.join(bridgeRoot, relative);
        assert.ok(fs.statSync(item).size > 0, `missing/empty expanded bridge asset: ${item}`);
        checks++;
      }
    }
  }
  console.log(`bridge-bundle-guard: ${checks} checks passed`);
} finally {
  if (saved === undefined) delete process.env.RAI_BRIDGE_DIR; else process.env.RAI_BRIDGE_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
}
