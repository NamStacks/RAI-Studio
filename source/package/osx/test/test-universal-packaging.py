#!/usr/bin/env python3
"""Source-owner unit regressions on retained inputs; NOT native acceptance.
Usage: python3 test-universal-packaging.py evidence-dir retained-workspace [case ...]
No full wrapper, npm lifecycle, Electron assembly or native execution is run.
"""
import importlib.util
import os
from pathlib import Path
import re
import shutil
import sys
import unittest

spec = importlib.util.spec_from_file_location('retained_tests', Path(__file__).with_name('test-arm64-packaging.py'))
assert spec is not None and spec.loader is not None
old = importlib.util.module_from_spec(spec)
spec.loader.exec_module(old)
ROOT, EVIDENCE, WORK, run = old.ROOT, old.EVIDENCE, old.WORK, old.run

class Universal(unittest.TestCase):
    def cmake(self, name, text):
        script = EVIDENCE / (name + '.cmake')
        script.write_text('cmake_minimum_required(VERSION 3.19)\n' + text)
        return run('cmake', '-P', script)

    def test_postback_alternate_producer_graph(self):
        # Execute the real session caller, real postback subdirectory and real
        # executable macro. Configure/generate only; no product compilation.
        text = (ROOT / 'src/cpp/session/CMakeLists.txt').read_text()
        start = text.index('# include resources, R scripts and binaries')
        stop = text.index('   # HTML resources', start)
        caller = text[start:stop] + 'endif()\n'
        globals_text = (ROOT / 'cmake/globals.cmake').read_text()
        macros = globals_text[globals_text.index('function(define_source_file_names '):
                              globals_text.index('endmacro(add_stripped_executable)') + len('endmacro(add_stripped_executable)')]
        for alternate, win32 in ((False, False), (True, False), (True, True)):
            with self.subTest(alternate=alternate, win32=win32):
                case = EVIDENCE / f'postback-graph-{int(alternate)}-{int(win32)}'
                case.mkdir()
                # Keep source-relative add_subdirectory semantics without
                # writing into the product source or substituting a producer.
                (case / 'postback').symlink_to(ROOT / 'src/cpp/session/postback', target_is_directory=True)
                (case / 'CMakeLists.txt').write_text('cmake_minimum_required(VERSION 3.19)\n'
                    'project(PostbackOwnerGraph C CXX)\n' + macros + '\n'
                    f'set(RSESSION_ALTERNATE_BUILD {int(alternate)})\n'
                    f'set(RSTUDIO_SESSION_WIN32 {int(win32)})\n'
                    'set(RSTUDIO_INSTALL_BIN bin)\n' + caller +
                    '\nif(TARGET rpostback)\n'
                    'get_target_property(kind rpostback TYPE)\n'
                    'get_target_property(excluded rpostback EXCLUDE_FROM_ALL)\n'
                    'if(NOT kind STREQUAL "EXECUTABLE" OR excluded)\n'
                    'message(FATAL_ERROR "postback not an all-target executable")\nendif()\n'
                    'file(GENERATE OUTPUT "${CMAKE_BINARY_DIR}/postback-target.txt" CONTENT "$<TARGET_FILE:rpostback>")\n'
                    'elseif(NOT RSTUDIO_SESSION_WIN32)\n'
                    'message(FATAL_ERROR "fresh session producer omits rpostback target")\nendif()\n')
                result = run('cmake', '-S', case, '-B', case / 'build',
                    '-DCMAKE_OSX_SYSROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk',
                    '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                target = case / 'build/postback-target.txt'
                self.assertEqual(target.exists(), not win32)
                if not win32:
                    self.assertEqual(target.read_text(), str(case / 'build/postback/rpostback'))
                    self.assertIn('postback/all', (case / 'build/CMakeFiles/Makefile2').read_text())
                    install_rules = (case / 'build/postback/cmake_install.cmake').read_text()
                    self.assertEqual('rpostback-askpass' in install_rules, not alternate,
                                     'postback resource installation must remain primary-only')
                # Resource rules must still remain under the primary-only guard.
                resource_guard = text[:stop].rfind('if(NOT RSTUDIO_SESSION_WIN32 AND NOT RSESSION_ALTERNATE_BUILD)')
                self.assertGreaterEqual(resource_guard, start)

    def test_root_targets(self):
        preamble = (ROOT / 'CMakeLists.txt').read_text().split('include(cmake/init.cmake)')[0]
        for arch, alternate, release, ok in [('x86_64', False, True, True), ('arm64', True, True, True),
                ('arm64', False, False, True), ('arm64;x86_64', False, True, False),
                ('x86_64', True, True, False), ('arm64', False, True, False)]:
            with self.subTest(arch=arch, alternate=alternate, release=release):
                result = self.cmake('root', 'set(CMAKE_HOST_SYSTEM_NAME Darwin)\n'
                    f'set(CMAKE_OSX_ARCHITECTURES "{arch}")\nset(RSESSION_ALTERNATE_BUILD {int(alternate)})\n'
                    f'set(RSTUDIO_PACKAGE_BUILD {int(release)})\n' + preamble)
                self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)

    def test_bridge_both_cpus(self):
        helper = old.Packaging()
        retained = WORK / 'signing-stage-02/RAI-Studio.app/Contents/Resources/app/rai-chat-bridge'
        # The old x64 helper is mode 0644: retain its honest rejection. Only a
        # disposable unit input exercises the valid executable-mode branch.
        result, _ = helper.bridge_bundle(retained)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Required native executable invalid', result.stdout + result.stderr)
        source = EVIDENCE / 'real-bridge-executable-mode-copy'
        shutil.copytree(retained, source, symlinks=True)
        (source / 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper').chmod(0o755)
        result, dest = helper.bridge_bundle(source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for cpu in ('arm64', 'x64'):
            for name in ('pty.node', 'spawn-helper'):
                path = Path('node_modules/node-pty/prebuilds') / ('darwin-' + cpu) / name
                self.assertEqual((source / path).read_bytes(), (dest / path).read_bytes())
        bad = EVIDENCE / 'retained-bridge-missing-x64'
        shutil.copytree(source, bad, symlinks=True, dirs_exist_ok=True)
        shutil.rmtree(bad / 'node_modules/node-pty/prebuilds/darwin-x64')
        result, _ = helper.bridge_bundle(bad)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('x86_64', result.stdout + result.stderr)

    def test_copilot_resource_owner_executable_modes(self):
        # Required real roles only, never substituted binaries or release inputs.
        source = WORK / 'deps/arm64/copilot-language-server-js'
        payload = EVIDENCE / 'copilot-required-real-copy'
        for cpu in ('arm64', 'x64'):
            names = [f'bin/darwin/{cpu}/rg']
            names += [f'compiled/darwin/{cpu}/{m}.node' for m in
                      ('keytar', 'watcher', 'kerberos', 'copilot-tokenizer', 'vscode-policy-watcher')]
            names += [f'node_modules/@github/copilot/sdk/prebuilds/darwin-{cpu}/{m}' for m in
                      ('pty.node', 'keytar.node', 'cli-native.node', 'spawn-helper', 'runtime.node', 'computer.node')]
            for name in names:
                dest = payload / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / name, dest)
        # Include the actual pinned module-format closure for the install hook;
        # retain the bounded real-native-role fixture (not a runtime product).
        for name in ('language-server.js', 'main.js',
                     'node_modules/@github/copilot/package.json',
                     'node_modules/@github/copilot/sdk/index.js',
                     'node_modules/@github/copilot/sdk/index.cjs',
                     'node_modules/@github/copilot/sdk/worker/conoutSocketWorker.js',
                     'node_modules/@github/copilot/sdk/conpty_console_list_agent.js'):
            dest = payload / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, dest)
        text = (ROOT / 'src/cpp/session/CMakeLists.txt').read_text()
        rules = text[text.index('   # install Copilot Language Server'):text.index('   # install embedded packages')]
        for damage in ('none', 'arm64', 'x64'):
            with self.subTest(damage=damage):
                helper = payload / f'node_modules/@github/copilot/sdk/prebuilds/darwin-{damage}/spawn-helper'
                saved_mode = None
                if damage != 'none':
                    saved_mode = helper.stat().st_mode
                    helper.chmod(0o644)
                try:
                    case = EVIDENCE / ('copilot-owner-' + damage)
                    case.mkdir()
                    prefix = case / 'real-role-install'
                    (case / 'CMakeLists.txt').write_text('cmake_minimum_required(VERSION 3.19)\n'
                        'project(CopilotResourceOwner NONE)\nset(APPLE TRUE)\nset(RSTUDIO_ENABLE_COPILOT TRUE)\n'
                        f'set(CMAKE_SOURCE_DIR "{ROOT}")\n'
                        f'include("{ROOT}/package/osx/cmake/arm64-payload.cmake")\n'
                        f'set(RSTUDIO_DEPENDENCIES_COPILOT_DIR "{payload}")\n'
                        'set(RSTUDIO_INSTALL_RESOURCES Resources)\n' + rules)
                    result = run('cmake', '-S', case, '-B', case / 'build', '-DCMAKE_INSTALL_PREFIX=' + str(prefix))
                    output = result.stdout + result.stderr
                    if damage == 'none':
                        self.assertEqual(result.returncode, 0, output)
                        result = run('cmake', '-P', case / 'build/cmake_install.cmake')
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        for cpu in ('arm64', 'x64'):
                            rel = f'node_modules/@github/copilot/sdk/prebuilds/darwin-{cpu}/spawn-helper'
                            installed = prefix / 'Resources/app' / payload.name / rel
                            self.assertEqual(installed.read_bytes(), (payload / rel).read_bytes())
                            self.assertTrue(os.access(installed, os.X_OK))
                    else:
                        self.assertNotEqual(result.returncode, 0, 'nonexecutable helper admitted: ' + damage)
                        self.assertIn('Required native executable invalid', output)
                        self.assertIn('darwin-' + damage + '/spawn-helper', output)
                        self.assertFalse(prefix.exists())
                finally:
                    if saved_mode is not None:
                        helper.chmod(saved_mode)

    def test_pair_policy(self):
        include = f'include("{ROOT}/package/osx/cmake/arm64-payload.cmake")\n'
        arm = WORK / 'native/src/cpp/session/rsession'
        intel = WORK / 'deps/arm64/copilot-language-server-js/bin/darwin/x64/rg'
        fat = WORK / 'deps/arm64/copilot-language-server-js/compiled/darwin/arm64/kerberos.node'
        for path, cpu, ok in [(arm, 'arm64', True), (intel, 'x86_64', True),
                               (arm, 'x86_64', False), (fat, 'arm64;x86_64', True)]:
            result = self.cmake('pair', include + f'rai_require_native("{path}" "{cpu}" TRUE)\n')
            self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        result = self.cmake('pair', include + f'rai_require_native("{arm}" "arm64;x86_64" TRUE)\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('x86_64', result.stdout + result.stderr)

    def test_desktop_target_not_host(self):
        text = (ROOT / 'src/node/desktop/CMakeLists.txt').read_text()
        # Actual owner policy, bounded before copying/configuring sources.
        start = text.index('# Native Node addons')
        stop = text.index('# copy sources to build directory')
        result = self.cmake('desktop', 'set(APPLE TRUE)\nset(UNAME_M arm64)\n'
            'set(CMAKE_HOST_SYSTEM_PROCESSOR arm64)\nset(CMAKE_OSX_ARCHITECTURES x86_64)\n'
            f'set(CMAKE_CURRENT_SOURCE_DIR "{ROOT}/src/node/desktop")\n' + text[start:stop] +
            '\nif(NOT ELECTRON_BINARY_DIR MATCHES "desktop-build-x86_64$")\n'
            'message(FATAL_ERROR "target output incorrectly uses host CPU")\nendif()\n'
            'if(NOT ELECTRON_TARGET_ARCH STREQUAL "x64")\nmessage(FATAL_ERROR "missing target architecture")\nendif()\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_fuses_use_packaged_cpu_not_host(self):
        text = (ROOT / 'src/node/desktop/scripts/install-fuses.mjs').read_text()
        policy = text[text.index('// figure out path'):text.index('// disable potentially insecure')]
        node = WORK / 'source/dependencies/common/node/22.22.2-arm64/bin/node'
        code = "const platform = 'darwin', arch = 'arm64'; process.env.npm_config_arch = 'x64';\n" + policy
        code += "\nif (!exePath.includes('darwin-x64/')) throw new Error('Fuse path uses host instead of packaged CPU');\n"
        result = run(node, '--input-type=module', '-e', code)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_host_node_and_intel_target_runtime(self):
        text = (ROOT / 'src/node/CMakeNodeTools.txt').read_text()
        policy = text[text.index('if(APPLE AND'):text.index('\nif(NODEJS)')]
        host = WORK / 'source/dependencies/common/node/22.22.2-arm64/bin/node'
        result = self.cmake('host-node', 'set(APPLE TRUE)\nset(UNAME_M x86_64)\n'
            'set(CMAKE_HOST_SYSTEM_PROCESSOR arm64)\nset(RSTUDIO_NODE_VERSION 22.22.2)\n'
            f'set(CMAKE_CURRENT_LIST_DIR "{WORK}/source/src/node")\n' + policy +
            f'\nif(NOT NODEJS STREQUAL "{host}")\nmessage(FATAL_ERROR "Target Node selected as host tool: ${{NODEJS}}")\nendif()\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        target = Path(os.environ['RAI_TEST_X64_NODE_DIR'])
        result, dest = old.Packaging().session_install(cpu='x86_64', node_dir=target)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((dest / 'bin/node/bin/node').read_bytes(), (target / 'bin/node').read_bytes())
        self.assertIn('x86_64', run('/usr/bin/lipo', '-archs', dest / 'bin/node/bin/node').stdout)
        result, _ = old.Packaging().session_install(cpu='x86_64',
            node_dir=WORK / 'source/dependencies/common/node/22.22.2-arm64-installed')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('x86_64 slice missing', result.stdout + result.stderr)

    def test_real_electron_inputs_validate_without_merge(self):
        intel = Path(os.environ['RAI_TEST_X64_ELECTRON_APP'])
        arm = WORK / 'source/src/node/desktop-build-arm64/out/RAI-Studio-darwin-arm64/RAI-Studio.app'
        node = WORK / 'source/dependencies/common/node/22.22.2-arm64/bin/node'
        dest = EVIDENCE / 'validation-only-no-app.app'
        result = run(node, ROOT / 'package/osx/scripts/merge-electron.mjs', intel, arm, dest, '--validate-only')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(dest.exists())
        result = run(node, ROOT / 'package/osx/scripts/merge-electron.mjs', intel,
                     EVIDENCE / 'missing-arm.app', dest, '--validate-only')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('arm64 Electron output missing', result.stdout + result.stderr)
        self.assertFalse(dest.exists())

    def test_session_retains_dispatched_resources(self):
        for quarto in (True, False):
            result, dest = old.Packaging().session_install(quarto)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            paths = ['Resources/app/copilot-language-server-js/bin/darwin/x64/rg',
                     'Resources/app/copilot-language-server-js/bin/darwin/arm64/rg']
            paths += (['Resources/app/quarto/bin/tools/x86_64/pandoc', 'Resources/app/quarto/bin/tools/aarch64/pandoc']
                      if quarto else ['bin/pandoc/x86_64/pandoc', 'bin/pandoc/aarch64/pandoc'])
            for name in paths:
                self.assertTrue((dest / name).is_file(), name)

    def test_pandoc_counterpart_and_path_role(self):
        root = EVIDENCE / 'real-pandoc-pair'
        tools = WORK / 'deps/arm64/quarto/bin/tools'
        for cpu in ('aarch64', 'x86_64'):
            (root / cpu).mkdir(parents=True)
            shutil.copy2(tools / cpu / 'pandoc', root / cpu / 'pandoc')
        script = f'include("{ROOT}/package/osx/cmake/arm64-payload.cmake")\nrai_check_pandoc_pair("{root}")\n'
        result = self.cmake('pandoc-pair', script)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        (root / 'x86_64/pandoc').unlink()
        result = self.cmake('pandoc-pair', script)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Required native file invalid', result.stdout + result.stderr)
        shutil.copy2(tools / 'aarch64/pandoc', root / 'x86_64/pandoc')
        result = self.cmake('pandoc-pair', script)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('x86_64 slice missing', result.stdout + result.stderr)

    def test_shared_helper_requires_both_cpus(self):
        # Same-version real Node counterparts exercise Mach-O merge mechanics
        # only; this is not a produced diagnostics/rpostback or native acceptance.
        stage = EVIDENCE / 'real-shared-component-copy'
        stage.mkdir()
        intel = stage / 'node'
        arm = stage / 'node-arm64'
        shutil.copy2(WORK / 'universal-node-inputs-01/node-x86_64', intel)
        shutil.copy2(WORK / 'source/dependencies/common/node/22.22.2-arm64-installed/bin/node', arm)
        result = self.cmake('shared-component', f'include("{ROOT}/package/osx/cmake/arm64-payload.cmake")\n'
            f'rai_merge_native_pair("{stage}" "{intel}" "{arm}")\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(set(run('/usr/bin/lipo', '-archs', intel).stdout.split()), {'arm64', 'x86_64'})

    def test_stage_cannot_alias_producer(self):
        root = EVIDENCE / 'disjoint-stage'
        root.mkdir()
        alias = EVIDENCE / 'producer-alias'
        alias.symlink_to(root)
        result = self.cmake('disjoint', f'include("{ROOT}/package/osx/cmake/arm64-payload.cmake")\n'
            f'rai_require_disjoint("{root}" "{alias}")\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('producer input overlap', result.stdout + result.stderr)

    def test_alternate_owner_preserves_primary(self):
        # CPU/path admission only: real retained native files, not session runtime QA.
        case = EVIDENCE / 'real-native-pair'
        case.mkdir(exist_ok=True)
        primary = case / 'rsession'
        shutil.copy2(WORK / 'universal-node-inputs-01/node-x86_64', primary)
        before = primary.read_bytes()
        arm = WORK / 'native/src/cpp/session/rsession'
        node = WORK / 'source/dependencies/common/node/22.22.2-arm64-installed'
        result = self.cmake('alternate', f'include("{ROOT}/package/osx/cmake/arm64-payload.cmake")\n'
            f'rai_install_arm_alternate("{case}" "{arm}" "{node}")\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(primary.read_bytes(), before)
        self.assertEqual((case / 'rsession-arm64').read_bytes(), arm.read_bytes())
        self.assertEqual((case / 'node-arm64/bin/node').read_bytes(), (node / 'bin/node').read_bytes())

    def test_strict_merge_missing_cpu(self):
        source = WORK / 'source/src/node/desktop-build-arm64/out/RAI-Studio-darwin-arm64/RAI-Studio.app'
        node = WORK / 'source/dependencies/common/node/22.22.2-arm64/bin/node'
        result = run(node, ROOT / 'package/osx/scripts/merge-electron.mjs',
                     EVIDENCE / 'missing-intel.app', source, EVIDENCE / 'never-assembled.app', '--validate-only')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('x86_64 Electron output missing', result.stdout + result.stderr)
        self.assertFalse((EVIDENCE / 'never-assembled.app').exists())

if __name__ == '__main__':
    unittest.main()
