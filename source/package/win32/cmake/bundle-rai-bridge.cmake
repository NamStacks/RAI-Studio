#
# bundle-rai-bridge.cmake
#
# Copies the rai-chat-bridge checkout (the standalone Node server that backs
# the RAI Assistant pane) into the packaged app so the installer is
# self-contained on a machine that never had that checkout -- see
# SessionRaiAssistant.cpp's resolveBridgeDir(), which looks here first.
#
# Windows counterpart of package/osx/cmake/bundle-rai-bridge.cmake. The
# destination mirrors resolveBridgeDir()'s Windows walk: nodePath resolves to
# .../resources/app/bin/<node-dir>/bin/node.exe (or similar), so four levels
# up from that is the "app" resource root -- the same
# RSTUDIO_INSTALL_SUPPORTING (resources/app) used by the rest of the Electron
# install, which is why the destination below is relative to
# CMAKE_INSTALL_PREFIX/resources/app rather than a macOS-style .app bundle.
#

cmake_minimum_required(VERSION 3.6.3)

# CMake's message() honors -Wno-error but is otherwise silent/buffered during
# the install stage; execute_process(COMMAND echo ...) depends on a shell
# builtin actually named "echo" being resolvable as a COMMAND, which does not
# reliably exist as an executable on Windows and fails silently (non-fatal,
# so both the success and warning branches below can vanish without trace).
# ${CMAKE_COMMAND} -E echo is the portable, always-available equivalent.
function(echo MESSAGE)
   execute_process(COMMAND "${CMAKE_COMMAND}" -E echo "-- ${MESSAGE}")
endfunction()

set(RAI_BRIDGE_SOURCE_DIR "@RAI_BRIDGE_SOURCE_DIR@")
# NOTE: deliberately ${CMAKE_INSTALL_PREFIX}, NOT @CMAKE_INSTALL_PREFIX@.
# configure_and_install() runs configure_file(... @ONLY), which only expands
# @VAR@ placeholders and leaves ${VAR} untouched -- so @CMAKE_INSTALL_PREFIX@
# would bake in the CONFIGURE-time value (CMake's Windows default,
# "C:/Program Files/RStudio [...]", since make-package.bat never passes
# -DCMAKE_INSTALL_PREFIX) into this generated script. But Windows packages
# via `cpack -G NSIS` (make-dist-packages.bat), which re-invokes install()
# with CMAKE_INSTALL_PREFIX pointed at CPack's own staging tree at INSTALL
# time -- a different, later value. ${CMAKE_INSTALL_PREFIX} here is a normal
# CMake variable reference left alone by @ONLY, so it re-evaluates against
# that install-time value when this script actually runs, landing the bridge
# inside the CPack staging tree (and therefore inside the final .exe/.zip)
# instead of silently writing to an unrelated directory outside it -- macOS
# never hit this because package/osx/make-package invokes `--target install`
# directly into the configure-time prefix, so the two values coincide there.
set(RAI_BRIDGE_DEST_DIR "${CMAKE_INSTALL_PREFIX}/resources/app/rai-chat-bridge")

if(EXISTS "${RAI_BRIDGE_SOURCE_DIR}/server.js")

   echo("Bundling rai-chat-bridge from '${RAI_BRIDGE_SOURCE_DIR}'")

   file(REMOVE_RECURSE "${RAI_BRIDGE_DEST_DIR}")
   file(
      COPY "${RAI_BRIDGE_SOURCE_DIR}/"
      DESTINATION "${RAI_BRIDGE_DEST_DIR}"
      USE_SOURCE_PERMISSIONS
      PATTERN ".git" EXCLUDE
      PATTERN "test" EXCLUDE
      PATTERN "*.log" EXCLUDE
      PATTERN ".DS_Store" EXCLUDE)

else()

   # package/win32/CMakeLists.txt only invokes this script at all when
   # RAI_BRIDGE_SOURCE_DIR is non-empty (RSTUDIO_PACKAGE_BUILD AND
   # RAI_BRIDGE_SOURCE_DIR) -- so getting here means the caller deliberately
   # asked for a bridge to be bundled and it wasn't found: a broken checkout
   # or wrong path, not an expected "no bridge available" fallback. Fail the
   # build instead of silently shipping a package with no RAI Assistant.
   message(FATAL_ERROR
      "rai-chat-bridge not found at '${RAI_BRIDGE_SOURCE_DIR}/server.js' -- "
      "RAI_BRIDGE_SOURCE_DIR was set, so a bundled bridge was expected.")

endif()
