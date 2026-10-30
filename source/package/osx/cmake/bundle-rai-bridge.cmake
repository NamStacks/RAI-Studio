#
# bundle-rai-bridge.cmake
#
# Copies the rai-chat-bridge checkout (the standalone Node server that backs
# the RAI Assistant pane) into the packaged app so the DMG is self-contained
# on a machine that never had that checkout -- see
# SessionRaiAssistant.cpp's resolveBridgeDir(), which looks here first.
#

cmake_minimum_required(VERSION 3.6.3)

# CMake's message is suppressed during install stage so just use echo here
function(echo MESSAGE)
   execute_process(COMMAND echo "-- ${MESSAGE}")
endfunction()

set(RAI_BRIDGE_SOURCE_DIR "@RAI_BRIDGE_SOURCE_DIR@")
set(RAI_BRIDGE_DEST_DIR "@CMAKE_INSTALL_PREFIX@/RAI-Studio.app/Contents/Resources/app/rai-chat-bridge")

if(NOT EXISTS "${RAI_BRIDGE_SOURCE_DIR}/server.js")
   message(FATAL_ERROR "RAI bridge server.js not found at '${RAI_BRIDGE_SOURCE_DIR}'; refusing to package an app without its Assistant bridge")
endif()

# CMake COPY preserves symlinks and silently omits absent dependency trees.
# Both yield an app that can pass installation yet cannot launch the bridge.
if(IS_SYMLINK "${RAI_BRIDGE_SOURCE_DIR}/node_modules")
   message(FATAL_ERROR "RAI bridge node_modules is a symlink; run npm ci in the isolated bridge checkout before packaging")
endif()
if(NOT IS_DIRECTORY "${RAI_BRIDGE_SOURCE_DIR}/node_modules")
   message(FATAL_ERROR "RAI bridge node_modules is missing; run npm ci in the isolated bridge checkout before packaging")
endif()

include("@CMAKE_CURRENT_SOURCE_DIR@/cmake/arm64-payload.cmake")
rai_check_payload_links("${RAI_BRIDGE_SOURCE_DIR}")
rai_require_disjoint("${RAI_BRIDGE_DEST_DIR}" "${RAI_BRIDGE_SOURCE_DIR}")
foreach(cpu arm64 x86_64)
   set(ptyArch "${cpu}")
   if(cpu STREQUAL "x86_64")
      set(ptyArch x64)
   endif()
   foreach(required pty.node spawn-helper)
      set(payload "${RAI_BRIDGE_SOURCE_DIR}/node_modules/node-pty/prebuilds/darwin-${ptyArch}/${required}")
      if(NOT EXISTS "${payload}")
         message(FATAL_ERROR "RAI bridge ${cpu} PTY payload missing: ${required}")
      endif()
      set(executable FALSE)
      if(required STREQUAL "spawn-helper")
         set(executable TRUE)
      endif()
      rai_require_native("${payload}" "${cpu}" "${executable}")
   endforeach()
endforeach()
rai_native_payload("${RAI_BRIDGE_SOURCE_DIR}" dispatched)
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
rai_native_payload("${RAI_BRIDGE_DEST_DIR}" dispatched)
