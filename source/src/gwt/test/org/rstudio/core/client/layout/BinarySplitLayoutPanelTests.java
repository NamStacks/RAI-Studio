/*
 * BinarySplitLayoutPanelTests.java
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
package org.rstudio.core.client.layout;

import com.google.gwt.junit.client.GWTTestCase;
import com.google.gwt.user.client.ui.HTML;
import com.google.gwt.user.client.ui.RootPanel;
import com.google.gwt.user.client.ui.Widget;

// Regression coverage for the packaged-renderer runaway resize loop:
// updateLayout() schedules its animate(0) completion callback for the next
// animation frame, so it re-enters onResize() asynchronously after the
// caller has already returned. When the container's real pixel height
// jitters by a sub-pixel amount (e.g. fractional device pixel ratios in the
// packaged app), the proportional splitter position recompute rounds right
// back to the same value every time, but the old code still called
// setSplitterPos()/updateLayout() on every single onResize(), rescheduling
// another animate(0)/onResize() forever and pegging the renderer.
public class BinarySplitLayoutPanelTests extends GWTTestCase
{
   @Override
   public String getModuleName()
   {
      return "org.rstudio.studio.RStudioTests";
   }

   // getOffsetHeight() is overridden to return a settable field instead of a
   // real DOM measurement, so a test can drive onResize() with a precise,
   // repeatable container height. setSplitterPos() is counted so a test can
   // assert onResize() skipped calling it entirely for a no-op resize.
   private static class TestPanel extends BinarySplitLayoutPanel
   {
      int height;
      int setSplitterPosCount;

      TestPanel(int splitterHeight)
      {
         super("test", new Widget[] { new HTML("top"), new HTML("bottom") }, splitterHeight);
         setTopWidget(0, true);
         setBottomWidget(1, true);
      }

      @Override
      public int getOffsetHeight()
      {
         return height;
      }

      @Override
      public void setSplitterPos(int splitterPos, boolean fromTop)
      {
         setSplitterPosCount++;
         super.setSplitterPos(splitterPos, fromTop);
      }
   }

   public void testOscillatingSubPixelHeightSkipsRedundantResize()
   {
      TestPanel panel = new TestPanel(5);
      RootPanel.get().add(panel);

      panel.height = 900;
      panel.setSplitterPos(300, false);
      assertEquals(300, panel.getSplitterBottom());

      panel.setSplitterPosCount = 0;

      // Sub-pixel jitter: the proportional recompute (300 / 900 * height)
      // rounds right back to 300 on both sides of the oscillation.
      for (int i = 0; i < 10; i++)
      {
         panel.height = (i % 2 == 0) ? 899 : 901;
         panel.onResize();
      }
      assertEquals(
            "repeated resizes with an unchanged effective splitter position " +
            "must not call setSplitterPos()",
            0, panel.setSplitterPosCount);
      assertEquals(300, panel.getSplitterBottom());

      // A real height change must still move the splitter proportionally.
      panel.height = 1200;
      panel.onResize();
      assertEquals(
            "an actual height change must still update the splitter position",
            1, panel.setSplitterPosCount);
      assertEquals(400, panel.getSplitterBottom());

      RootPanel.get().remove(panel);
   }

   // Regression: when the splitter is near 50% (e.g. 450/900), a ±1px height
   // oscillation makes Math.round produce alternating values (450 vs 451),
   // defeating an exact equality guard. The ±1 tolerance must absorb this.
   public void testAlternatingNewPosFromHalfPixelOscillation()
   {
      TestPanel panel = new TestPanel(5);
      RootPanel.get().add(panel);

      panel.height = 900;
      panel.setSplitterPos(450, false);
      assertEquals(450, panel.getSplitterBottom());

      panel.setSplitterPosCount = 0;

      // height oscillates 899 → 901 → 899 → ...
      // pct = 450/900 = 0.5
      // newPos for 899: round(899*0.5) = round(449.5) = 450 (no change)
      // newPos for 901: round(901*0.5) = round(450.5) = 451 (1px away)
      // Without the tolerance, 451 != 450 would trigger setSplitterPos on
      // every odd iteration, causing an infinite loop inside
      // flushFinallyCommands.
      for (int i = 0; i < 20; i++)
      {
         panel.height = (i % 2 == 0) ? 899 : 901;
         panel.onResize();
      }
      assertEquals(
            "±1px height oscillation near 50% must not trigger setSplitterPos",
            0, panel.setSplitterPosCount);
      assertEquals(450, panel.getSplitterBottom());

      // A real resize still works from this state.
      panel.height = 1200;
      panel.onResize();
      assertEquals(1, panel.setSplitterPosCount);
      assertEquals(600, panel.getSplitterBottom());

      RootPanel.get().remove(panel);
   }
}
