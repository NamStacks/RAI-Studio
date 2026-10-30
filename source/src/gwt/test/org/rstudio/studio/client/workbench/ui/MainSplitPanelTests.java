/*
 * MainSplitPanelTests.java
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
package org.rstudio.studio.client.workbench.ui;

import java.util.ArrayList;

import org.rstudio.studio.client.application.events.EventBus;
import org.rstudio.studio.client.common.satellite.Satellite;
import org.rstudio.studio.client.common.satellite.SatelliteManager;
import org.rstudio.studio.client.workbench.model.ClientInitState;
import org.rstudio.studio.client.workbench.model.Session;
import org.rstudio.studio.client.workbench.model.SessionInfo;

import com.google.gwt.junit.client.GWTTestCase;
import com.google.gwt.user.client.ui.HTML;
import com.google.gwt.user.client.ui.RootPanel;
import com.google.gwt.user.client.ui.SimplePanel;
import com.google.gwt.user.client.ui.Widget;
import com.google.inject.Provider;

// Regression coverage for the right-side RAI Assistant "cover mode" sidebar
// (commit 8931576 and its follow-up fixes): hiding/showing the sidebar in
// place must never detach its widget (that's what keeps the Assistant
// terminal's iframe/WebSocket/PTY session alive across a toggle), and a
// left-column add/remove while the sidebar is hidden must not silently
// defeat that by detaching it anyway. A left-column add/remove also
// unconditionally tears down and rebuilds the right column (see
// MainSplitPanel.clearForRefresh()/initialize()), so it must not silently
// undo the exclusive right-column "cover" either.
public class MainSplitPanelTests extends GWTTestCase
{
   @Override
   public String getModuleName()
   {
      return "org.rstudio.studio.RStudioTests";
   }

   // Tracks GWT attach/detach lifecycle calls -- the observable proxy for
   // "did the iframe inside this widget just get reloaded".
   private static class TrackingWidget extends SimplePanel
   {
      int loadCount = 0;
      int unloadCount = 0;

      @Override
      protected void onLoad()
      {
         super.onLoad();
         loadCount++;
      }

      @Override
      protected void onUnload()
      {
         super.onUnload();
         unloadCount++;
      }
   }

   private static native SessionInfo createSessionInfo() /*-{
      return { client_state: {} };
   }-*/;

   private MainSplitPanel createPanel()
   {
      return createPanel(new HTML("right"));
   }

   private MainSplitPanel createPanel(Widget right)
   {
      Provider<Satellite> pSatellite = () -> null;
      Provider<SatelliteManager> pManager = () -> null;
      EventBus events = new EventBus(pSatellite, pManager);

      Session session = new Session(events);
      session.setSessionInfo(createSessionInfo());

      MainSplitPanel panel = new MainSplitPanel(events, session);
      RootPanel.get().add(panel);
      panel.setPixelSize(1000, 600);

      panel.initialize(new ArrayList<Widget>(), new HTML("center"), right, null, "right");
      return panel;
   }

   public void testHideShowSidebarPreservesAttachment()
   {
      MainSplitPanel panel = createPanel();
      TrackingWidget sidebar = new TrackingWidget();

      panel.setSidebarWidget(sidebar, "right");
      assertTrue(panel.hasSidebarWidget());
      assertFalse(panel.isSidebarWidgetHidden());
      assertEquals(1, sidebar.loadCount);
      assertEquals(0, sidebar.unloadCount);

      panel.hideSidebarWidget();
      assertFalse(panel.hasSidebarWidget());
      assertTrue(panel.isSidebarWidgetHidden());
      assertEquals("hiding in place must never detach the widget", 0, sidebar.unloadCount);
      assertEquals(1, sidebar.loadCount);

      panel.showSidebarWidget();
      assertTrue(panel.hasSidebarWidget());
      assertFalse(panel.isSidebarWidgetHidden());
      assertEquals("showing the same widget back must not re-attach it", 1, sidebar.loadCount);
      assertEquals(0, sidebar.unloadCount);

      RootPanel.get().remove(panel);
   }

   public void testAddLeftWidgetPreservesHiddenSidebar()
   {
      MainSplitPanel panel = createPanel();
      TrackingWidget sidebar = new TrackingWidget();
      panel.setSidebarWidget(sidebar, "right");
      panel.hideSidebarWidget();

      panel.addLeftWidget(new HTML("source column"));

      assertEquals("a left-column add must not detach a hidden-in-place sidebar",
                   0, sidebar.unloadCount);
      assertTrue(panel.isSidebarWidgetHidden());
      assertFalse(panel.hasSidebarWidget());

      panel.showSidebarWidget();
      assertTrue(panel.hasSidebarWidget());
      assertEquals("the Assistant terminal must reappear without reloading",
                   1, sidebar.loadCount);
      assertEquals(0, sidebar.unloadCount);

      RootPanel.get().remove(panel);
   }

   public void testRemoveLeftWidgetPreservesHiddenSidebar()
   {
      MainSplitPanel panel = createPanel();
      Widget sourceColumn = new HTML("source column");
      panel.addLeftWidget(sourceColumn);

      TrackingWidget sidebar = new TrackingWidget();
      panel.setSidebarWidget(sidebar, "right");
      panel.hideSidebarWidget();

      panel.removeLeftWidget(sourceColumn);

      assertEquals("a left-column removal must not detach a hidden-in-place sidebar",
                   0, sidebar.unloadCount);
      assertTrue(panel.isSidebarWidgetHidden());

      panel.showSidebarWidget();
      assertTrue(panel.hasSidebarWidget());
      assertEquals(1, sidebar.loadCount);
      assertEquals(0, sidebar.unloadCount);

      RootPanel.get().remove(panel);
   }

   // Regression coverage for the exclusive right-column "cover" mode: a left
   // column add/remove tears down and rebuilds right_ (see clearForRefresh()/
   // initialize()), and GWT's DockLayoutPanel hands the reattached widget a
   // brand-new LayoutData (hidden defaults to false). Without reapplying
   // rightHidden_ after that rebuild, Environment/Files silently reappears
   // even though the sidebar is still (or again) exclusively covering it.
   public void testAddLeftWidgetPreservesExclusiveCoverWhileSidebarHidden()
   {
      Widget right = new HTML("right");
      MainSplitPanel panel = createPanel(right);
      TrackingWidget sidebar = new TrackingWidget();

      panel.setSidebarWidget(sidebar, "right");
      panel.setRightWidgetHidden(true);
      panel.hideSidebarWidget();
      panel.forceLayout();
      assertEquals("right column should start covered", 0, right.getOffsetWidth());

      panel.addLeftWidget(new HTML("source column"));
      panel.forceLayout();

      assertTrue("exclusive cover flag must survive a left-column add",
                 panel.isRightWidgetHidden());
      assertEquals("a left-column add must not silently re-show the covered right column",
                   0, right.getOffsetWidth());
      assertEquals("a left-column add must not detach the hidden-in-place sidebar",
                   0, sidebar.unloadCount);
      assertTrue(panel.isSidebarWidgetHidden());

      RootPanel.get().remove(panel);
   }

   public void testRemoveLeftWidgetPreservesExclusiveCoverWhileSidebarHidden()
   {
      Widget right = new HTML("right");
      MainSplitPanel panel = createPanel(right);
      Widget sourceColumn = new HTML("source column");
      panel.addLeftWidget(sourceColumn);

      TrackingWidget sidebar = new TrackingWidget();
      panel.setSidebarWidget(sidebar, "right");
      panel.setRightWidgetHidden(true);
      panel.hideSidebarWidget();
      panel.forceLayout();
      assertEquals("right column should start covered", 0, right.getOffsetWidth());

      panel.removeLeftWidget(sourceColumn);
      panel.forceLayout();

      assertTrue("exclusive cover flag must survive a left-column removal",
                 panel.isRightWidgetHidden());
      assertEquals("a left-column removal must not silently re-show the covered right column",
                   0, right.getOffsetWidth());
      assertEquals("a left-column removal must not detach the hidden-in-place sidebar",
                   0, sidebar.unloadCount);
      assertTrue(panel.isSidebarWidgetHidden());

      RootPanel.get().remove(panel);
   }

   // Regression for Gate F startup NPE: PaneManager.getZoomedColumn() called
   // panel_.getWidgetSize(right_) before panel_.initialize() had added right_
   // to the SplitLayoutPanel. getWidgetSize() reads getLayoutData() which is
   // null for un-added widgets, causing an NPE (Double.doubleValue on null).
   // The fix: (1) PaneManager defers showSidebar() until after initialize(),
   // (2) getZoomedColumn() guards against null LayoutData.
   public void testWidgetLayoutDataNullBeforeInitialize()
   {
      Widget right = new HTML("right");

      // Before being added to a SplitLayoutPanel, LayoutData is null --
      // this is the condition that triggered the NPE.
      assertNull(right.getLayoutData());

      MainSplitPanel panel = createPanel(right);

      // After initialize() adds it, LayoutData must be populated.
      assertNotNull("LayoutData must be set after initialize() adds widget to panel",
                    right.getLayoutData());

      RootPanel.get().remove(panel);
   }

   // Sanity check for the opposite, intentional path (e.g. sidebar location
   // change): full removal must still really detach the widget.
   public void testRemoveSidebarWidgetFullyDetaches()
   {
      MainSplitPanel panel = createPanel();
      TrackingWidget sidebar = new TrackingWidget();
      panel.setSidebarWidget(sidebar, "right");

      panel.removeSidebarWidget();

      assertEquals(1, sidebar.unloadCount);
      assertFalse(panel.hasSidebarWidget());
      assertFalse(panel.isSidebarWidgetHidden());

      RootPanel.get().remove(panel);
   }
}
