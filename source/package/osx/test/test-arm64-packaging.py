#!/usr/bin/env python3
"""Focused packaging checks. Inputs are retained real product payloads, never fake apps.

Usage: python3 test-arm64-packaging.py <evidence-dir> <retained-workspace> [case ...]
Only disposable, explicitly named real-payload copies below evidence-dir are mutated.
"""
import os
import shutil
import re
from pathlib import Path
import subprocess
import sys
import unittest
import json

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(sys.argv.pop(1)).resolve()
WORK = Path(sys.argv.pop(1)).resolve()
EVIDENCE.mkdir(parents=True, exist_ok=True)


def run(*args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True)
    with (EVIDENCE / 'subprocess-receipts.jsonl').open('a') as log:
        log.write(json.dumps({'command': result.args, 'exit': result.returncode,
                              'stdout': result.stdout, 'stderr': result.stderr}) + '\n')
    return result


class Packaging(unittest.TestCase):
    def session_install(self, quarto=True, node_root=None, cpu='arm64', node_dir=None):
        # Execute the actual owning install rules, not a hand-copied filter.
        text = (ROOT / 'src/cpp/session/CMakeLists.txt').read_text()
        rules = text[text.index('   # Packaged Node follows'):text.index('   # install embedded packages')]
        case = EVIDENCE / (('session-quarto-' if quarto else 'session-pandoc-') + cpu)
        case.mkdir(exist_ok=True)
        deps = node_root or WORK / 'source/dependencies'
        prefix = case / 'real-payload-install'
        settings = {'APPLE': 'TRUE', 'CMAKE_HOST_SYSTEM_PROCESSOR': 'arm64', 'CMAKE_OSX_ARCHITECTURES': cpu,
                    'CMAKE_SYSTEM_PROCESSOR': 'arm64', 'RSTUDIO_INSTALLED_NODE_VERSION': '22.22.2',
                    'RSTUDIO_DEPENDENCIES_DIR': str(deps),
                    'RSTUDIO_DEPENDENCIES_QUARTO_DIR': str(WORK / 'deps/arm64/quarto'),
                    'RSTUDIO_DEPENDENCIES_PANDOC_DIR': str(WORK / 'deps/arm64/quarto/bin/tools'),
                    'RSTUDIO_DEPENDENCIES_COPILOT_DIR': str(WORK / 'deps/arm64/copilot-language-server-js'),
                    'RSTUDIO_INSTALL_BIN': 'bin', 'RSTUDIO_INSTALL_RESOURCES': 'Resources',
                    'RSTUDIO_ENABLE_COPILOT': 'TRUE', 'QUARTO_ENABLED': 'TRUE' if quarto else 'FALSE',
                    'CMAKE_SOURCE_DIR': str(ROOT)}
        if node_dir:
            settings['RAI_INSTALLED_NODE_DIR'] = str(node_dir)
        cmake = 'cmake_minimum_required(VERSION 3.19)\nproject(RealProductInstallRules NONE)\n'
        cmake += ''.join('set(' + k + ' "' + v + '")\n' for k, v in settings.items())
        (case / 'CMakeLists.txt').write_text(cmake + rules)
        result = run('cmake', '-S', case, '-B', case / 'build', '-DCMAKE_INSTALL_PREFIX=' + str(prefix))
        if result.returncode == 0:
            result = run('cmake', '-P', case / 'build/cmake_install.cmake')
        return result, prefix

    def assert_arm_tree(self, root):
        native = []
        for p in root.rglob('*'):
            if p.is_file() and not p.is_symlink():
                with p.open('rb') as f:
                    magic = f.read(4).hex()
                if magic not in ('feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'):
                    continue
                kind = run('/usr/bin/file', '-b', p).stdout
                if magic == 'cafebabe' and 'compiled Java class' in kind:
                    continue
                self.assertIn('Mach-O', kind, str(p))
                arch = run('/usr/bin/lipo', '-archs', p)
                self.assertEqual(arch.returncode, 0, str(p))
                self.assertEqual(arch.stdout.strip(), 'arm64', str(p))
                native.append(str(p.relative_to(root)))
        self.assertTrue(native, 'empty native census')
        return native

    def test_missing_arm_node(self):
        result, _ = self.session_install(node_root=EVIDENCE / 'missing-arm-node')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Target Node', result.stdout + result.stderr)

    # ARM-only package/overwrite expectations are superseded by the paired
    # owner tests in test-universal-packaging.py, not relaxed into ARM fallback.

    def bridge_bundle(self, source):
        values = {'RAI_BRIDGE_SOURCE_DIR': str(source), 'CMAKE_INSTALL_PREFIX': str(EVIDENCE / 'real-payload-bridge-copy'),
                  'CMAKE_CURRENT_SOURCE_DIR': str(ROOT / 'package/osx')}
        script = EVIDENCE / 'bridge-bundle.cmake'
        template = (ROOT / 'package/osx/cmake/bundle-rai-bridge.cmake').read_text()
        script.write_text(re.sub(r'@([A-Z0-9_]+)@', lambda m: values.get(m[1], m[0]), template))
        return run('cmake', '-P', script), Path(values['CMAKE_INSTALL_PREFIX']) / 'RAI-Studio.app/Contents/Resources/app/rai-chat-bridge'

    def test_bridge_payload(self):
        retained = WORK / 'signing-stage-02/RAI-Studio.app/Contents/Resources/app/rai-chat-bridge'
        source = EVIDENCE / 'real-bridge-executable-mode-copy'
        shutil.copytree(retained, source, symlinks=True)
        (source / 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper').chmod(0o755)
        result, dest = self.bridge_bundle(source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for name in ('pty.node', 'spawn-helper'):
            self.assertTrue((dest / 'node_modules/node-pty/prebuilds/darwin-arm64' / name).is_file())
        self.assertEqual((source / 'server.js').read_bytes(), (dest / 'server.js').read_bytes())
        for filename in ('package.json', 'package-lock.json'):
            self.assertEqual((source / filename).read_bytes(), (dest / filename).read_bytes())
        # Only this disposable real-payload copy receives malformed dependency links.
        bad = EVIDENCE / 'real-payload-bridge-negative-copy'
        if not bad.exists():
            shutil.copytree(source, bad, symlinks=True)
        link = bad / 'node_modules/escape-regression'
        if link.is_symlink():
            link.unlink()
        link.symlink_to(source / 'server.js')
        result, _ = self.bridge_bundle(bad)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Escaping package symlink', result.stdout + result.stderr)
        link.unlink()
        link.symlink_to(bad / 'missing-dependency')
        result, _ = self.bridge_bundle(bad)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Dangling package symlink', result.stdout + result.stderr)
        link.unlink()
        helper = bad / 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
        saved = helper.read_bytes()
        try:
            shutil.copyfile(source / 'server.js', helper)
            result, _ = self.bridge_bundle(bad)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Required native Mach-O invalid', result.stdout + result.stderr)
        finally:
            helper.write_bytes(saved)

    def test_scan_admission(self):
        root = EVIDENCE / 'real-payload-scan-copy'
        root.mkdir(exist_ok=True)
        script = EVIDENCE / 'scan-admission.cmake'
        script.write_text('include("' + str(ROOT / 'package/osx/cmake/arm64-payload.cmake') + '")\n'
                          'rai_arm64_payload("' + str(root) + '" TRUE)\n')
        result = run('cmake', '-P', script)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Empty ARM64 native payload scan', result.stdout + result.stderr)
        native = root / 'native'
        shutil.copy2(WORK / 'deps/arm64/copilot-language-server-js/bin/darwin/x64/rg', native)
        result = run('cmake', '-P', script)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ARM64 slice missing', result.stdout + result.stderr)
        native.unlink()
        # A real compiled Java class must not be misclassified by CAFEBABE alone.
        classes = list((WORK / 'native').rglob('*.class'))
        self.assertTrue(classes, 'retained real Java class needed')
        shutil.copy2(classes[0], root / 'retained.class')
        shutil.copy2(WORK / 'deps/arm64/copilot-language-server-js/compiled/darwin/arm64/kerberos.node', native)
        result = run('cmake', '-P', script)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(run('/usr/bin/lipo', '-archs', native).stdout.strip(), 'arm64')
        self.assertEqual((root / 'retained.class').read_bytes(), classes[0].read_bytes())
        native.unlink()
        (root / 'retained.class').unlink()

    def test_electron_launcher_admission(self):
        source = WORK / 'source/src/node/desktop-build-arm64/out/RAI-Studio-darwin-arm64/RAI-Studio.app'
        copy = EVIDENCE / 'real-electron-negative-copy/out/RAI-Studio-darwin-arm64/RAI-Studio.app'
        shutil.copytree(source, copy, symlinks=True)
        launcher = copy / 'Contents/MacOS/RAI-Studio'
        saved, mode = launcher.read_bytes(), launcher.stat().st_mode
        values = {'NODEJS': '/opt/homebrew/opt/node@22/bin/node',
                  'CMAKE_CURRENT_SOURCE_DIR': str(ROOT / 'package/osx'),
                  'ELECTRON_BINARY_DIR': str(copy.parents[2])}
        script = EVIDENCE / 'electron-launcher-admission.cmake'
        template = (ROOT / 'package/osx/cmake/merge-electron.cmake').read_text()
        script.write_text(re.sub(r'@([A-Z0-9_]+)@', lambda m: values.get(m[1], m[0]), template))
        # All mutations are confined to this labeled copy of the real output.
        for damage in ('text', 'truncated', 'directory', 'nonexecutable'):
            with self.subTest(damage=damage):
                dest = EVIDENCE / ('electron-refused-' + damage)
                dest.mkdir()
                try:
                    if damage == 'text':
                        shutil.copyfile(ROOT / 'package/osx/scripts/fix-library-paths.sh', launcher)
                    elif damage == 'truncated':
                        launcher.write_bytes(saved[:2])
                    elif damage == 'directory':
                        launcher.unlink()
                        launcher.mkdir()
                    else:
                        launcher.chmod(mode & ~0o111)
                    result = run(WORK / 'source/dependencies/common/node/22.22.2-arm64/bin/node',
                                 ROOT / 'package/osx/scripts/merge-electron.mjs', copy, source,
                                 dest / 'never-assembled.app', '--validate-only')
                    self.assertNotEqual(result.returncode, 0, 'malformed launcher admitted: ' + damage + '\n' + result.stdout + result.stderr)
                    self.assertIn('Required Electron launcher invalid', result.stdout + result.stderr)
                    self.assertEqual(list(dest.iterdir()), [], 'refusal must precede rsync')
                finally:
                    if launcher.is_dir():
                        launcher.rmdir()
                    launcher.write_bytes(saved)
                    launcher.chmod(mode)
        dest = EVIDENCE / 'electron-valid-launcher-copy'
        dest.mkdir()
        result = run(WORK / 'source/dependencies/common/node/22.22.2-arm64/bin/node',
                     ROOT / 'package/osx/scripts/merge-electron.mjs', copy, source,
                     dest / 'never-assembled.app', '--validate-only')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('x86_64 slice missing', result.stdout + result.stderr)
        self.assertEqual(launcher.read_bytes(), saved)
        self.assertEqual(list(dest.iterdir()), [])

    def test_electron_missing_input(self):
        values = {'NODEJS': str(WORK / 'source/dependencies/common/node/22.22.2-arm64/bin/node'),
                  'CMAKE_CURRENT_SOURCE_DIR': str(ROOT / 'package/osx'),
                  'RAI_ELECTRON_X86_64_APP': str(EVIDENCE / 'missing-intel.app'),
                  'RAI_ELECTRON_ARM64_APP': str(EVIDENCE / 'missing-arm.app')}
        script = EVIDENCE / 'electron-missing.cmake'
        template = (ROOT / 'package/osx/cmake/merge-electron.cmake').read_text()
        script.write_text(re.sub(r'@([A-Z0-9_]+)@', lambda m: values.get(m[1], m[0]), template))
        result = run('cmake', '-P', script)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Universal Electron input missing', result.stdout + result.stderr)

    def root_admission_preamble(self):
        # Exact real root bytes, bounded BEFORE the first mutating include.
        # A code-unit admission driver, not native app QA or a full configure.
        text = (ROOT / 'CMakeLists.txt').read_text()
        preamble = text[:text.index('include(cmake/init.cmake)')]
        # The sole permitted pre-init process is a bounded, read-only host query.
        host_query = re.compile(r'execute_process\(COMMAND /usr/bin/uname -m\s+'
            r'OUTPUT_VARIABLE _RAI_NATIVE_HOST_PROCESSOR OUTPUT_STRIP_TRAILING_WHITESPACE\s+'
            r'RESULT_VARIABLE _RAI_HOST_QUERY_RESULT TIMEOUT 5\)')
        self.assertEqual(len(host_query.findall(preamble)), 1)
        self.assertNotRegex(host_query.sub('', preamble),
            r'(?im)^\s*(include|project|add_subdirectory|execute_process|configure_file|file)\s*\(')
        return preamble

    def test_root_early_admission(self):
        preamble = self.root_admission_preamble()
        cases = [
            ('Darwin', '', 'x86_64', '', False, True),
            ('Darwin', '', 'arm64;x86_64', '', False, False),
            ('Darwin', '', 'arm64', '', True, True),
            ('Linux', 'Darwin', 'x86_64', '', False, True),
            ('Linux', 'Darwin', '', 'x86_64', False, True),
            ('Linux', 'Darwin', '', '', False, True),
            ('Darwin', '', '', '', False, True),
            ('Darwin', '', 'arm64', '', False, True),
            ('Linux', 'Linux', 'x86_64', 'x86_64', True, True),
            ('Darwin', 'Windows', 'x86_64', 'x86_64', True, True),
        ]
        for i, (host, target, arch, processor, alternate, admitted) in enumerate(cases):
            with self.subTest(host=host, target=target, arch=arch, alternate=alternate):
                script = EVIDENCE / ('root-admission-' + str(i) + '.cmake')
                settings = {'CMAKE_HOST_SYSTEM_NAME': host, 'CMAKE_SYSTEM_NAME': target, 'CMAKE_HOST_SYSTEM_PROCESSOR': 'arm64',
                            'CMAKE_OSX_ARCHITECTURES': arch, 'CMAKE_SYSTEM_PROCESSOR': processor,
                            'RSESSION_ALTERNATE_BUILD': 'TRUE' if alternate else 'FALSE'}
                script.write_text(''.join('set(' + k + ' "' + v + '")\n' for k, v in settings.items()) +
                                  preamble + '\nmessage(STATUS "BOUNDED init boundary reached: ${CMAKE_OSX_ARCHITECTURES}")\n')
                result = run('cmake', '-P', script)
                output = result.stdout + result.stderr
                if admitted:
                    self.assertEqual(result.returncode, 0, output)
                    expected = arch or processor or 'arm64'
                    self.assertIn('BOUNDED init boundary reached: ' + expected, output)
                else:
                    self.assertNotEqual(result.returncode, 0, 'unsupported target reached init boundary: ' + output)
                    self.assertIn('macOS requires one arm64 or x86_64 target', output)
                    self.assertNotIn('BOUNDED init boundary reached', output)

    def test_fresh_unseeded_native_preamble(self):
        preamble = self.root_admission_preamble()
        native_cpu = run('/usr/bin/uname', '-m').stdout.strip()
        self.assertIn(native_cpu, ('arm64', 'x86_64'))
        for label, settings, accepted in (
                ('native-default', '', True),
                ('wrong-arch', 'set(CMAKE_OSX_ARCHITECTURES ppc64)\n', False),
                ('multi-arch', 'set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64")\n', False),
                ('wrong-processor', 'set(CMAKE_SYSTEM_NAME Darwin)\nset(CMAKE_SYSTEM_PROCESSOR ppc64)\n', False),
                ('multi-processor', 'set(CMAKE_SYSTEM_NAME Darwin)\nset(CMAKE_SYSTEM_PROCESSOR "arm64;x86_64")\n', False)):
            with self.subTest(label=label):
                case = EVIDENCE / label
                case.mkdir()
                (case / 'CMakeLists.txt').write_text('cmake_minimum_required(VERSION 3.19)\n'
                    'if(DEFINED CMAKE_HOST_SYSTEM_PROCESSOR)\n'
                    'message(FATAL_ERROR "test host processor was preseeded")\nendif()\n' + settings + preamble +
                    '\nmessage(STATUS "BOUNDED init boundary reached: ${CMAKE_OSX_ARCHITECTURES}")\n'
                    'project(BoundedNativePreamble NONE)\n')
                result = run('cmake', '-S', case, '-B', case / 'build')
                output = result.stdout + result.stderr
                self.assertEqual(result.returncode == 0, accepted, output)
                if accepted:
                    self.assertIn('BOUNDED init boundary reached: ' + native_cpu, output)
                else:
                    self.assertIn('macOS requires one arm64 or x86_64 target', output)
                    self.assertNotIn('BOUNDED init boundary reached', output)
                    self.assertFalse((case / 'build/CMakeFiles/CMakeSystem.cmake').exists())
                    self.assertFalse(list((case / 'build').rglob('CMakeCCompiler.cmake')))

    def test_cmake_default_arm64(self):
        guard = self.root_admission_preamble()
        script = EVIDENCE / 'default-target.cmake'
        script.write_text('set(CMAKE_HOST_SYSTEM_NAME Darwin)\nset(CMAKE_SYSTEM_NAME "")\n'
                          'set(CMAKE_HOST_SYSTEM_PROCESSOR arm64)\n'
                          'set(CMAKE_OSX_ARCHITECTURES "")\n' + guard +
                          '\nif(NOT CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")\n'
                          'message(FATAL_ERROR "missing default arm64")\nendif()\n')
        result = run('cmake', '-P', script)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_target_contract(self):
        preamble = (ROOT / 'package/osx/make-package').read_text().split(
            'source "${PKG_DIR}/../../dependencies/tools/rstudio-tools.sh"')[0]
        for arch in ('arm64', 'x86_64', 'x64', 'universal', 'arm64,x86_64', '', 'arm64e'):
            result = run('bash', '-c', preamble, str(ROOT / 'package/osx/make-package'), '--arch=' + arch)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('macOS release packaging requires x86_64,arm64', result.stdout + result.stderr)
        result = run('bash', '-c', preamble, str(ROOT / 'package/osx/make-package'), '--arch=x86_64,arm64')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for arch in ('arm64;x86_64', ''):
            script = EVIDENCE / 'target-contract.cmake'
            script.write_text('set(APPLE TRUE)\nset(CMAKE_SYSTEM_PROCESSOR "' + arch + '")\n'
                              'set(CMAKE_OSX_ARCHITECTURES "' + arch + '")\n'
                              'include("' + str(ROOT / 'package/osx/CMakeLists.txt') + '")\n')
            result = run('cmake', '-P', script)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('macOS release requires x86_64 primary and arm64 alternate', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
