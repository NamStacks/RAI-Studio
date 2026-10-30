#!/usr/bin/env python3
"""Actual retained Copilot install + Node parse/resolution only; no SDK evaluation.
Usage: test-copilot-module-format.py evidence-dir retained-workspace [case ...]
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(sys.argv.pop(1)).resolve()
WORK = Path(sys.argv.pop(1)).resolve()
EVIDENCE.mkdir(parents=True, exist_ok=True)
RAW = WORK / 'deps/arm64/copilot-language-server-js'
NODE = WORK / 'arm64-native-source-01/dependencies/common/node/22.22.2-arm64-installed/bin/node'
HOOK = ROOT / 'cmake/modules/CopilotSdkModuleFormat.cmake'


def run(*args, **kwargs):
    p = subprocess.run([str(a) for a in args], capture_output=True, text=True, **kwargs)
    with (EVIDENCE / 'commands.jsonl').open('a') as log:
        log.write(json.dumps(dict(command=p.args, exit=p.returncode, stdout=p.stdout, stderr=p.stderr)) + '\n')
    return p


class CopilotFormat(unittest.TestCase):
    def test_actual_generic_owner(self):
        text = (ROOT / 'src/cpp/session/CMakeLists.txt').read_text()
        rules = text[text.index('   # install Copilot Language Server'):text.index('   # install embedded packages')]
        case = EVIDENCE / 'generic-owner'
        case.mkdir()
        prefix = case / 'install'
        (case / 'CMakeLists.txt').write_text('cmake_minimum_required(VERSION 3.19)\nproject(CopilotOwner NONE)\n'
            'set(APPLE FALSE)\nset(RSTUDIO_ENABLE_COPILOT TRUE)\nset(RSTUDIO_INSTALL_BIN bin)\n'
            f'set(CMAKE_SOURCE_DIR "{ROOT}")\nset(RSTUDIO_DEPENDENCIES_COPILOT_DIR "{RAW}")\n' + rules)
        p = run('cmake', '-S', case, '-B', case / 'build', '-DCMAKE_INSTALL_PREFIX=' + str(prefix))
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        p = run('cmake', '--install', case / 'build')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        payload = prefix / 'bin/copilot-language-server-js'
        manifest = json.loads((payload / 'node_modules/@github/copilot/package.json').read_text())
        target = payload / 'node_modules/@github/copilot' / manifest['exports']['./sdk']['import']
        p = run(NODE, '--check', target)
        self.assertEqual(p.returncode, 0, 'active ESM entrypoint must parse: ' + p.stderr)
        self.assertEqual(target.name, 'index.mjs')
        p = run(NODE, '--input-type=module', '-e',
            'import {createRequire} from "node:module"; const r=createRequire(import.meta.url); '
            'console.log(JSON.stringify({esm:import.meta.resolve("@github/copilot/sdk"),'
            'cjs:r.resolve("./node_modules/@github/copilot/sdk/index.cjs")}));', cwd=payload)
        self.assertEqual(p.returncode, 0, p.stderr)
        result = json.loads(p.stdout)
        self.assertTrue(result['esm'].endswith('/sdk/index.mjs'))
        self.assertTrue(result['cjs'].endswith('/sdk/index.cjs'))
        for src in RAW.rglob('*'):
            rel = src.relative_to(RAW)
            dst = payload / rel
            self.assertEqual(src.stat().st_mode, dst.stat().st_mode, str(rel))
            if src.is_file() and str(rel) != 'node_modules/@github/copilot/package.json':
                self.assertEqual(src.read_bytes(), dst.read_bytes(), str(rel))
        self.assertEqual(target.read_bytes(), (RAW / 'node_modules/@github/copilot/sdk/index.js').read_bytes())
        self.assertEqual(target.stat().st_mode, (RAW / 'node_modules/@github/copilot/sdk/index.js').stat().st_mode)
        original_manifest = json.loads((RAW / 'node_modules/@github/copilot/package.json').read_text())
        original_manifest['exports']['./sdk']['import'] = './sdk/index.mjs'
        self.assertEqual(manifest, original_manifest)
        p = run(NODE, '--check', payload / 'node_modules/@github/copilot/sdk/index.cjs')
        self.assertEqual(p.returncode, 0, p.stderr)
        # Reinstallation recopies the original metadata but leaves the alias.
        p = run('cmake', '--install', case / 'build')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        env = os.environ.copy()
        env['DESTDIR'] = str(case / 'destdir')
        p = run('cmake', '--install', case / 'build', env=env)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        staged = Path(env['DESTDIR'] + str(payload))
        self.assertEqual(json.loads((staged / 'node_modules/@github/copilot/package.json').read_text()), manifest)
        self.assertEqual((staged / 'node_modules/@github/copilot/sdk/index.mjs').read_bytes(), target.read_bytes())

    def test_guards(self):
        # Small, honest subsets of actual files exercise qualification failures;
        # never treated as a product or runtime acceptance fixture.
        files = ['language-server.js', 'main.js', 'node_modules/@github/copilot/package.json',
                 'node_modules/@github/copilot/sdk/index.js', 'node_modules/@github/copilot/sdk/index.cjs',
                 'node_modules/@github/copilot/sdk/worker/conoutSocketWorker.js',
                 'node_modules/@github/copilot/sdk/conpty_console_list_agent.js']
        for damage in ('clean', 'metadata', 'version', 'entry', 'cjs', 'worker', 'main', 'launcher',
                       'nearer', 'worker-scope', 'root-scope', 'target', 'alias', 'directory',
                       'manifest-alias', 'missing-target', 'altered-derived'):
            with self.subTest(damage=damage):
                case = EVIDENCE / ('guard-' + damage)
                for name in files:
                    dst = case / name
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(RAW / name, dst)
                pkg = case / 'node_modules/@github/copilot'
                if damage in ('metadata', 'version'):
                    p = pkg / 'package.json'
                    p.write_text(p.read_text() + ' ' if damage == 'metadata' else p.read_text().replace('1.0.63', '1.0.64'))
                elif damage in ('entry', 'cjs', 'worker'):
                    p = pkg / {'entry': 'sdk/index.js', 'cjs': 'sdk/index.cjs', 'worker': 'sdk/worker/conoutSocketWorker.js'}[damage]
                    p.write_bytes(p.read_bytes() + b'\n')
                elif damage in ('main', 'launcher'):
                    p = case / ('main.js' if damage == 'main' else 'language-server.js')
                    p.write_bytes(p.read_bytes() + b'\n')
                elif damage in ('nearer', 'worker-scope', 'root-scope'):
                    p = {'nearer': pkg / 'sdk/package.json',
                         'worker-scope': pkg / 'sdk/worker/package.json',
                         'root-scope': case / 'package.json'}[damage]
                    p.write_text('{"type":"module"}')
                elif damage == 'manifest-alias':
                    p = pkg / 'package.json'
                    p.rename(pkg / 'saved-package.json')
                    p.symlink_to('saved-package.json')
                elif damage in ('missing-target', 'altered-derived'):
                    p = pkg / 'package.json'
                    p.write_text(p.read_text().replace('./sdk/index.js', './sdk/index.mjs'))
                    if damage == 'altered-derived':
                        (pkg / 'sdk/index.mjs').write_text('unrelated')
                elif damage == 'target':
                    (pkg / 'sdk/index.mjs').write_text('unrelated')
                elif damage == 'alias':
                    (pkg / 'sdk/index.mjs').symlink_to('index.js')
                elif damage == 'directory':
                    (pkg / 'sdk/index.mjs').mkdir()
                before = {str(p.relative_to(case)): p.read_bytes() for p in case.rglob('*') if p.is_file() and not p.is_symlink()}
                p = run('cmake', '-DRAI_COPILOT_ROOT=' + str(case), '-P', HOOK)
                self.assertEqual(p.returncode == 0, damage == 'clean', p.stdout + p.stderr)
                if damage != 'clean':
                    self.assertEqual(before, {str(p.relative_to(case)): p.read_bytes() for p in case.rglob('*') if p.is_file() and not p.is_symlink()})
                else:
                    p = run('cmake', '-DRAI_COPILOT_ROOT=' + str(case), '-P', HOOK)
                    self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
