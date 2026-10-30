#!/usr/bin/env python3
"""Real Mach-O relocation unit fixtures; never execute Intel or product code."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(sys.argv.pop(1)).resolve()
OUT.mkdir(parents=True, exist_ok=True)
TOOLS = Path('/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin')
SDK = '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk'


def run(*argv):
    p = subprocess.run(list(map(str, argv)), capture_output=True)
    with (OUT / 'commands.jsonl').open('a') as f:
        f.write(json.dumps({'argv': p.args, 'exit': p.returncode,
                            'stdout': p.stdout.decode('utf8', 'backslashreplace'),
                            'stderr': p.stderr.decode('utf8', 'backslashreplace')}) + '\n')
    if p.returncode:
        raise AssertionError((p.args, p.returncode, p.stderr))
    return p.stdout.decode()


def commands(p):
    text = run('/usr/bin/otool', '-l', p)
    return [(m[1], m[2]) for b in re.split(r'Load command \d+\n', text)[1:]
            if (m := re.search(r'cmd (LC_\w+).*?\n\s+(?:name|path) (.+?) \(offset', b, re.S))]


class Relocation(unittest.TestCase):
    def test_absolute_weak_reexport_id_and_noop_controls(self):
        for cpu in ['arm64', 'x86_64']:
            with self.subTest(cpu=cpu):
                d = OUT / ('controls-' + cpu)
                d.mkdir()
                (d / 'unit.c').write_text('int unit(void) { return 42; }\n')
                cc = [TOOLS / 'clang', '-arch', cpu, '-isysroot', SDK,
                      '-mmacosx-version-min=12.0', '-Wl,-headerpad_max_install_names']
                lib = d / 'libabsolute.dylib'
                run(*cc, '-dynamiclib', d / 'unit.c', '-Wl,-install_name,' + str(lib), '-o', lib)
                weak = d / 'libweak.dylib'
                run(*cc, '-dynamiclib', d / 'unit.c', '-Wl,-weak_library,' + str(lib), '-o', weak)
                reexport = d / 'libreexport.dylib'
                run(*cc, '-dynamiclib', d / 'unit.c', '-Wl,-reexport_library,' + str(lib), '-o', reexport)
                self.assertIn(('LC_LOAD_WEAK_DYLIB', str(lib)), commands(weak))
                self.assertIn(('LC_REEXPORT_DYLIB', str(lib)), commands(reexport))
                for p, command in [(weak, 'LC_LOAD_WEAK_DYLIB'), (reexport, 'LC_REEXPORT_DYLIB')]:
                    run(ROOT / 'package/osx/scripts/fix-library-paths.sh', d, '@loader_path', p.name)
                    self.assertIn((command, '@loader_path/libabsolute.dylib'), commands(p))
                # An image's own producer ID is deliberately not a dependency.
                run('/usr/bin/install_name_tool', '-id', '@rpath/not-a-load.dylib', lib)
                run(ROOT / 'package/osx/scripts/fix-library-paths.sh', d, '@loader_path', lib.name)
                parsed = commands(lib)
                self.assertIn(('LC_ID_DYLIB', lib.name), parsed)
                self.assertFalse(any(c.startswith('LC_LOAD') and 'not-a-load' in v for c, v in parsed))
                before = parsed
                run(ROOT / 'package/osx/scripts/fix-library-paths.sh', d, '@loader_path', lib.name)
                self.assertEqual(before, commands(lib))
        fat = OUT / 'fat'
        fat.mkdir()
        run('/usr/bin/lipo', '-create', OUT / 'controls-arm64/libweak.dylib',
            OUT / 'controls-x86_64/libweak.dylib', '-output', fat / 'libweak.dylib')
        # Already relative edges and duplicate fat-image imports are a no-op.
        before = commands(fat / 'libweak.dylib')
        run(ROOT / 'package/osx/scripts/fix-library-paths.sh', fat, '@loader_path', '*.dylib')
        self.assertEqual(before, commands(fat / 'libweak.dylib'))

    def test_both_cpu_load_edges_close_without_producer_search(self):
        for cpu in ['arm64', 'x86_64']:
            with self.subTest(cpu=cpu):
                d = OUT / cpu
                d.mkdir()
                (d / 'unit.c').write_text('int unit(void) { return 42; }\n')
                (d / 'main.c').write_text('extern int unit(void); int main(void) { return unit(); }\n')
                cc = [TOOLS / 'clang', '-arch', cpu, '-isysroot', SDK,
                      '-mmacosx-version-min=12.0', '-Wl,-headerpad_max_install_names']
                fw = d / 'Frameworks' / ('arm64' if cpu == 'arm64' else '')
                fw.mkdir(parents=True)
                lib = fw / 'libunit.dylib'
                run(*cc, '-dynamiclib', d / 'unit.c', '-Wl,-install_name,@rpath/libunit.dylib', '-o', lib)
                binary = d / 'bin' / 'unit'
                binary.parent.mkdir()
                run(*cc, d / 'main.c', lib, '-Wl,-rpath,' + str(d / 'private-producer'), '-o', binary)
                prefix = '@loader_path/../Frameworks' + ('/arm64' if cpu == 'arm64' else '')
                run(ROOT / 'package/osx/scripts/fix-library-paths.sh', binary.parent, prefix, 'unit')
                loads = [v for c, v in commands(binary) if c in
                         ['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB']]
                self.assertIn(prefix + '/libunit.dylib', loads)
                self.assertNotIn('@rpath/libunit.dylib', loads)
                target = (binary.parent / (prefix + '/libunit.dylib').replace('@loader_path/', '')).resolve()
                self.assertEqual(target, lib.resolve())
                self.assertEqual(run('/usr/bin/lipo', '-archs', target).strip(), cpu)
                self.assertTrue(any(v.startswith('/usr/lib/') for v in loads))
                before = commands(binary)
                run(ROOT / 'package/osx/scripts/fix-library-paths.sh', binary.parent, prefix, 'unit')
                self.assertEqual(before, commands(binary))


if __name__ == '__main__':
    unittest.main()
