/*
 * ClaudeCodeLauncherTests.java
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

import junit.framework.TestCase;

// Plain JVM TestCase (no GWTTestCase) since SHELL_COMMAND is a pure String
// constant with no GWT dependencies. Runs in the JVM under the existing suite.
public class ClaudeCodeLauncherTests extends TestCase
{
   public void testCommandIsNonEmpty()
   {
      assertNotNull(ClaudeCodeLauncher.SHELL_COMMAND);
      assertTrue(ClaudeCodeLauncher.SHELL_COMMAND.length() > 0);
   }

   public void testResolvesClaudeFromPathFirst()
   {
      assertTrue(ClaudeCodeLauncher.SHELL_COMMAND.contains("command -v claude"));
   }

   public void testFallsBackToStandardMacLocations()
   {
      String cmd = ClaudeCodeLauncher.SHELL_COMMAND;
      assertTrue(cmd.contains("$HOME"));
      assertTrue(cmd.contains("/opt/homebrew/bin"));
      assertTrue(cmd.contains("/usr/local/bin"));
   }

   public void testPrintsClearErrorWhenUnresolved()
   {
      String cmd = ClaudeCodeLauncher.SHELL_COMMAND;
      assertTrue(cmd.contains("RAI-Studio"));
      assertTrue(cmd.contains("not found"));
   }

   public void testNoUserInputInterpolation()
   {
      // constant command must not carry any format/interpolation placeholders
      String cmd = ClaudeCodeLauncher.SHELL_COMMAND;
      assertFalse(cmd.contains("%s"));
      assertFalse(cmd.contains("{"));
   }

   public void testExecutesOnSubmit()
   {
      // trailing newline submits the line to the interactive shell
      assertTrue(ClaudeCodeLauncher.SHELL_COMMAND.endsWith("\n"));
   }
}
