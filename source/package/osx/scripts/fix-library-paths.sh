#!/usr/bin/env bash

#
# fix-library-paths.sh
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

if [ "$#" = "0" ]; then
   echo "Usage: $0 [frameworks directory] [prefix] [files]"
   exit 0
fi

# The FILES argument can be a glob, e.g. '*.dylib', which may not exist
# for local package builds (which might only have build components
# for the current architecture).
set -euo pipefail
shopt -s nullglob

DIR="$1"
PREFIX="$2"
FILES="$3"

cd "$DIR"
for FILE in ${FILES}; do

   install_name_tool -id "${FILE}" "${FILE}"

   # Probe separately so filtering cannot hide an otool failure. An empty
   # non-system dependency list is valid, not a grep-error special case.
   LIBRARY_INFO=$(otool -l "${FILE}")
   # Read dependency commands only: LC_ID_DYLIB is not a load edge.
   # Deduplicate fat-image edges before invoking install_name_tool.
   LIBPATHS=$(printf '%s\n' "${LIBRARY_INFO}" | awk '
      $1 == "cmd" { load = ($2 ~ /^LC_(LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB|LAZY_LOAD_DYLIB)$/) }
      load && $1 == "name" {
         sub(/^[[:space:]]+name /, "")
         sub(/ \(offset [0-9]+\)$/, "")
         if (($0 ~ /^@rpath\// || ($0 ~ /^\// && $0 !~ /^\/(usr\/lib|System\/Library)\//)) && !seen[$0]++)
            print
      }
   ')

   while IFS= read -r LIBPATH; do
      [ -n "${LIBPATH}" ] || continue
      OLD="${LIBPATH}"
      NEW="${PREFIX}/$(basename "${OLD}")"
      install_name_tool -change "${OLD}" "${NEW}" "${FILE}"
   done <<< "${LIBPATHS}"

done
