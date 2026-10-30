#!/bin/bash
# Compile the GWT client with the same ant command CMake generates for the x86_64 tree.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/plan-env-0164.sh"
S=${STAGE:?set STAGE to the build staging folder}
SRC=$S/universal-build-preparation-01/builder-source-49a8
T=$S/universal-native-build-x86_64-01
cd "$SRC/src/gwt"
/opt/homebrew/opt/ant/bin/ant -Dbuild.dir="$T/gwt/bin" -Dextras.dir="$T/gwt/extras" -Dwww.dir="$T/gwt/www" -Dgwt.style="" -Dgwt.xmx="-Xmx1536M" -Dgwt.xss="-Xss16M" -Dgwt.main.module="org.rstudio.studio.RStudio" > "$HERE/logs/gwt.log" 2>&1
echo "gwt exit=$?"; tail -5 "$HERE/logs/gwt.log"
ls -la "$T/gwt/www/rstudio" | head -5
