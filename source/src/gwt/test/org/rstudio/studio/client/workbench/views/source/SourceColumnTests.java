/*
 * SourceColumnTests.java
 *
 * Copyright (C) 2026 by Posit Software, PBC
 *
 * This program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */
package org.rstudio.studio.client.workbench.views.source;

import java.util.ArrayList;

import org.rstudio.studio.client.workbench.views.source.editors.EditingTarget;

import com.google.gwt.junit.client.GWTTestCase;

public class SourceColumnTests extends GWTTestCase
{
   @Override
   public String getModuleName()
   {
      return "org.rstudio.studio.RStudioTests";
   }

   public void testStaleSelectionAfterEditorRemovalIsIgnored()
   {
      ArrayList<EditingTarget> editors = new ArrayList<>();
      editors.add(null);
      int staleSelectionIndex = 0;

      editors.remove(0);

      assertNull(SourceColumn.selectionTarget(editors, staleSelectionIndex));
   }
}
