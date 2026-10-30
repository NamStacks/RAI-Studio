#!/usr/bin/env bash
# Before a copy-only package, require the GWT output at the install script's
# configured path. A fresh CMake cache can remove it even after an earlier build.
require_gwt_copy_output() {
   local build_gwt="$1" copy_gwt="$2" build_dir="$3" clean="${4:-0}"
   if [ "$build_gwt" = "0" ] && [ "$copy_gwt" = "1" ] &&
      { [ "$clean" = "1" ] || [ ! -d "$build_dir/gwt/www" ]; }; then
      printf '[E] GWT copy requested without reusable output at %s/gwt/www. Rebuild with --build-gwt=1.\n' "$build_dir" >&2
      return 1
   fi
}
