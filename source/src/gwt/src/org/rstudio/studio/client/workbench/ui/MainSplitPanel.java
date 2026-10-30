/*
 * MainSplitPanel.java
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
package org.rstudio.studio.client.workbench.ui;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

import org.rstudio.core.client.ElementIds;
import org.rstudio.core.client.events.ManageLayoutCommandsEvent;
import org.rstudio.core.client.js.JsObject;
import org.rstudio.studio.client.application.events.EventBus;
import org.rstudio.studio.client.common.NotifyingSplitLayoutPanel;
import org.rstudio.studio.client.workbench.model.ClientState;
import org.rstudio.studio.client.workbench.model.Session;
import org.rstudio.studio.client.workbench.model.helper.JSObjectStateValue;

import com.google.gwt.core.client.JavaScriptObject;
import com.google.gwt.core.client.Scheduler;
import com.google.gwt.core.client.Scheduler.ScheduledCommand;
import com.google.gwt.dom.client.Element;
import com.google.gwt.user.client.Command;
import com.google.gwt.user.client.Window;
import com.google.gwt.user.client.ui.SplitterResizedEvent;
import com.google.gwt.user.client.ui.SplitterResizedHandler;
import com.google.gwt.user.client.ui.Widget;
import com.google.inject.Inject;

public class MainSplitPanel extends NotifyingSplitLayoutPanel
      implements SplitterResizedHandler
{
   private static class State extends JavaScriptObject
   {
      protected State() {}

      public native final boolean hasSplitterPos() /*-{
         return this.splitterpos && this.splitterpos.length;
      }-*/;

      public native final int[] getSplitterPos() /*-{
         return this.splitterpos;
      }-*/;

      public native final int getSplitterCount() /*-{
         return this.splitterpos.length;
      }-*/;

      public native final void setSplitterPos(int[] pos) /*-{
         this.splitterpos = pos;
      }-*/;

      public native final boolean hasPanelWidth() /*-{
         return typeof(this.panelwidth) != 'undefined';
      }-*/;

      public native final int getPanelWidth() /*-{
         return this.panelwidth;
      }-*/;

      public native final void setPanelWidth(int width) /*-{
         this.panelwidth = width;
      }-*/;

      public native final boolean hasWindowWidth() /*-{
         return typeof(this.windowwidth) != 'undefined';
      }-*/;

      public native final int getWindowWidth() /*-{
         return this.windowwidth;
      }-*/;

      public native final void setWindowWidth(int width) /*-{
         this.windowwidth = width;
      }-*/;

      public static boolean equals(State a, State b)
      {
         if (a == null ^ b == null)
            return false;
         if (a == null)
            return true;

         if (a.hasSplitterPos() ^ b.hasSplitterPos())
            return false;
         if (a.hasSplitterPos() &&
             !Arrays.equals(a.getSplitterPos(), b.getSplitterPos()))
            return false;

         if (a.hasPanelWidth() ^ b.hasPanelWidth())
            return false;
         if (a.hasPanelWidth() && a.getPanelWidth() != b.getPanelWidth())
            return false;

         if (a.hasWindowWidth() ^ b.hasWindowWidth())
            return false;
         if (a.hasWindowWidth() && a.getWindowWidth() != b.getWindowWidth())
            return false;

         return true;
      }

      public final boolean validate()
      {
         if (hasSplitterPos() && hasWindowWidth())
         {
            for (int i = 0; i < getSplitterPos().length; i++)
            {
               if (getSplitterPos()[i] < 0 ||
                   getSplitterPos()[i] > getPanelWidth())
                  return false;
            }
         }
         return true;
      }
   }

   @Inject
   public MainSplitPanel(EventBus events,
                         Session session)
   {
      super(7, events);

      events_ = events;
      session_ = session;
      addSplitterResizedHandler(this);
   }

   public void initialize(ArrayList<Widget> leftList, Widget center, Widget right, Widget sidebar, String sidebarLocation)
   {
      leftList_ = leftList;
      center_ = center;
      right_ = right;
      sidebar_ = sidebar;
      sidebarLocation_ = sidebarLocation;

      new JSObjectStateValue(GROUP_WORKBENCH,
                             KEY_RIGHTPANESIZE,
                             ClientState.PERSISTENT,
                             session_.getSessionInfo().getClientState(),
                             false) {

         @Override
         protected void onInit(JsObject value)
         {
            // If we already have a set state, with the correct number of columns use that
            State state = value == null ? null : (State)value.cast();
            // hasSidebarWidget() (visible-only), not sidebar_ != null: a hidden-in-place
            // sidebar (see hideSidebarWidget()) has no slot in the persisted splitter
            // array (getValue() below excludes it too), so counting it here would
            // permanently mismatch state.getSplitterCount() and force default widths.
            int expectedCount = leftList_.size() + 1 + (hasSidebarWidget() ? 1 : 0);

            // Don't restore state if it represents a zoomed column layout (issue #16688)
            // or if sidebar width is below minimum (issue where 0-width sidebar persisted)
            // This avoids broken zoom state on restart - instead use defaults
            if (state != null &&
                state.validate() &&
                state.hasSplitterPos() &&
                state.getSplitterCount() == expectedCount &&
                !isZoomedColumnState(state) &&
                !hasBelowMinimumSidebarWidth(state))
            {
               if (state.hasPanelWidth() && state.hasWindowWidth()
                   && state.getWindowWidth() != Window.getClientWidth())
               {
                  int delta = state.getWindowWidth() - state.getPanelWidth();
                  int offsetWidth = Window.getClientWidth() - delta;
                  int idx = 0;
                  double pct;

                  // Add sidebar if on left (hasSidebarWidget(): skip a hidden-in-place one --
                  // it has no slot in this array, see expectedCount above)
                  if (hasSidebarWidget() && "left".equals(sidebarLocation_))
                  {
                     pct = (double)state.getSplitterPos()[idx++]
                                  / state.getPanelWidth();
                     addWest(sidebar_, pct * offsetWidth);
                  }

                  // Add left widgets
                  for (int i = 0; i < leftList_.size(); i++)
                  {
                     pct = (double)state.getSplitterPos()[idx++]
                            / state.getPanelWidth();
                     addWest(leftList_.get(i), pct * offsetWidth);
                  }

                  // Add right sidebar if present (hasSidebarWidget(): see above)
                  if (hasSidebarWidget() && !"left".equals(sidebarLocation_))
                  {
                     pct = (double)state.getSplitterPos()[idx++]
                                  / state.getPanelWidth();
                     addEast(sidebar_, pct * offsetWidth);
                  }

                  // Right is always EAST, center is always CENTER (fill)
                  pct = (double)state.getSplitterPos()[idx++]
                               / state.getPanelWidth();
                  addEast(right_, pct * offsetWidth);
                  add(center_);
               }
               else
               {
                  int idx = 0;

                  // Add sidebar if on left (hasSidebarWidget(): see expectedCount above)
                  if (hasSidebarWidget() && "left".equals(sidebarLocation_))
                     addWest(sidebar_, state.getSplitterPos()[idx++]);

                  // Add left widgets
                  for (int i = 0; i < leftList_.size(); i++)
                     addWest(leftList_.get(i), state.getSplitterPos()[idx++]);

                  // Add right sidebar if present (hasSidebarWidget(): see above)
                  if (hasSidebarWidget() && !"left".equals(sidebarLocation_))
                     addEast(sidebar_, state.getSplitterPos()[idx++]);

                  // Right is always EAST, center is always CENTER (fill)
                  addEast(right_, state.getSplitterPos()[idx++]);
                  add(center_);
               }
            }
            else
            {
               // When there are only two panels, make the left side slightly larger than the right,
               // otherwise divide the space equally.
               double splitWidth = getDefaultSplitterWidth();
               
               // Add sidebar if on left (hasSidebarWidget(): see expectedCount above)
               if (hasSidebarWidget() && "left".equals(sidebarLocation_))
                  addWest(sidebar_, splitWidth * 0.8); // Sidebar slightly narrower
               
               // Add left widgets
               for (Widget w : leftList_)
                  addWest(w, splitWidth);
               
               // Add right sidebar if present (hasSidebarWidget(): see above)
               if (hasSidebarWidget() && !"left".equals(sidebarLocation_))
                  addEast(sidebar_, splitWidth * 0.8); // Sidebar slightly narrower

               // Right is always EAST, center is always CENTER (fill)
               addEast(right_, splitWidth);
               add(center_);
            }

            Scheduler.get().scheduleDeferred(new ScheduledCommand()
            {
               public void execute()
               {
                  enforceBoundaries();
                  setSplitterAttributes();
                  deferredSaveWidthPercent();
               }
            });
         }

         @Override
         protected JsObject getValue()
         {
            State state = JavaScriptObject.createObject().cast();
            state.setPanelWidth(getOffsetWidth());
            state.setWindowWidth(Window.getClientWidth());

            // The widget's code determines the splitter positions from the width of each widget
            // so these value represent that width rather than the actual coordinates of the
            // splitter. A hidden sidebar is treated as absent here (as it always was before
            // non-destructive hide/show existed) so the array shape survives a quit-while-hidden.
            int sidebarCount = hasSidebarWidget() ? 1 : 0;
            int[] splitterArray = new int[leftList_.size() + 1 + sidebarCount];
            int idx = 0;

            // Store sidebar width if on left
            if (hasSidebarWidget() && "left".equals(sidebarLocation_))
               splitterArray[idx++] = sidebar_.getOffsetWidth();

            // Store left widget widths
            if (!leftList_.isEmpty())
            {
               for (int i = 0; i < leftList_.size(); i++)
                  splitterArray[idx++] = leftList_.get(i).getOffsetWidth();
            }

            // Store sidebar width if on right (before right widget in the array)
            if (hasSidebarWidget() && !"left".equals(sidebarLocation_))
               splitterArray[idx++] = sidebar_.getOffsetWidth();

            // Store right widget width -- never the live 0 while it's covered
            // by an exclusive-mode sidebar, so a quit-while-covered restart
            // doesn't corrupt the Environment/Files column to 0-width.
            splitterArray[idx++] = rightHidden_ && savedRightWidth_ > 0
                  ? savedRightWidth_ : right_.getOffsetWidth();
            state.setSplitterPos(splitterArray);
            return state.cast();
         }

         @Override
         protected boolean hasChanged()
         {
            JsObject newValue = getValue();
            if (!State.equals(lastKnownValue_, (State) newValue.cast()))
            {
               lastKnownValue_ = newValue.cast();
               return true;
            }
            return false;
         }

         private State lastKnownValue_;
      };

      setWidgetMinSize(right_, 0);
      if (sidebar_ != null)
         setWidgetMinSize(sidebar_, MINIMUM_SIDEBAR_WIDTH);

      // clearForRefresh()/initialize() unconditionally detaches and reattaches
      // right_ on every left-column add/remove (see addLeftWidget()/
      // removeLeftWidget()), even when only leftList_ actually changed.
      // DockLayoutPanel.insert() always allocates a brand-new LayoutData
      // (hidden=false) for the reattached widget, so the exclusive-cover state
      // must be explicitly reapplied here -- otherwise Environment/Files
      // silently reappears next to the sidebar while rightHidden_ still
      // reports true. A no-op when rightHidden_ is false (the common case).
      setWidgetHidden(right_, rightHidden_);
   }

   @Override
   protected void onLoad()
   {
      super.onLoad();
      deferredSaveWidthPercent();
   }

   public void addLeftWidget(Widget widget)
   {
      clearForRefresh();
      leftList_.add(0, widget);
      // Pass sidebar_ through even when hidden-in-place -- clearForRefresh() leaves it
      // attached in that case, and initialize()'s layout logic (hasSidebarWidget()
      // gated) knows not to re-add an already-attached widget, so this preserves the
      // Assistant terminal's iframe/session across a source-column add.
      initialize(leftList_, center_, right_, sidebar_, sidebarLocation_);
   }

   public double getDefaultSplitterWidth()
   {
      int columnCount = 2 + leftList_.size() + (hasSidebarWidget() ? 1 : 0);
      return leftList_.isEmpty() && !hasSidebarWidget() ?
         Window.getClientWidth() * 0.45 :
         Window.getClientWidth() / columnCount;
   }
   
   public double getLeftSize()
   {
      double sum = 0.0;
      for (Widget w : leftList_)
         sum += getWidgetSize(w);
      return sum;
   }
   
   public ArrayList<Double> getLeftWidgetSizes()
   {
      ArrayList<Double> result = new ArrayList<>();
      for (Widget w : leftList_)
         result.add(getWidgetSize(w));
      return result;
   }
   
   public void removeLeftWidget(Widget widget)
   {
      clearForRefresh();
      leftList_.remove(widget);
      // See addLeftWidget(): pass sidebar_ through as-is, hidden or not.
      initialize(leftList_, center_, right_, sidebar_, sidebarLocation_);
   }
   
   public void setSidebarWidget(Widget widget)
   {
      setSidebarWidget(widget, "right");
   }

   public void setSidebarWidget(Widget widget, String location)
   {
      // A previously-hidden sidebar widget may still be attached (hiding no
      // longer detaches it) -- if we're about to replace it with a freshly
      // created widget (tab composition changed while hidden), detach the
      // stale one first so it doesn't linger as an orphaned child.
      if (sidebar_ != null && sidebar_ != widget)
      {
         remove(sidebar_);
         sidebarHidden_ = false;
      }

      // Check if we have saved widths from a previous sidebar toggle
      boolean restoringSavedWidths = savedSidebarWidth_ > 0 &&
          savedSidebarLocation_ != null &&
          savedSidebarLocation_.equals(location);
      int restoredWidth = savedSidebarWidth_;
      boolean centerWasCollapsed = savedCenterCollapsed_;

      savedSidebarWidth_ = -1;
      savedSidebarLocation_ = null;
      savedCenterCollapsed_ = false;

      sidebar_ = widget;
      sidebarLocation_ = location;

      // Calculate sidebar width. getDefaultSplitterWidth() now includes
      // the sidebar in the column count since sidebar_ was just set.
      double splitWidth = getDefaultSplitterWidth();
      int sidebarWidth = restoringSavedWidths ? restoredWidth : (int)(splitWidth * 0.8);

      // Insert sidebar into the panel without removing/re-adding center_ or right_.
      // This avoids detaching all GWT widgets in those panels (which triggers
      // onUnload/onLoad on every child widget like Help, Plots, etc.).
      if ("left".equals(location))
      {
         // Insert as WEST before the first left widget (or right_ if none),
         // making sidebar the leftmost widget.
         Widget before = leftList_.isEmpty() ? right_ : leftList_.get(0);
         insert(sidebar_, Direction.WEST, sidebarWidth, before);
      }
      else
      {
         // Insert as EAST before right_ in the widget list. Since the first
         // EAST widget in list order gets the rightmost position, sidebar
         // will be placed to the right of right_.
         insert(sidebar_, Direction.EAST, sidebarWidth, right_);
      }

      setWidgetMinSize(sidebar_, MINIMUM_SIDEBAR_WIDTH);

      // When there's no saved state (e.g. first time showing sidebar),
      // redistribute column widths so all columns get roughly equal space.
      // Without this, center_ (the fill widget) would absorb all the change
      // while right_ keeps its old (larger) width.
      if (!restoringSavedWidths)
      {
         LayoutData rightLayout = (LayoutData) right_.getLayoutData();
         if (rightLayout != null)
            rightLayout.size = splitWidth;

         for (Widget w : leftList_)
         {
            LayoutData layout = (LayoutData) w.getLayoutData();
            if (layout != null)
               layout.size = splitWidth;
         }
      }

      setSplitterAttributes();
      forceLayout();
      deferredSaveWidthPercent();

      // Showing the sidebar takes its width from center_ (the fill column), so
      // a narrow Source/Console column can be squeezed to ~0 while right_ keeps
      // its width -- leaving Source/Console invisible. The geometry isn't
      // settled until the forceLayout above lays out, so defer the check to
      // read the post-relayout width; if the center collapsed involuntarily,
      // reclaim space by resetting the other columns to default widths.
      //
      // But don't fight the user: if they had deliberately collapsed the center
      // before hiding the sidebar, restoring it near-zero is the correct,
      // faithful restore -- leave it alone.
      final boolean preserveCollapsedCenter = restoringSavedWidths && centerWasCollapsed;
      Scheduler.get().scheduleDeferred(new ScheduledCommand()
      {
         public void execute()
         {
            if (preserveCollapsedCenter)
               return;

            if (center_ == null || center_.getOffsetWidth() >= MINIMUM_CENTER_WIDTH)
               return;

            double defaultWidth = getDefaultSplitterWidth();
            LayoutData rightLayout = (LayoutData) right_.getLayoutData();
            if (rightLayout != null)
               rightLayout.size = defaultWidth;
            for (Widget w : leftList_)
            {
               LayoutData layout = (LayoutData) w.getLayoutData();
               if (layout != null)
                  layout.size = defaultWidth;
            }
            forceLayout();
            deferredSaveWidthPercent();
         }
      });
   }

   public void removeSidebarWidget()
   {
      // Save sidebar width and location so we can restore them when sidebar is shown again
      if (sidebar_ != null)
      {
         savedSidebarWidth_ = sidebar_.getOffsetWidth();
         savedSidebarLocation_ = sidebarLocation_;
         // Remember a deliberately-collapsed center so showing the sidebar
         // again restores it as-is rather than treating it as a squeeze.
         savedCenterCollapsed_ = center_ != null &&
             center_.getOffsetWidth() < MINIMUM_CENTER_WIDTH;
      }

      // Remove only the sidebar widget (and its splitter). center_ and right_
      // stay attached — no onUnload/onLoad on their children.
      remove(sidebar_);
      sidebar_ = null;
      sidebarHidden_ = false;

      setSplitterAttributes();
      forceLayout();
      deferredSaveWidthPercent();
   }

   /**
    * Hide the sidebar widget without detaching it from the DOM (display:none
    * via SplitLayoutPanel.setWidgetHidden). Unlike removeSidebarWidget(), an
    * iframe inside the sidebar (e.g. the Assistant terminal) never unloads,
    * so its WebSocket/PTY session survives.
    */
   public void hideSidebarWidget()
   {
      if (sidebar_ == null || sidebarHidden_)
         return;

      savedSidebarWidth_ = sidebar_.getOffsetWidth();
      savedSidebarLocation_ = sidebarLocation_;
      savedCenterCollapsed_ = center_ != null &&
          center_.getOffsetWidth() < MINIMUM_CENTER_WIDTH;

      setWidgetHidden(sidebar_, true);
      sidebarHidden_ = true;
      deferredSaveWidthPercent();
   }

   /**
    * Reverse of hideSidebarWidget(): un-hide the same widget in place. Only
    * valid when isSidebarWidgetHidden() is true (a widget attached by a prior
    * setSidebarWidget() call, currently hidden).
    */
   public void showSidebarWidget()
   {
      if (sidebar_ == null || !sidebarHidden_)
         return;

      setWidgetHidden(sidebar_, false);
      sidebarHidden_ = false;

      if (savedSidebarWidth_ > 0)
      {
         LayoutData layoutData = (LayoutData) sidebar_.getLayoutData();
         if (layoutData != null)
            layoutData.size = savedSidebarWidth_;
      }
      final boolean preserveCollapsedCenter = savedCenterCollapsed_;
      savedSidebarWidth_ = -1;
      savedSidebarLocation_ = null;
      savedCenterCollapsed_ = false;

      setSplitterAttributes();
      forceLayout();
      deferredSaveWidthPercent();

      // The retained-widget path must match setSidebarWidget()'s reclaim
      // behavior. A center column that becomes sub-minimum only because the
      // sidebar reappeared is reset; a collapse present before hiding remains
      // a deliberate user layout choice.
      Scheduler.get().scheduleDeferred(new ScheduledCommand()
      {
         public void execute()
         {
            if (preserveCollapsedCenter || center_ == null ||
                center_.getOffsetWidth() >= MINIMUM_CENTER_WIDTH)
               return;

            double defaultWidth = getDefaultSplitterWidth();
            LayoutData rightLayout = (LayoutData) right_.getLayoutData();
            if (rightLayout != null)
               rightLayout.size = defaultWidth;
            for (Widget w : leftList_)
            {
               LayoutData layout = (LayoutData) w.getLayoutData();
               if (layout != null)
                  layout.size = defaultWidth;
            }
            forceLayout();
            deferredSaveWidthPercent();
         }
      });
   }

   public boolean hasSidebarWidget()
   {
      return sidebar_ != null && !sidebarHidden_;
   }

   public boolean isSidebarWidgetHidden()
   {
      return sidebar_ != null && sidebarHidden_;
   }

   /**
    * Exclusive (cover) mode: hide/show the right_ column in place so a
    * right-side sidebar can occupy its footprint instead of adding a fourth
    * column. Mirrors hideSidebarWidget()/showSidebarWidget() -- right_ is
    * never detached, only CSS-hidden, so its children's state (e.g. an
    * Environment/Files iframe) is preserved.
    */
   public void setRightWidgetHidden(boolean hidden)
   {
      if (hidden == rightHidden_)
         return;

      if (hidden)
      {
         savedRightWidth_ = right_.getOffsetWidth();
         setWidgetHidden(right_, true);
      }
      else
      {
         setWidgetHidden(right_, false);
         // Prefer the sidebar's current width -- whatever the user resized
         // the Assistant cover to while it occupied this footprint -- over
         // savedRightWidth_ (right_'s width from before it was ever
         // covered). Environment/Files should keep the size the user just
         // set, not snap back to whatever it was before the cover began.
         // The sidebar widget is still rendered at this point (this runs
         // before hideSidebarWidget()), so its width is current.
         int restoredWidth = getSidebarWidth();
         if (restoredWidth <= 0)
            restoredWidth = savedRightWidth_;
         if (restoredWidth > 0)
         {
            LayoutData layoutData = (LayoutData) right_.getLayoutData();
            if (layoutData != null)
               layoutData.size = restoredWidth;
         }
      }
      rightHidden_ = hidden;

      setSplitterAttributes();
      forceLayout();
      deferredSaveWidthPercent();
   }

   public boolean isRightWidgetHidden()
   {
      return rightHidden_;
   }

   public int getSidebarWidth()
   {
      if (sidebar_ != null && sidebar_.getOffsetWidth() > 0)
         return sidebar_.getOffsetWidth();
      return -1; // No sidebar or not yet rendered
   }

   public void setSidebarWidth(int width)
   {
      if (sidebar_ != null && width > 0)
      {
         LayoutData layoutData = (LayoutData) sidebar_.getLayoutData();
         if (layoutData != null)
         {
            layoutData.size = width;
            forceLayout();
            deferredSaveWidthPercent();
         }
      }
   }

   public void onSplitterResized(SplitterResizedEvent event)
   {
      enforceBoundaries();
      deferredSaveWidthPercent();
      events_.fireEvent(new ManageLayoutCommandsEvent());
   }

   public void focusSplitter(Widget widget)
   {
      Element splitter = getAssociatedSplitterElement(widget);
      if (splitter != null)
         splitter.focus();
   }

   /**
    * Set appropriate aria-labels and elementIds on all splitters based on their position.
    */
   private void setSplitterAttributes()
   {
      // Set label for sidebar splitter if sidebar exists
      if (sidebar_ != null)
      {
         Element splitterElem = getAssociatedSplitterElement(sidebar_);
         if (splitterElem != null)
         {
            splitterElem.setId(ElementIds.getElementId(ElementIds.SIDEBAR_COLUMN_SPLITTER));
            splitterElem.setAttribute("aria-label", "sidebar column splitter");
         }
      }

      // Set labels for source column splitters
      for (int i = 0; i < leftList_.size(); i++)
      {
         Element splitterElem = getAssociatedSplitterElement(leftList_.get(i));
         if (splitterElem != null)
         {
            splitterElem.setId(ElementIds.getElementId(ElementIds.SOURCE_COLUMN_SPLITTER + (i + 1)));
            splitterElem.setAttribute("aria-label", "source column " + (i + 1) + " splitter");
         }
      }

      // Set label for the middle splitter (between center and right columns).
      // right_ is always EAST and always has the associated splitter.
      Element splitterElem = getAssociatedSplitterElement(right_);
      if (splitterElem != null)
      {
         splitterElem.setId(ElementIds.getElementId(ElementIds.MIDDLE_COLUMN_SPLITTER));
         splitterElem.setAttribute("aria-label", "middle column splitter");
      }
   }

   private void clearForRefresh()
   {
      remove(center_);
      remove(right_);
      // A hidden-in-place sidebar_ (see hideSidebarWidget()) must stay attached through
      // a left-column rebuild -- detaching it here would reload its iframe (e.g. the
      // Assistant terminal), and initialize() already knows to leave an
      // already-attached sidebar_ alone rather than re-add it.
      if (sidebar_ != null && !sidebarHidden_)
         remove(sidebar_);
      for (Widget w : leftList_)
         remove(w);
      widgetPercentages_.clear();
   }

   private void enforceBoundaries()
   {
      if (rightHidden_)
         return;

      LayoutData layoutData = (LayoutData) right_.getLayoutData();
      if (layoutData != null
          && getOffsetWidth() != 0
          && layoutData.size > getOffsetWidth() - 3)
      {
         layoutData.size = getOffsetWidth() - 3;
         forceLayout();
      }
   }

   private void deferredSaveWidthPercent()
   {
      Scheduler.get().scheduleDeferred(new ScheduledCommand()
      {
         public void execute()
         {
            widgetPercentages_.clear();
            int panelWidth = getOffsetWidth();
            assert panelWidth > 0;
            assert isVisible() && isAttached();
            if (panelWidth > 0)
            {
               // Store percentage for sidebar if present. Skip while hidden-in-place
               // (mirrors the right_/rightHidden_ guard below) so onResize()'s
               // proportional loop never overwrites its saved width with a live-0
               // percentage from its display:none offsetWidth.
               if (hasSidebarWidget())
                  widgetPercentages_.put(sidebar_, (double)sidebar_.getOffsetWidth() / panelWidth);

               // Store percentages for all left widgets
               for (Widget w : leftList_)
                  widgetPercentages_.put(w, (double)w.getOffsetWidth() / panelWidth);

               // right_ is always EAST and needs proportional resizing.
               // center_ is always CENTER (fill) and adjusts automatically.
               // Skip while covered so onResize()'s proportional loop never
               // overwrites its saved width with a live-0 percentage.
               if (!rightHidden_)
                  widgetPercentages_.put(right_, (double)right_.getOffsetWidth() / panelWidth);
            }
            previousOffsetWidth_ = panelWidth;
         }
      });
   }

   @Override
   public void onResize()
   {
      super.onResize();

      int offsetWidth = getOffsetWidth();
      // A >1px tolerance, not exact inequality: a cover-mode sidebar keeps a live,
      // continuously-repainting iframe (the Assistant terminal) permanently attached
      // instead of detached on hide, and that iframe's own internal re-fit can nudge
      // its container's offsetWidth by a stray pixel every layout pass. Without this
      // tolerance, that jitter re-triggers the proportional-resize branch below, which
      // reschedules forceLayout() -> onResize() every pass with no bound -- an
      // unbounded relayout loop (observed as a runaway-CPU/memory renderer).
      if ((previousOffsetWidth_ == null || Math.abs(offsetWidth - previousOffsetWidth_.intValue()) > 1)
          && !widgetPercentages_.isEmpty())
      {
         // Apply proportional resizing to all widgets
         for (Map.Entry<Widget, Double> entry : widgetPercentages_.entrySet())
         {
            Widget widget = entry.getKey();
            Double percentage = entry.getValue();
            LayoutData layoutData = (LayoutData) widget.getLayoutData();
            if (layoutData != null)
            {
               layoutData.size = percentage * offsetWidth;
            }
         }

         previousOffsetWidth_ = offsetWidth;

         // Defer actually updating the layout, so that if we receive many
         // mouse events before layout/paint occurs, we'll only update once.
         if (layoutCommand_ == null) {
           layoutCommand_ = new Command() {
             public void execute() {
               layoutCommand_ = null;
               forceLayout();
             }
           };
           Scheduler.get().scheduleDeferred(layoutCommand_);
         }
      }
   }

   /**
    * Check if the saved state represents a zoomed column layout.
    * We detect this to avoid restoring broken zoom state on restart (issue #16688).
    */
   private boolean isZoomedColumnState(State state)
   {
      if (state == null || !state.hasSplitterPos() || !state.hasPanelWidth())
         return false;

      int[] widths = state.getSplitterPos();
      int panelWidth = state.getPanelWidth();

      if (widths.length == 0 || panelWidth <= 0)
         return false;

      // Check if any single column takes up almost the entire panel width
      // This catches sidebar zoom and right column zoom
      for (int width : widths)
      {
         if (width > panelWidth - 50)
            return true;
      }

      // Check for left column zoom: right-side columns are collapsed
      // Right widget is always the last stored width
      int rightWidth = widths[widths.length - 1];
      boolean rightCollapsed = rightWidth < 20;

      // If sidebar is on the right, it's the second-to-last width. hasSidebarWidget():
      // a hidden-in-place sidebar has no slot in this array (see expectedCount above).
      boolean sidebarOnRight = hasSidebarWidget() && !"left".equals(sidebarLocation_);
      boolean sidebarCollapsed = true; // Default true if no sidebar on right

      if (sidebarOnRight && widths.length >= 2)
      {
         int sidebarWidth = widths[widths.length - 2];
         sidebarCollapsed = sidebarWidth < 20;
      }

      // If right (and sidebar if on right) are collapsed, left column is zoomed
      if (rightCollapsed && sidebarCollapsed)
         return true;

      return false;
   }

   private Map<Widget, Double> widgetPercentages_ = new HashMap<>();
   private Integer previousOffsetWidth_ = null;
   private int savedSidebarWidth_ = -1;
   private String savedSidebarLocation_ = null;
   // True once hideSidebarWidget() has hidden sidebar_ in place (setWidgetHidden);
   // sidebar_ itself stays non-null and attached so an iframe inside it never
   // unloads. hasSidebarWidget() reports visible-only so existing geometry
   // checks elsewhere keep their pre-existing meaning.
   private boolean sidebarHidden_ = false;
   private int savedRightWidth_ = -1;
   private boolean rightHidden_ = false;
   // Whether the center (Source/Console) column was already collapsed below
   // MINIMUM_CENTER_WIDTH when the sidebar was last hidden. A deliberately
   // collapsed center must be restored as-is on show, not "reclaimed".
   private boolean savedCenterCollapsed_ = false;

   private final EventBus events_;
   private final Session session_;
   private ArrayList<Widget> leftList_;
   private Widget center_;
   private Widget right_;
   private Widget sidebar_;
   private String sidebarLocation_ = "left";
   private static final String GROUP_WORKBENCH = "workbenchp";
   private static final String KEY_RIGHTPANESIZE = "rightpanesize";
   private static final int MINIMUM_SIDEBAR_WIDTH = 175;
   // Showing the sidebar must not squeeze the center (Source/Console) column
   // below this; if it would, the other columns are reset to default widths so
   // Source/Console can't be left at ~0 width (invisible).
   private static final int MINIMUM_CENTER_WIDTH = 50;
   private Command layoutCommand_;

   /**
    * Check if the saved state has a sidebar width below the minimum allowed.
    * This handles cases where the user dragged the sidebar too narrow in a previous version.
    */
   private boolean hasBelowMinimumSidebarWidth(State state)
   {
      // hasSidebarWidget(): a hidden-in-place sidebar has no slot in this array
      // (see expectedCount above), so there's no width to validate here.
      if (!hasSidebarWidget() || !state.hasSplitterPos())
         return false;

      int[] widths = state.getSplitterPos();

      // For left sidebar, it's the first width in the array
      if ("left".equals(sidebarLocation_))
      {
         if (widths.length > 0)
         {
            int sidebarWidth = widths[0];
            if (sidebarWidth < MINIMUM_SIDEBAR_WIDTH)
               return true;
         }
      }
      else
      {
         // For right sidebar, it's stored before the right widget (second-to-last)
         if (widths.length >= 2)
         {
            int sidebarWidth = widths[widths.length - 2];
            if (sidebarWidth < MINIMUM_SIDEBAR_WIDTH)
               return true;
         }
      }

      return false;
   }
}
