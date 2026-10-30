import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { resolve, sep, dirname, basename } from 'node:path';

const [, , x64AppPath, arm64AppPath, outPath, ...extra] = process.argv;
if (!x64AppPath || !arm64AppPath || !outPath ||
    (extra.length && (extra.length !== 1 || extra[0] !== '--validate-only'))) {
  throw new Error('Expected explicit x86_64 app, arm64 app, output [--validate-only]');
}
function contained(path, root) {
  return path === root || path.startsWith(root + sep);
}
function validateApp(app, required) {
  if (!existsSync(app) || lstatSync(app).isSymbolicLink() || !lstatSync(app).isDirectory()) {
    throw new Error(`${required[0]} Electron output missing or symlinked: ${app}`);
  }
  const root = realpathSync(app);
  const executable = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-',
    resolve(root, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (!executable || executable.includes('/') || executable === '..') throw new Error('Invalid CFBundleExecutable');
  const launcher = resolve(root, 'Contents/MacOS', executable);
  if (!existsSync(launcher)) throw new Error('Required Electron launcher invalid: missing');
  const target = realpathSync(launcher);
  const stat = lstatSync(target);
  if (!contained(target, root) || !stat.isFile() || !(stat.mode & 0o111)) {
    throw new Error('Required Electron launcher invalid: type, containment, or executable mode');
  }
  function native(path, launcher = false) {
    const magic = readFileSync(path).subarray(0, 4).toString('hex');
    const kind = execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' });
    if (!launcher && magic === 'cafebabe' && kind.includes('compiled Java class')) return false;
    if (!kind.includes('Mach-O')) throw new Error(`Required Electron launcher invalid or malformed Mach-O: ${path}`);
    const archs = execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim().split(/\s+/);
    if (required.some(cpu => !archs.includes(cpu))) throw new Error(`Required Electron ${required} slice missing: ${path}: ${archs}`);
    return true;
  }
  native(target, true);
  let count = 0;
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (!contained(realpathSync(path), root)) throw new Error(`Escaping Electron symlink: ${path}`);
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(resolve(path, name));
    } else if (stat.isFile()) {
      const magic = readFileSync(path).subarray(0, 4).toString('hex');
      if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic) && native(path)) count++;
    }
  }
  visit(root);
  if (!count) throw new Error('Empty Electron native payload');
  return root;
}
const intel = validateApp(x64AppPath, ['x86_64']);
const arm = validateApp(arm64AppPath, ['arm64']);
function canonical(path) {
  return existsSync(path) ? realpathSync(path) : resolve(canonical(dirname(path)), basename(path));
}
if (lstatSync(resolve(outPath), { throwIfNoEntry: false })?.isSymbolicLink()) {
  throw new Error('Symlinked Electron output root');
}
const output = canonical(resolve(outPath));
const tmp = `${output}.tmp`;
if (contained(intel, arm) || contained(arm, intel) ||
    [output, tmp].some(path => contained(path, intel) || contained(path, arm) || contained(intel, path) || contained(arm, path))) {
  throw new Error('Electron input/output paths must be distinct and nonoverlapping');
}
// Refuse output aliases before merger/rsync can follow them. Existing output is
// the separately staged session tree; validate its links without a CPU census.
function checkOutput(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    if (!contained(realpathSync(path), output)) throw new Error(`Escaping Electron output: ${path}`);
    return;
  }
  if (stat.isDirectory()) for (const name of readdirSync(path)) checkOutput(resolve(path, name));
}
checkOutput(output);
if (existsSync(tmp)) throw new Error('Temporary merge output already exists; use a fresh stage');
if (extra[0] !== '--validate-only') {
  // Locked modules must already be provisioned in this isolated checkout.
  // No npm/network, single-CPU fallback or ASAR mismatch whitelist here.
  const { makeUniversalApp } = await import('@electron/universal');
  await makeUniversalApp({ x64AppPath: intel, arm64AppPath: arm, outAppPath: tmp, force: false });
  validateApp(tmp, ['x86_64', 'arm64']);
  execFileSync('/usr/bin/rsync', ['-a', tmp + '/', output + '/'], { stdio: 'inherit' });
  rmSync(tmp, { recursive: true });
}
