/*
 * RaiApprovalCardTests.java
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
package org.rstudio.studio.client.workbench.views.chat;

import com.google.gwt.dom.client.Document;
import com.google.gwt.dom.client.NativeEvent;
import com.google.gwt.event.dom.client.DomEvent;
import com.google.gwt.junit.client.GWTTestCase;
import com.google.gwt.user.client.ui.Button;
import com.google.gwt.user.client.ui.FlowPanel;
import com.google.gwt.user.client.ui.RootPanel;
import com.google.gwt.user.client.ui.Widget;

public class RaiApprovalCardTests extends GWTTestCase
{
   @Override
   public String getModuleName()
   {
      return "org.rstudio.studio.RStudioTests";
   }

   private static class RecordingObserver implements RaiApprovalCard.Observer
   {
      String decision;
      String scope;
      boolean dismissed;

      @Override
      public void onDecision(String decision, String scope)
      {
         this.decision = decision;
         this.scope = scope;
      }

      @Override
      public void onDismiss()
      {
         dismissed = true;
      }
   }

   private static Button findButton(RaiApprovalCard card, String text)
   {
      for (int i = 0; i < card.getWidgetCount(); i++)
      {
         Widget child = card.getWidget(i);
         if (!(child instanceof FlowPanel))
            continue;

         FlowPanel actions = (FlowPanel) child;
         for (int j = 0; j < actions.getWidgetCount(); j++)
         {
            Widget grandchild = actions.getWidget(j);
            if (grandchild instanceof Button && text.equals(((Button) grandchild).getText()))
               return (Button) grandchild;
         }
      }
      return null;
   }

   private static void click(Button button)
   {
      NativeEvent clickEvent = Document.get().createClickEvent(
         0, 0, 0, 0, 0, false, false, false, false);
      DomEvent.fireNativeEvent(clickEvent, button);
   }

   // A live, undecided request must never be dismissable -- the Dismiss
   // button only appears after showError() reports a terminal RPC/broker
   // failure (see ChatPresenter.submitApproval()).
   public void testDismissHiddenUntilError()
   {
      RecordingObserver observer = new RecordingObserver();
      RaiApprovalCard card = new RaiApprovalCard(
         "run_r", "reason", "target", "preview", "diff", observer, "button-style");
      RootPanel.get().add(card);

      Button dismissButton = findButton(card, "Dismiss");
      assertNotNull(dismissButton);
      assertFalse(dismissButton.isVisible());

      card.showError("backend unavailable");
      assertTrue(dismissButton.isVisible());

      click(dismissButton);
      assertTrue(observer.dismissed);
      assertNull(observer.decision);

      RootPanel.get().remove(card);
   }

   public void testDecisionButtonsUnaffectedByDismissWiring()
   {
      RecordingObserver observer = new RecordingObserver();
      RaiApprovalCard card = new RaiApprovalCard(
         "run_r", "reason", "target", "preview", "diff", observer, "button-style");
      RootPanel.get().add(card);

      click(findButton(card, "Decline"));
      assertEquals("decline", observer.decision);
      assertEquals("once", observer.scope);
      assertFalse(observer.dismissed);

      RootPanel.get().remove(card);
   }
}
