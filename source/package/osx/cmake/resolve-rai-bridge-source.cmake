#
# resolve-rai-bridge-source.cmake
#
# Resolves the rai-chat-bridge checkout to bundle into a release package
# build. Fails closed (FATAL_ERROR) rather than silently defaulting to a
# hardcoded developer checkout path -- a prior build silently fell back to
# an unrelated, dirty developer checkout when RAI_BRIDGE_SOURCE_DIR was left
# unset at configure time, producing an installed app whose bundled RAI
# Assistant bridge did not match the intended source commit even though the
# build exited 0. See package/osx/test/test-resolve-rai-bridge-source.cmake
# for the regression proving this fails closed, and package/osx/CMakeLists.txt
# for the call site.
#
# Accepts either form, checked in this order (first one set wins):
#   1. -DRAI_BRIDGE_SOURCE_DIR=<path>   (explicit CMake configure argument)
#   2. RAI_BRIDGE_SOURCE_DIR=<path> in the configure-time environment
#
# There is NO other fallback. If neither is set, or the resolved path does
# not contain a real bridge checkout (server.js), configure fails outright.
#

cmake_minimum_required(VERSION 3.6.3)

function(resolve_rai_bridge_source_dir OUT_VAR)
   # Prefer an explicit -D argument (a normal/cache variable named the same
   # as the env var) over the environment, but require exactly one clean
   # source of truth per invocation -- do not silently merge/prefer one
   # over the other without saying so.
   set(_dir "")
   set(_origin "")

   if(DEFINED RAI_BRIDGE_SOURCE_DIR AND NOT "${RAI_BRIDGE_SOURCE_DIR}" STREQUAL "")
      set(_dir "${RAI_BRIDGE_SOURCE_DIR}")
      set(_origin "-DRAI_BRIDGE_SOURCE_DIR configure argument")
   elseif(NOT "$ENV{RAI_BRIDGE_SOURCE_DIR}" STREQUAL "")
      set(_dir "$ENV{RAI_BRIDGE_SOURCE_DIR}")
      set(_origin "RAI_BRIDGE_SOURCE_DIR environment variable")
   endif()

   if(_dir STREQUAL "")
      message(FATAL_ERROR
         "RAI_BRIDGE_SOURCE_DIR was not set (neither as -DRAI_BRIDGE_SOURCE_DIR=<path> "
         "nor as an environment variable) at CMake configure time. A release/package "
         "build must explicitly name the rai-chat-bridge checkout to bundle -- there is "
         "no default fallback. (A prior build silently bundled an unrelated, dirty "
         "developer checkout this way; see package/osx/test/test-resolve-rai-bridge-source.cmake.) "
         "Re-run configure with -DRAI_BRIDGE_SOURCE_DIR=<path-to-rai-chat-bridge-checkout>.")
   endif()

   if(NOT EXISTS "${_dir}/server.js")
      message(FATAL_ERROR
         "RAI_BRIDGE_SOURCE_DIR resolved to '${_dir}' (from ${_origin}) but that "
         "directory does not contain server.js -- refusing to bundle a missing or "
         "incorrect rai-chat-bridge checkout. Fix the path and re-run configure; "
         "there is no fallback.")
   endif()

   message(STATUS "Bundling rai-chat-bridge from '${_dir}' (resolved via ${_origin})")
   set(${OUT_VAR} "${_dir}" PARENT_SCOPE)
endfunction()
