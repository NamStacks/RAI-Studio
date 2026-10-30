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

cmake_minimum_required(VERSION 3.6.3)

# Admit macOS targets before init (source writes) and project/toolchain setup.
# APPLE is not initialized here: use native Darwin or explicit Darwin cross intent.
# An explicit non-Darwin cross target must retain its existing platform behavior.
if(CMAKE_SYSTEM_NAME STREQUAL "Darwin"
   OR (NOT CMAKE_SYSTEM_NAME AND CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin"))
   if(NOT CMAKE_OSX_ARCHITECTURES)
      if(CMAKE_SYSTEM_PROCESSOR)
         set(CMAKE_OSX_ARCHITECTURES "${CMAKE_SYSTEM_PROCESSOR}" CACHE STRING "macOS target architecture" FORCE)
      elseif(CMAKE_HOST_SYSTEM_PROCESSOR)
         set(CMAKE_OSX_ARCHITECTURES "${CMAKE_HOST_SYSTEM_PROCESSOR}" CACHE STRING "macOS target architecture" FORCE)
      else()
         # CMake has not initialized the host processor before project().
         # Query only the native host; never initialize a compiler before admission.
         execute_process(COMMAND /usr/bin/uname -m
            OUTPUT_VARIABLE _RAI_NATIVE_HOST_PROCESSOR OUTPUT_STRIP_TRAILING_WHITESPACE
            RESULT_VARIABLE _RAI_HOST_QUERY_RESULT TIMEOUT 5)
         if(NOT _RAI_HOST_QUERY_RESULT STREQUAL "0")
            message(FATAL_ERROR "Cannot determine native macOS host architecture")
         endif()
         set(CMAKE_OSX_ARCHITECTURES "${_RAI_NATIVE_HOST_PROCESSOR}" CACHE STRING "macOS target architecture" FORCE)
         unset(_RAI_NATIVE_HOST_PROCESSOR)
         unset(_RAI_HOST_QUERY_RESULT)
      endif()
   endif()
   if(NOT CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64|x86_64)$"
      OR (RSESSION_ALTERNATE_BUILD AND NOT CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
      OR (RSTUDIO_PACKAGE_BUILD AND NOT RSESSION_ALTERNATE_BUILD AND NOT CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64"))
      message(FATAL_ERROR "macOS requires one arm64 or x86_64 target per build; release requires x86_64 primary and arm64 alternate")
   endif()
endif()

# initialize
include(cmake/init.cmake)

# release name
include(cmake/release.cmake)

# project name
project("RStudio [${RSTUDIO_RELEASE_NAME}]" CXX)

# set compiler
include(cmake/compiler.cmake)

# project globals
include(cmake/globals.cmake)

# remove previous installation if requested
if(RSTUDIO_UNINSTALL_PREVIOUS)
  install(CODE "execute_process(COMMAND rm -rf \${CMAKE_INSTALL_PREFIX})")
endif()

# install root docs
if (NOT RSTUDIO_SESSION_WIN32)
   # dynamically configure SOURCE with the git revision hash
   INSTALL(CODE "
      execute_process(COMMAND git rev-parse HEAD
                      WORKING_DIRECTORY \"${CMAKE_CURRENT_SOURCE_DIR}\"
                      OUTPUT_VARIABLE RSTUDIO_GIT_REVISION_HASH)
      configure_file (\"${CMAKE_CURRENT_SOURCE_DIR}/SOURCE.in\"
                      \"${CMAKE_CURRENT_BINARY_DIR}/SOURCE\")
   ")

   configure_file(${CMAKE_CURRENT_SOURCE_DIR}/VERSION.in
                  ${CMAKE_CURRENT_BINARY_DIR}/VERSION)

   # install root docs
   include(cmake/install-docs.cmake)
endif()

# overlay
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/CMakeOverlay.txt")
   include(CMakeOverlay.txt)
endif()

# main src
add_subdirectory(src)

# packaging
add_subdirectory(package)

