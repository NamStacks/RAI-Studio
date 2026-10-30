/*
 * ClaudeCodeLauncher.java
 *
 * Copyright (C) 2022 by Posit Software, PBC
 *
 * Unless you have received this program directly from Posit Software pursuant
 * to the terms of a commercial license agreement with Posit Software, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

package org.rstudio.studio.client.workbench.views.terminal;

public class ClaudeCodeLauncher
{
   // Fixed POSIX command line submitted to a native xterm. Resolves the claude
   // CLI from PATH first, then the standard install locations, and exec's the
   // quoted path so the shell process is replaced. No user input, no
   // interpolation beyond the fixed $HOME and $(command -v claude).
   public static final String SHELL_COMMAND =
      "if command -v claude >/dev/null 2>&1; then exec \"$(command -v claude)\"; " +
      "elif [ -x \"$HOME/.local/bin/claude\" ]; then exec \"$HOME/.local/bin/claude\"; " +
      "elif [ -x \"$HOME/.claude/local/claude\" ]; then exec \"$HOME/.claude/local/claude\"; " +
      "elif [ -x /opt/homebrew/bin/claude ]; then exec \"/opt/homebrew/bin/claude\"; " +
      "elif [ -x /usr/local/bin/claude ]; then exec \"/usr/local/bin/claude\"; " +
      "else echo \"RAI-Studio: Claude Code was not found. Install it, then relaunch.\"; fi\n";
}
