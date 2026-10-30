/*
 * AssistantStatusEvent.java
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
package org.rstudio.studio.client.workbench.views.chat.events;

import org.rstudio.core.client.js.JavaScriptSerializable;
import org.rstudio.studio.client.application.events.CrossWindowEvent;

import com.google.gwt.event.shared.EventHandler;

// Reports the claude/codex CLI's busy/idle state, derived from the RAI
// bridge's pty output-activity heuristic (see rai-chat-bridge/server.js).
// Fired both from the main window (docked pane, via ChatPresenter's
// Display.Observer) and from the satellite window (popped-out pane, via
// ChatSatelliteWindow's postMessage forwarder) -- CrossWindowEvent carries
// the latter across to the main window, where GlobalToolbar listens for it
// to update the assistant toggle button's appearance either way.
@JavaScriptSerializable
public class AssistantStatusEvent
   extends CrossWindowEvent<AssistantStatusEvent.Handler>
{
   public interface Handler extends EventHandler
   {
      void onAssistantStatus(AssistantStatusEvent event);
   }

   public AssistantStatusEvent()
   {
      state_ = "";
   }

   public AssistantStatusEvent(String state)
   {
      state_ = state;
   }

   public String getState()
   {
      return state_;
   }

   @Override
   public boolean forward()
   {
      return true;
   }

   @Override
   public Type<Handler> getAssociatedType()
   {
      return TYPE;
   }

   @Override
   protected void dispatch(Handler handler)
   {
      handler.onAssistantStatus(this);
   }

   private String state_;

   public static final Type<Handler> TYPE = new Type<>();
}
