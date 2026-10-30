#
# merge-electron.cmake
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

# CMake's message is suppressed during install stage so just use echo here
function(echo MESSAGE)
   execute_process(COMMAND echo "-- ${MESSAGE}")
endfunction()

# Both explicitly admitted fresh producer outputs are mandatory. Never discover
# old apps by existence/version or provision dependencies during installation.
foreach(input "@RAI_ELECTRON_X86_64_APP@" "@RAI_ELECTRON_ARM64_APP@")
   if(NOT IS_ABSOLUTE "${input}" OR NOT IS_DIRECTORY "${input}" OR IS_SYMLINK "${input}")
      message(FATAL_ERROR "Universal Electron input missing or invalid: ${input}")
   endif()
endforeach()
execute_process(
   COMMAND "@NODEJS@" "@CMAKE_CURRENT_SOURCE_DIR@/scripts/merge-electron.mjs"
           "@RAI_ELECTRON_X86_64_APP@" "@RAI_ELECTRON_ARM64_APP@"
           "${CMAKE_INSTALL_PREFIX}/RAI-Studio.app"
   RESULT_VARIABLE result)
if(NOT result STREQUAL "0")
   message(FATAL_ERROR "Universal Electron merge failed: ${result}")
endif()

