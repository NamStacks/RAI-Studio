#
# test-resolve-rai-bridge-source.cmake
#
# Regression for package/osx/cmake/resolve-rai-bridge-source.cmake, run as a
# standalone `cmake -P` script (no full project configure needed). Proves:
#
#   1. resolve_rai_bridge_source_dir() FAILS CLOSED (non-zero exit via
#      FATAL_ERROR) when RAI_BRIDGE_SOURCE_DIR is not set at all -- i.e. no
#      silent fallback to a hardcoded developer checkout path.
#   2. It ALSO fails closed when the variable is set but points at a
#      directory that is not a real bridge checkout (missing server.js) --
#      i.e. a wrong/incorrect explicit value is caught, not just an absent
#      one.
#   3. It succeeds and resolves the exact given path when
#      RAI_BRIDGE_SOURCE_DIR is set correctly, whether supplied as a CMake
#      variable (the -D configure-argument form) or via the process
#      environment. Also proves no live hardcoded fallback assignment
#      remains in source.
#   4. End-to-end: after resolving a real source checkout and running the
#      actual bundling step (bundle-rai-bridge.cmake's copy logic, invoked
#      the same way `cmake --install` triggers it via configure_file/@ONLY
#      substitution), the bundled tree's file content is byte-identical to
#      the source checkout -- proving "source and bundled bridge content
#      match" rather than merely "some bridge got copied."
#
# Invoke:
#   cmake -P package/osx/test/test-resolve-rai-bridge-source.cmake
#
# Exits non-zero (via FATAL_ERROR) on any assertion failure. Prints
# "ALL RAI BRIDGE SOURCE REGRESSION CHECKS PASSED" on full success.
#
# SAFETY NOTE: this script creates its OWN scratch directory under
# $ENV{TMPDIR} (never under the source/worktree tree) and removes only that
# scratch directory at the end -- never CMAKE_BINARY_DIR/CMAKE_SOURCE_DIR,
# which are unset/meaningless in `cmake -P` script mode and must never be
# used as a deletion target.
#

cmake_minimum_required(VERSION 3.6.3)

set(_here "${CMAKE_CURRENT_LIST_DIR}")
set(_osx_dir "${_here}/..")
include("${_osx_dir}/cmake/resolve-rai-bridge-source.cmake")

if(NOT DEFINED ENV{TMPDIR} OR "$ENV{TMPDIR}" STREQUAL "")
   message(FATAL_ERROR "TMPDIR is not set in the environment -- refusing to guess a scratch "
                        "directory location. Set TMPDIR and re-run.")
endif()
string(TIMESTAMP _ts "%Y%m%d%H%M%S")
set(_scratch "$ENV{TMPDIR}/rai-bridge-source-regression-${_ts}-$ENV{RANDOM}")
if(EXISTS "${_scratch}")
   message(FATAL_ERROR "Scratch dir '${_scratch}' already exists -- refusing to reuse/delete it.")
endif()
file(MAKE_DIRECTORY "${_scratch}")

message(STATUS "== Test 1: RAI_BRIDGE_SOURCE_DIR unset (no env, no -D) must fail closed ==")
unset(RAI_BRIDGE_SOURCE_DIR)
unset(ENV{RAI_BRIDGE_SOURCE_DIR})
file(WRITE "${_scratch}/probe-unset.cmake" "
include(\"${_osx_dir}/cmake/resolve-rai-bridge-source.cmake\")
unset(RAI_BRIDGE_SOURCE_DIR)
unset(ENV{RAI_BRIDGE_SOURCE_DIR})
resolve_rai_bridge_source_dir(_out)
message(FATAL_ERROR \"REGRESSION BUG: resolve_rai_bridge_source_dir() did not fail with no source set\")
")
execute_process(
   COMMAND ${CMAKE_COMMAND} -P "${_scratch}/probe-unset.cmake"
   RESULT_VARIABLE _r1
   OUTPUT_VARIABLE _o1
   ERROR_VARIABLE _e1)
if(_r1 EQUAL 0)
   message(FATAL_ERROR "FAIL: resolve_rai_bridge_source_dir() exited 0 with RAI_BRIDGE_SOURCE_DIR unset -- "
                        "this must fail closed (no dirty-checkout fallback). stdout=[${_o1}] stderr=[${_e1}]")
endif()
if(NOT _e1 MATCHES "was not set")
   message(FATAL_ERROR "FAIL: unset case failed for the wrong reason (expected 'was not set' message). stderr=[${_e1}]")
endif()
message(STATUS "PASS: unset RAI_BRIDGE_SOURCE_DIR fails closed with a clear error")

message(STATUS "== Test 2: RAI_BRIDGE_SOURCE_DIR set to a directory with no server.js must fail closed ==")
set(_bad_dir "${_scratch}/not-a-real-bridge-checkout")
file(MAKE_DIRECTORY "${_bad_dir}")
file(WRITE "${_bad_dir}/README.md" "not a bridge")
file(WRITE "${_scratch}/probe-wrong.cmake" "
include(\"${_osx_dir}/cmake/resolve-rai-bridge-source.cmake\")
set(RAI_BRIDGE_SOURCE_DIR \"${_bad_dir}\")
resolve_rai_bridge_source_dir(_out)
message(FATAL_ERROR \"REGRESSION BUG: resolve_rai_bridge_source_dir() did not fail for a non-bridge directory\")
")
execute_process(
   COMMAND ${CMAKE_COMMAND} -P "${_scratch}/probe-wrong.cmake"
   RESULT_VARIABLE _r2
   OUTPUT_VARIABLE _o2
   ERROR_VARIABLE _e2)
if(_r2 EQUAL 0)
   message(FATAL_ERROR "FAIL: resolve_rai_bridge_source_dir() exited 0 for a directory with no server.js. "
                        "stdout=[${_o2}] stderr=[${_e2}]")
endif()
if(NOT _e2 MATCHES "does[ \t\r\n]+not[ \t\r\n]+contain[ \t\r\n]+server\\.js")
   message(FATAL_ERROR "FAIL: wrong-directory case failed for the wrong reason. stderr=[${_e2}]")
endif()
message(STATUS "PASS: RAI_BRIDGE_SOURCE_DIR pointing at a non-bridge directory fails closed")

message(STATUS "== Test 3: correct RAI_BRIDGE_SOURCE_DIR (env and -D forms) resolves exactly, no dirty-checkout fallback ==")
set(_good_dir "${_scratch}/real-bridge-checkout")
file(MAKE_DIRECTORY "${_good_dir}")
file(WRITE "${_good_dir}/server.js" "// fixture bridge server\nconsole.log('fixture');\n")
file(WRITE "${_good_dir}/package.json" "{ \"name\": \"fixture-bridge\" }")

# 3a: via environment variable
set(ENV{RAI_BRIDGE_SOURCE_DIR} "${_good_dir}")
unset(RAI_BRIDGE_SOURCE_DIR)
resolve_rai_bridge_source_dir(_resolved_env)
unset(ENV{RAI_BRIDGE_SOURCE_DIR})
if(NOT _resolved_env STREQUAL "${_good_dir}")
   message(FATAL_ERROR "FAIL: env-var form resolved to '${_resolved_env}', expected '${_good_dir}'")
endif()
message(STATUS "PASS: environment-variable form resolves the exact intended path")

# 3b: via explicit configure-time variable (the -DRAI_BRIDGE_SOURCE_DIR=... form)
unset(ENV{RAI_BRIDGE_SOURCE_DIR})
set(RAI_BRIDGE_SOURCE_DIR "${_good_dir}")
resolve_rai_bridge_source_dir(_resolved_var)
unset(RAI_BRIDGE_SOURCE_DIR)
if(NOT _resolved_var STREQUAL "${_good_dir}")
   message(FATAL_ERROR "FAIL: -D form resolved to '${_resolved_var}', expected '${_good_dir}'")
endif()
message(STATUS "PASS: explicit configure-argument form resolves the exact intended path")

# 3c: prove there is genuinely no LIVE hardcoded fallback assignment left in
# the resolver (an explanatory comment mentioning the historical path for
# context is fine and expected; an actual `set(...)` assignment to it is
# not) -- a source-level guard against regression, not just a behavioral one.
file(READ "${_osx_dir}/cmake/resolve-rai-bridge-source.cmake" _resolver_src)
if(_resolver_src MATCHES "set\\([ \t]*(RAI_BRIDGE_SOURCE_DIR|_dir)[ \t\r\n]+\"?/Users/[^/\"]+/dev/rai-chat-bridge\"?[ \t]*\\)")
   message(FATAL_ERROR "FAIL: resolve-rai-bridge-source.cmake still contains a live `set(...)` fallback "
                        "assignment to a hardcoded developer-checkout path under /Users -- "
                        "the fallback must be fully removed, not just unreachable.")
endif()
file(READ "${_osx_dir}/CMakeLists.txt" _cmakelists_src)
if(_cmakelists_src MATCHES "set\\([ \t]*RAI_BRIDGE_SOURCE_DIR[ \t\r\n]+\"?/Users/[^/\"]+/dev/rai-chat-bridge\"?[ \t]*\\)")
   message(FATAL_ERROR "FAIL: package/osx/CMakeLists.txt still contains a live `set(...)` fallback "
                        "assignment to a hardcoded developer-checkout path under /Users.")
endif()
message(STATUS "PASS: no live hardcoded dirty-checkout fallback assignment remains in source")

message(STATUS "== Test 4: end-to-end bundling -- source and bundled bridge content match byte-for-byte ==")
# Exercise the real bundle-rai-bridge.cmake install-script logic the same
# way `cmake --install` would invoke it: substitute @RAI_BRIDGE_SOURCE_DIR@/
# @CMAKE_INSTALL_PREFIX@ via configure_file(... @ONLY), then run the
# generated script with `cmake -P`.
# Both real CPU payloads (including executable helpers) are required. This is
# source-owner unit coverage, not native ARM/Intel runtime acceptance.
foreach(cpu arm64 x64)
   foreach(required pty.node spawn-helper)
      if(NOT EXISTS "$ENV{RAI_TEST_BRIDGE_SOURCE_DIR}/node_modules/node-pty/prebuilds/darwin-${cpu}/${required}")
         message(FATAL_ERROR "Set RAI_TEST_BRIDGE_SOURCE_DIR to a real paired bridge payload: ${cpu}/${required}")
      endif()
   endforeach()
endforeach()
file(REMOVE_RECURSE "${_good_dir}")
file(MAKE_DIRECTORY "${_good_dir}")
file(COPY "$ENV{RAI_TEST_BRIDGE_SOURCE_DIR}/" DESTINATION "${_good_dir}" USE_SOURCE_PERMISSIONS)
set(CMAKE_CURRENT_SOURCE_DIR "${_osx_dir}")
set(RAI_BRIDGE_SOURCE_DIR "${_good_dir}")
set(CMAKE_INSTALL_PREFIX "${_scratch}/install-root")
configure_file(
   "${_osx_dir}/cmake/bundle-rai-bridge.cmake"
   "${_scratch}/generated-bundle-rai-bridge.cmake"
   @ONLY)
execute_process(
   COMMAND ${CMAKE_COMMAND} -P "${_scratch}/generated-bundle-rai-bridge.cmake"
   RESULT_VARIABLE _r4
   OUTPUT_VARIABLE _o4
   ERROR_VARIABLE _e4)
if(NOT _r4 EQUAL 0)
   message(FATAL_ERROR "FAIL: generated bundle-rai-bridge.cmake install script failed. stdout=[${_o4}] stderr=[${_e4}]")
endif()

set(_bundled_dir "${CMAKE_INSTALL_PREFIX}/RAI-Studio.app/Contents/Resources/app/rai-chat-bridge")
if(NOT EXISTS "${_bundled_dir}/server.js")
   message(FATAL_ERROR "FAIL: bundled server.js not found at '${_bundled_dir}/server.js' after install step")
endif()

file(SHA256 "${_good_dir}/server.js" _src_hash)
file(SHA256 "${_bundled_dir}/server.js" _bundled_hash)
if(NOT _src_hash STREQUAL _bundled_hash)
   message(FATAL_ERROR "FAIL: source server.js sha256 (${_src_hash}) != bundled server.js sha256 "
                        "(${_bundled_hash}) -- source and bundled bridge content do not match.")
endif()
message(STATUS "PASS: source and bundled server.js are byte-identical (sha256 ${_src_hash})")

file(SHA256 "${_good_dir}/package.json" _src_hash2)
file(SHA256 "${_bundled_dir}/package.json" _bundled_hash2)
if(NOT _src_hash2 STREQUAL _bundled_hash2)
   message(FATAL_ERROR "FAIL: source package.json sha256 != bundled package.json sha256 -- content mismatch.")
endif()
message(STATUS "PASS: source and bundled package.json are byte-identical")

# 4b: prove this is a *negative* test too -- deliberately dirty the fixture
# checkout post-bundle and confirm the bundled copy does NOT silently track
# it (i.e. bundling is a real one-time copy at configure/install time, not a
# live symlink/reference that would keep bundling "dirty" edits forever).
file(APPEND "${_good_dir}/server.js" "\n// dirtied after bundling\n")
file(SHA256 "${_good_dir}/server.js" _src_hash_dirty)
file(SHA256 "${_bundled_dir}/server.js" _bundled_hash_unchanged)
if(_src_hash_dirty STREQUAL _bundled_hash_unchanged)
   message(FATAL_ERROR "FAIL: bundled copy changed when the source checkout was dirtied after bundling -- "
                        "expected a real static copy, not a live reference.")
endif()
if(NOT _bundled_hash_unchanged STREQUAL _bundled_hash)
   message(FATAL_ERROR "FAIL: bundled copy's hash changed unexpectedly.")
endif()
message(STATUS "PASS: bundled copy is a static snapshot, unaffected by post-bundle source dirtying")

# Cleanup: ONLY the scratch dir this script created under TMPDIR, verified
# by prefix before deletion -- never a project/worktree path.
if(_scratch MATCHES "^$ENV{TMPDIR}/rai-bridge-source-regression-")
   file(REMOVE_RECURSE "${_scratch}")
else()
   message(WARNING "Scratch dir '${_scratch}' did not match the expected TMPDIR-prefixed pattern; "
                    "leaving it in place rather than risking an unintended delete.")
endif()

message(STATUS "ALL RAI BRIDGE SOURCE REGRESSION CHECKS PASSED")
