/*
 * ChatServerOperations.java
 *
 * Copyright (C) 2025 by Posit Software, PBC
 *
 * This program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */
package org.rstudio.studio.client.workbench.views.chat.server;

import org.rstudio.core.client.js.JsObject;
import org.rstudio.studio.client.server.ServerRequestCallback;
import org.rstudio.studio.client.server.VoidResponse;

import com.google.gwt.core.client.JavaScriptObject;
import com.google.gwt.core.client.JsArray;

import jsinterop.annotations.JsPackage;
import jsinterop.annotations.JsType;

public interface ChatServerOperations
{
   @JsType(isNative = true, namespace = JsPackage.GLOBAL, name = "Object")
   public static class ChatVerifyInstalledResponse
   {
      public boolean installed;
      public String version;
   }

   // RAI Assistant: ask the session for the local bridge URL. Response is
   // { status: "ready"|"starting"|"not_found", url, message }.
   public void raiGetBridgeUrl(ServerRequestCallback<JsObject> requestCallback);
   public void raiRestartBridge(ServerRequestCallback<JsObject> requestCallback);

   // RAI Assistant: hard reset. SIGKILLs a wedged/orphaned bridge, clears its
   // state, and starts a fresh one in the active project directory. Works even
   // when the iframe, WebSocket, or bridge is dead. Response is
   // { status: "starting"|"not_found"|"error", message }.
   public void raiResetBridge(ServerRequestCallback<JsObject> requestCallback);
   public void raiDocumentEditAck(String operationId, boolean accepted, String contents,
                                  ServerRequestCallback<JsObject> requestCallback);
   public void raiSubmitApproval(String requestId, String decision, String scope,
                                 ServerRequestCallback<JsObject> requestCallback);

   // RAI Assistant: open/focus a real Terminal.app window running claude/codex,
   // wired to this session's MCP console bridge. Response is
   // { status: "ok"|"error", message }.
   public void raiOpenTerminal(ServerRequestCallback<JsObject> requestCallback);

   // RAI Assistant: read ~/.raistudio/assistant.json for the settings dialog.
   // Response is the full config object; the dialog reads provider/providers.
   public void raiGetSettings(ServerRequestCallback<JsObject> requestCallback);

   // RAI Assistant: persist the chosen provider back to
   // ~/.raistudio/assistant.json. Response is
   // { status: "ok"|"error", message }.
   public void raiSetSettings(String provider,
                              ServerRequestCallback<JsObject> requestCallback);

   // RAI Assistant: persist the "keep terminal awake" (caffeinate) toggle
   // back to ~/.raistudio/assistant.json. The bridge observes this file and
   // updates the active CLI assertion without restarting that CLI. Response is
   // { status: "ok"|"error", message }.
   public void raiSetCaffeinate(boolean caffeinate,
                                ServerRequestCallback<JsObject> requestCallback);

   // RAI Assistant: persist the on-by-default Console auto-approval toggle
   // to ~/.raistudio/assistant.json. Enabled permits parser-valid,
   // session-safe R Console proposals; exact open-document replacements still
   // require human approval. Response is { status: "ok"|"error", message }.
   public void raiSetAutoApproveReadOnly(boolean enabled,
                                        ServerRequestCallback<JsObject> requestCallback);

   public void chatVerifyInstalled(ServerRequestCallback<ChatVerifyInstalledResponse> requestCallback);
   public void chatStartBackend(ServerRequestCallback<JsObject> requestCallback);
   public void chatStopBackend(ServerRequestCallback<JsObject> requestCallback);
   public void chatGetBackendUrl(ServerRequestCallback<JsObject> requestCallback);
   public void chatGetBackendStatus(ServerRequestCallback<JsObject> requestCallback);
   public void chatGetVersion(ServerRequestCallback<String> requestCallback);

   public void chatCheckForUpdates(boolean forceRecheck,
                                   ServerRequestCallback<JsObject> requestCallback);

   /**
    * Install (non-null object) or clear (null) an automation-only override
    * that pins the next chat_check_for_updates response to a specific shape.
    * Used by Playwright tests to drive each blocking branch deterministically
    * -- Playwright route.fulfill produces status=0 in dev-mode Electron so an
    * in-rsession override is the only path that reliably reaches
    * ChatPresenter's blocking callbacks.
    */
   public void chatSetUpdateCheckOverride(JavaScriptObject override,
                                          ServerRequestCallback<JavaScriptObject> requestCallback);
   public void chatInstallUpdate(ServerRequestCallback<VoidResponse> requestCallback);
   public void chatGetUpdateStatus(ServerRequestCallback<JsObject> requestCallback);

   public void chatDocFocused(String documentId, ServerRequestCallback<VoidResponse> requestCallback);
   public void chatDocFocused(String documentId, JsArray<JavaScriptObject> selections,
                              ServerRequestCallback<VoidResponse> requestCallback);

   public void chatNotifyUILoaded(ServerRequestCallback<VoidResponse> requestCallback);

   public void chatUninstallPositAssistant(ServerRequestCallback<VoidResponse> requestCallback);
}
