/*
 * PanmirrorPubMedServer.java
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


package org.rstudio.studio.client.panmirror.server;

import org.rstudio.core.client.promise.PromiseServerRequestCallback;
import org.rstudio.studio.client.RStudioGinjector;
import org.rstudio.studio.client.server.ServerError;
import elemental2.core.JsError;

import com.google.gwt.core.client.JavaScriptObject;
import com.google.inject.Inject;

import elemental2.promise.Promise;
import elemental2.promise.Promise.PromiseExecutorCallbackFn.RejectCallbackFn;
import elemental2.promise.Promise.PromiseExecutorCallbackFn.ResolveCallbackFn;
import jsinterop.annotations.JsType;

@JsType
public class PanmirrorPubMedServer
{
   public PanmirrorPubMedServer() {
      RStudioGinjector.INSTANCE.injectMembers(this);
   }
   
   @Inject
   void initialize(PanmirrorPubMedServerOperations server)
   {
      server_ = server;
   }
   
   public Promise<JavaScriptObject> search(String query)
   {
      return new Promise<>((ResolveCallbackFn<JavaScriptObject> resolve, RejectCallbackFn reject) -> {
         server_.pubmedSearch(
            query,
            new PromiseServerRequestCallback<JavaScriptObject>(resolve, reject) {
               @Override
               public void onResponseReceived(JavaScriptObject response)
               {
                  String status = responseStatus(response);
                  if ("error".equals(status) || "nohost".equals(status))
                  {
                     showUnavailable();
                     reject.onInvoke(new JsError("PubMed search unavailable at NCBI"));
                     return;
                  }
                  super.onResponseReceived(response);
               }

               @Override
               public void onError(ServerError error)
               {
                  showUnavailable();
                  super.onError(error);
               }
            }
         );
      });
   }

   private static void showUnavailable()
   {
      // An upstream error must not masquerade as a valid empty search.
      RStudioGinjector.INSTANCE.getGlobalDisplay().showErrorMessage(
         "PubMed search unavailable",
         "PubMed results could not be loaded from NCBI. Check your connection or try again later.");
   }

   private static native String responseStatus(JavaScriptObject response) /*-{
      return response && typeof response.status === "string" ? response.status : "";
   }-*/;

   PanmirrorPubMedServerOperations server_;
}
