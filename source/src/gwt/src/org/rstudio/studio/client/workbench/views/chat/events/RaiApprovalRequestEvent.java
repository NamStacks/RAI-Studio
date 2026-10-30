/*
 * RaiApprovalRequestEvent.java
 *
 * Copyright (C) 2026 by Posit Software, PBC
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
package org.rstudio.studio.client.workbench.views.chat.events;

import com.google.gwt.core.client.JavaScriptObject;
import com.google.gwt.event.shared.EventHandler;
import com.google.gwt.event.shared.GwtEvent;

public class RaiApprovalRequestEvent extends GwtEvent<RaiApprovalRequestEvent.Handler>
{
   public interface Handler extends EventHandler
   {
      void onRaiApprovalRequest(RaiApprovalRequestEvent event);
   }

   public static class Data extends JavaScriptObject
   {
      protected Data()
      {
      }

      // R named-list scalars can arrive as nested one-element arrays through
      // the client-event JSON bridge. Normalize all layers before the value
      // reaches the approval RPC; otherwise request_id becomes an array param
      // and the native JSON-RPC method rejects it with parameter type mismatch.
      private native String scalar(String field) /*-{
         var value = this[field];
         while ($wnd.Array.isArray(value) && value.length === 1)
            value = value[0];
         return value == null ? "" : String(value);
      }-*/;

      public final String getRequestId()
      {
         return scalar("request_id");
      }

      public final String getTool()
      {
         return scalar("tool");
      }

      public final String getReason()
      {
         return scalar("reason");
      }

      public final String getTarget()
      {
         return scalar("target");
      }

      public final String getDocumentId()
      {
         return scalar("document_id");
      }

      public final String getPreview()
      {
         return scalar("preview");
      }

      public final String getDiff()
      {
         return scalar("diff");
      }

      public final boolean getAutoApprove()
      {
         return "true".equalsIgnoreCase(scalar("auto_approve"));
      }
   }

   public RaiApprovalRequestEvent(String requestId,
                                  String tool,
                                  String reason,
                                  String target,
                                  String documentId,
                                  String preview,
                                  String diff,
                                  boolean autoApprove)
   {
      requestId_ = requestId;
      tool_ = tool;
      reason_ = reason;
      target_ = target;
      documentId_ = documentId;
      preview_ = preview;
      diff_ = diff;
      autoApprove_ = autoApprove;
   }

   public String getRequestId()
   {
      return requestId_;
   }

   public String getTool()
   {
      return tool_;
   }

   public String getReason()
   {
      return reason_;
   }

   public String getTarget()
   {
      return target_;
   }

   public String getDocumentId()
   {
      return documentId_;
   }

   public String getPreview()
   {
      return preview_;
   }

   public String getDiff()
   {
      return diff_;
   }

   public boolean getAutoApprove()
   {
      return autoApprove_;
   }

   @Override
   public Type<Handler> getAssociatedType()
   {
      return TYPE;
   }

   @Override
   protected void dispatch(Handler handler)
   {
      handler.onRaiApprovalRequest(this);
   }

   public static final Type<Handler> TYPE = new Type<>();

   private final String requestId_;
   private final String tool_;
   private final String reason_;
   private final String target_;
   private final String documentId_;
   private final String preview_;
   private final String diff_;
   private final boolean autoApprove_;
}
