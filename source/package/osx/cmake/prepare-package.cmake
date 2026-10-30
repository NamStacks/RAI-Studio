#
# prepare-package.cmake
#
# Copyright (C) 2022 by Posit Software, PBC
#
# Unless you have received this program directly from Posit Software pursuant
# to the terms of a commercial license agreement with Posit Software, then
# this program is licensed to you under the terms of version 3 of the
# GNU Affero General Public License. This program is distributed WITHOUT
# ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
# MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
# AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
#
#

# Universal packaging: Intel primary + ARM alternate, staged-only relocation.
cmake_minimum_required(VERSION 3.6.3)
include("@CMAKE_CURRENT_SOURCE_DIR@/cmake/arm64-payload.cmake")
if(NOT "@CMAKE_OSX_ARCHITECTURES@" STREQUAL "x86_64")
   message(FATAL_ERROR "Universal package install requires x86_64 primary")
endif()
set(APP_ROOT "${CMAKE_INSTALL_PREFIX}/RAI-Studio.app")
set(RSESSION_BINARY_DIR "${APP_ROOT}/Contents/Resources/app/bin")
set(X64_FRAMEWORKS_DIRECTORY "${APP_ROOT}/Contents/Resources/app/Frameworks")
set(ARM64_FRAMEWORKS_DIRECTORY "${X64_FRAMEWORKS_DIRECTORY}/arm64")
set(FIX_LIBRARY_PATHS_SCRIPT_PATH "@CMAKE_CURRENT_SOURCE_DIR@/scripts/fix-library-paths.sh")
set(primaryPrefix "@RAI_PACKAGE_LIBRARY_PREFIX@")
set(armPrefix "@RAI_PACKAGE_LIBRARY_ARM64_PREFIX@")
set(armSession "@RSESSION_ARM64_PATH@")
set(armNode "@RAI_NODE_ARM64_DIR@")
set(armDiagnostics "@RAI_DIAGNOSTICS_ARM64_PATH@")
set(armPostback "@RAI_RPOSTBACK_ARM64_PATH@")

# Admit every input before copying or relocating. No mutable Homebrew fallback.
rai_check_payload_links("${APP_ROOT}")
foreach(input "${primaryPrefix}" "${armPrefix}" "${armSession}" "${armNode}" "${armDiagnostics}" "${armPostback}")
   rai_require_disjoint("${APP_ROOT}" "${input}")
endforeach()
foreach(prefix "${primaryPrefix}" "${armPrefix}")
   if(NOT IS_ABSOLUTE "${prefix}")
      message(FATAL_ERROR "Explicit pinned library prefixes required")
   endif()
   rai_check_payload_links("${prefix}/lib")
endforeach()
get_filename_component(primaryReal "${primaryPrefix}" REALPATH)
get_filename_component(armReal "${armPrefix}" REALPATH)
if(primaryReal STREQUAL armReal)
   message(FATAL_ERROR "Distinct x86_64 and arm64 library prefixes required")
endif()
foreach(required diagnostics rpostback rsession node/bin/node)
   rai_require_native("${RSESSION_BINARY_DIR}/${required}" x86_64 TRUE)
endforeach()
rai_require_native("${armSession}" arm64 TRUE)
rai_require_native("${armDiagnostics}" arm64 TRUE)
rai_require_native("${armPostback}" arm64 TRUE)
rai_check_payload_links("${armNode}")
rai_require_native("${armNode}/bin/node" arm64 TRUE)
rai_native_payload("${armNode}" arm64)

function(checkLibraries prefix cpu)
   foreach(required libssl.3.dylib libcrypto.3.dylib libintl.8.dylib libsqlite3.0.dylib)
      get_filename_component(library "${prefix}/lib/${required}" REALPATH)
      rai_require_native("${library}" "${cpu}" FALSE)
   endforeach()
   rai_native_payload("${prefix}/lib" "${cpu}")
endfunction()
checkLibraries("${primaryPrefix}" x86_64)
checkLibraries("${armPrefix}" arm64)

function(copyPackageLibraries destination prefix cpu)
   file(MAKE_DIRECTORY "${destination}")
   file(GLOB libraries "${prefix}/lib/*.dylib")
   file(COPY ${libraries} DESTINATION "${destination}" USE_SOURCE_PERMISSIONS)
   rai_native_payload("${destination}" "${cpu}")
endfunction()
function(relocate directory framework pattern)
   execute_process(COMMAND "${FIX_LIBRARY_PATHS_SCRIPT_PATH}" "${directory}" "${framework}" "${pattern}"
      RESULT_VARIABLE result)
   if(NOT result STREQUAL "0")
      message(FATAL_ERROR "Package library relocation failed: ${result}")
   endif()
endfunction()

copyPackageLibraries("${X64_FRAMEWORKS_DIRECTORY}" "${primaryPrefix}" x86_64)
relocate("${X64_FRAMEWORKS_DIRECTORY}" "@loader_path" "*.dylib")
relocate("${RSESSION_BINARY_DIR}" "@loader_path/../Frameworks" "diagnostics rpostback rsession")
# This owner never copies the primary session over the ARM alternate.
rai_install_arm_alternate("${RSESSION_BINARY_DIR}" "${armSession}" "${armNode}")
copyPackageLibraries("${ARM64_FRAMEWORKS_DIRECTORY}" "${armPrefix}" arm64)
relocate("${ARM64_FRAMEWORKS_DIRECTORY}" "@loader_path" "*.dylib")
relocate("${RSESSION_BINARY_DIR}" "@loader_path/../Frameworks/arm64" "rsession-arm64")
# Unsuffixed shared helpers have no CPU-dispatch name. Relocate their ARM
# copies separately before lipo so each slice retains its own library prefix.
set(sharedStage "${RSESSION_BINARY_DIR}/.rai-arm64-shared")
if(EXISTS "${sharedStage}")
   message(FATAL_ERROR "Shared helper staging already exists; require a fresh stage")
endif()
file(MAKE_DIRECTORY "${sharedStage}")
configure_file("${armDiagnostics}" "${sharedStage}/diagnostics" COPYONLY)
configure_file("${armPostback}" "${sharedStage}/rpostback" COPYONLY)
relocate("${sharedStage}" "@loader_path/../Frameworks/arm64" "diagnostics rpostback")
foreach(helper diagnostics rpostback)
   rai_merge_native_pair("${APP_ROOT}" "${RSESSION_BINARY_DIR}/${helper}" "${sharedStage}/${helper}")
endforeach()
file(REMOVE_RECURSE "${sharedStage}")
if(NOT "@LICENSEMANAGER_ARM64_PATH@" STREQUAL "")
   rai_require_native("@LICENSEMANAGER_ARM64_PATH@" arm64 TRUE)
   configure_file("@LICENSEMANAGER_ARM64_PATH@" "${RSESSION_BINARY_DIR}/license-manager-arm64" COPYONLY)
   relocate("${RSESSION_BINARY_DIR}" "@loader_path/../Frameworks/arm64" "license-manager-arm64")
endif()
rai_require_native("${RSESSION_BINARY_DIR}/rsession" x86_64 TRUE)
rai_require_native("${RSESSION_BINARY_DIR}/rsession-arm64" arm64 TRUE)
rai_require_native("${RSESSION_BINARY_DIR}/node/bin/node" x86_64 TRUE)
rai_require_native("${RSESSION_BINARY_DIR}/node-arm64/bin/node" arm64 TRUE)
rai_check_payload_links("${APP_ROOT}")
