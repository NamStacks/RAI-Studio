#
# CMakeLists.txt
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

# Defensive post-project assertion; the root owns pre-toolchain admission/defaults.
if(APPLE)
   if(NOT CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64|x86_64)$"
      OR (RSESSION_ALTERNATE_BUILD AND NOT CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
      OR (RSTUDIO_PACKAGE_BUILD AND NOT RSESSION_ALTERNATE_BUILD AND NOT CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64"))
      message(FATAL_ERROR "macOS release requires x86_64 primary and arm64 alternate")
   endif()
endif()

if(POLICY CMP0077)
   cmake_policy(SET CMP0077 NEW)
endif()

# define package suffix
set(RSTUDIO_PACKAGE_SUFFIX "-")

# include overlay if it exists
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/CMakeOverlay.txt")
   include(CMakeOverlay.txt)
endif()

# Release inputs are explicit outputs of independent source-bound builds.
set(RSESSION_ARM64_PATH "" CACHE FILEPATH "Fresh ARM64 alternate session")
set(RAI_DIAGNOSTICS_ARM64_PATH "" CACHE FILEPATH "Fresh ARM64 shared diagnostics input")
set(RAI_RPOSTBACK_ARM64_PATH "" CACHE FILEPATH "Fresh ARM64 shared rpostback input")
set(RAI_NODE_ARM64_DIR "" CACHE PATH "Pinned ARM64 installed Node")
set(RAI_PACKAGE_LIBRARY_PREFIX "" CACHE PATH "Pinned x86_64 library prefix")
set(RAI_PACKAGE_LIBRARY_ARM64_PREFIX "" CACHE PATH "Pinned ARM64 library prefix")
set(RAI_ELECTRON_X86_64_APP "" CACHE PATH "Fresh x86_64 Electron app")
set(RAI_ELECTRON_ARM64_APP "" CACHE PATH "Fresh ARM64 Electron app")

# developer-id code signing
if(RSTUDIO_PACKAGE_BUILD AND NOT RSESSION_ALTERNATE_BUILD)

   configure_and_install("cmake/merge-electron.cmake")
   configure_and_install("cmake/prepare-package.cmake")

   # location of the rai-chat-bridge checkout to bundle into the app; see
   # SessionRaiAssistant.cpp's resolveBridgeDir(). Must be set explicitly at
   # configure time, either as -DRAI_BRIDGE_SOURCE_DIR=<path> or as the
   # RAI_BRIDGE_SOURCE_DIR environment variable -- there is intentionally NO
   # dev-machine default here. A prior build silently fell back to an
   # unrelated, dirty checkout when this was left unset, bundling the wrong
   # bridge into a release artifact with no error and no indication in the
   # build log. resolve_rai_bridge_source_dir() fails the configure outright
   # (FATAL_ERROR) if the variable is absent or does not point at a real
   # bridge checkout; see cmake/resolve-rai-bridge-source.cmake and
   # package/osx/test/test-resolve-rai-bridge-source.cmake.
   include("cmake/resolve-rai-bridge-source.cmake")
   resolve_rai_bridge_source_dir(RAI_BRIDGE_SOURCE_DIR)
   configure_and_install("cmake/bundle-rai-bridge.cmake")
   # Optional provenance-pinned replacement; original Quarto payload remains
   # unchanged unless an explicitly qualified arm64/macOS12 binary is supplied.
   configure_and_install("cmake/bundle-pinned-pandoc.cmake")

   configure_and_install("cmake/codesign-package.cmake")

endif()

# package attributes
set(CPACK_PACKAGE_FILE_NAME "${CPACK_PACKAGE_NAME}${RSTUDIO_PACKAGE_SUFFIX}${CPACK_PACKAGE_VERSION}")
string(REPLACE "+" "-" CPACK_PACKAGE_FILE_NAME "${CPACK_PACKAGE_FILE_NAME}")

# create drag and drop installer
set(CPACK_BINARY_DRAGNDROP ON)

include(CPack)
