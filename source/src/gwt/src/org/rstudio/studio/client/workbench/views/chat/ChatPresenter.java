/*
 * ChatPresenter.java
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
package org.rstudio.studio.client.workbench.views.chat;

import org.rstudio.core.client.Debug;
import org.rstudio.core.client.Point;
import org.rstudio.core.client.Size;
import org.rstudio.core.client.StringUtil;
import org.rstudio.core.client.command.CommandBinder;
import org.rstudio.core.client.command.Handler;
import org.rstudio.core.client.dom.WindowCloseMonitor;
import org.rstudio.core.client.dom.WindowEx;
import org.rstudio.core.client.js.JsObject;
import org.rstudio.studio.client.application.ApplicationQuit;
import org.rstudio.studio.client.application.Desktop;
import org.rstudio.studio.client.application.events.EventBus;
import org.rstudio.studio.client.application.events.SessionSerializationEvent;
import org.rstudio.studio.client.application.model.SessionSerializationAction;
import org.rstudio.studio.client.common.GlobalDisplay;
import org.rstudio.studio.client.common.satellite.SatelliteManager;
import org.rstudio.studio.client.common.satellite.events.SatelliteClosedEvent;
import org.rstudio.studio.client.common.satellite.model.SatelliteWindowGeometry;
import org.rstudio.studio.client.projects.ui.prefs.events.ProjectOptionsChangedEvent;
import org.rstudio.studio.client.server.ServerError;
import org.rstudio.studio.client.server.ServerRequestCallback;
import org.rstudio.studio.client.server.VoidResponse;
import org.rstudio.studio.client.server.VoidServerRequestCallback;
import org.rstudio.studio.client.workbench.WorkbenchView;
import org.rstudio.studio.client.workbench.commands.Commands;
import org.rstudio.studio.client.workbench.events.LastChanceSaveEvent;
import org.rstudio.studio.client.workbench.model.ClientState;
import org.rstudio.studio.client.workbench.model.Session;
import org.rstudio.studio.client.workbench.model.helper.JSObjectStateValue;
import org.rstudio.studio.client.workbench.prefs.model.UserPrefs;
import org.rstudio.studio.client.workbench.ui.PaneManager;
import org.rstudio.studio.client.workbench.views.BasePresenter;
import org.rstudio.studio.client.workbench.views.chat.events.AssistantStatusEvent;
import org.rstudio.studio.client.workbench.views.chat.events.ChatBackendExitEvent;
import org.rstudio.studio.client.workbench.views.chat.events.ChatPaneActiveEvent;
import org.rstudio.studio.client.workbench.views.chat.events.ChatReturnToMainEvent;
import org.rstudio.studio.client.workbench.views.chat.events.ChatSatelliteActionEvent;
import org.rstudio.studio.client.workbench.views.chat.events.RaiApprovalRequestEvent;
import org.rstudio.studio.client.workbench.views.chat.model.ChatSatelliteParams;
import org.rstudio.studio.client.workbench.views.chat.server.ChatServerOperations;
import org.rstudio.studio.client.workbench.views.console.events.ConsolePromptEvent;
import org.rstudio.studio.client.workbench.views.console.events.ConsoleReadCompletedEvent;
import org.rstudio.studio.client.workbench.views.source.SourceColumnManager;
import org.rstudio.studio.client.workbench.views.source.editors.EditingTarget;
import org.rstudio.studio.client.workbench.views.source.editors.text.TextEditingTarget;

import java.util.LinkedList;
import java.util.Queue;

import com.google.gwt.core.client.Scheduler;
import com.google.gwt.core.client.Scheduler.RepeatingCommand;
import com.google.gwt.http.client.URL;
import com.google.gwt.json.client.JSONString;
import com.google.gwt.json.client.JSONValue;
import com.google.inject.Inject;

public class ChatPresenter extends BasePresenter
   implements ConsolePromptEvent.Handler,
              ConsoleReadCompletedEvent.Handler,
              SatelliteClosedEvent.Handler,
              ChatReturnToMainEvent.Handler,
              ChatSatelliteActionEvent.Handler
{
   public interface Binder extends CommandBinder<Commands, ChatPresenter>
   {
   }

   public interface Display extends WorkbenchView
   {
      enum Status
      {
         STARTING,
         RESTARTING,
         NOT_INSTALLED,
         ERROR,
         READY,
         ASSISTANT_NOT_SELECTED
      }

      interface Observer
      {
         void onPaneReady();
         void onRestartBackend();
         void onRestartTerminal();
         void onResetAssistant();
         void onRetryManifest();
         void onActivateChat();
         void onReturnChatToMain();
         void onIframeError(String message);
         void onIframeWarning(String message);
         void onIframeConnected();
         void onAssistantStatus(String state);
         void onToggleCaffeinate(boolean caffeinate);
      }

      interface UpdateObserver
      {
         void onUpdateNow();
         void onRemindLater();
         void onRetryUpdate();
      }

      void setObserver(Observer observer);
      void setUpdateObserver(UpdateObserver observer);
      void setStatus(Status status);
      void setCaffeinate(boolean caffeinate);
      void setCaffeinateLeaseStart(double epochMillis);
      void openRaiSettings();
      boolean hasChatFrameForUrl(String url);
      void showError(String errorMessage);
      void showMessage(String message);
      void loadUrl(String url);
      void showNotInstalledWithInstall(String newVersion,
                                       boolean additionalProvidersAvailable);
      void showUpdateAvailableWithVersions(String currentVersion, String newVersion,
                                            boolean isDowngrade);
      void showUpdatingStatus();
      void showUpdateComplete();
      void showUpdateError(String errorMessage);
      void showUpdateCheckFailure();
      void hideUpdateNotification();
      void hideErrorNotification();
      void showCrashedMessage(int exitCode);
      void showSuspendedMessage();
      void clearSuspendedMessage();
      void showIncompatibleVersion();
      void showUnsupportedVersionUpgradeRequired(String currentVersion, String newVersion);
      void showUnsupportedVersionNoUpdate(String currentVersion);
      void showUnsupportedProtocol();
      void showManifestUnavailable(String errorMessage);
      void showConnectionLostNotification(String message);
      void hideConnectionLostNotification();
      void showReadlineNotification();
      void hideReadlineNotification();
      void showApprovalCard(String requestId, String tool, String reason, String target,
                            String preview, String diff, RaiApprovalCard.Observer observer);
      void setApprovalSubmitting(String requestId, boolean submitting);
      void showApprovalError(String requestId, String message);
      void hideApprovalCard(String requestId);

      void showPoppedOutPlaceholder();
      void hidePoppedOutPlaceholder();

      String getNotInstalledWithInstallHTML(String newVersion,
                                            boolean additionalProvidersAvailable);
      String getUpdateAvailableWithVersionsHTML(
         String currentVersion, String newVersion, boolean isDowngrade);
      String getMessageHTML(String message);
      String getIncompatibleVersionHTML();
      String getUnsupportedVersionUpgradeHTML(
         String currentVersion, String newVersion);
      String getUnsupportedVersionNoUpdateHTML(String currentVersion);
      String getUnsupportedProtocolHTML();
      String getManifestUnavailableHTML(String errorMessage);
      String getErrorHTML(String errorMessage);
   }

   public static class Chat
   {
      public Chat()
      {
      }
   }

   @Inject
   protected ChatPresenter(
      Display display,
      EventBus events,
      Commands commands,
      Binder binder,
      ChatServerOperations server,
      PaiUtil paiUtil,
      UserPrefs prefs,
      SatelliteManager satelliteManager,
      PaneManager paneManager,
      Session session,
      GlobalDisplay globalDisplay,
      ApplicationQuit applicationQuit,
      SourceColumnManager sourceColumnManager)
   {
      super(display);
      binder.bind(commands, this);
      display_ = display;
      events_ = events;
      commands_ = commands;
      server_ = server;
      paiUtil_ = paiUtil;
      prefs_ = prefs;
      installManager_ = new PositAiInstallManager();
      satelliteManager_ = satelliteManager;
      paneManager_ = paneManager;
      session_ = session;
      globalDisplay_ = globalDisplay;
      applicationQuit_ = applicationQuit;
      sourceColumnManager_ = sourceColumnManager;

      // Set up observer
      display_.setObserver(new Display.Observer()
      {
         @Override
         public void onPaneReady()
         {
            if (poppedOut_)
            {
               if (cachedUrl_ != null)
               {
                  // Satellite already open — show placeholder now that
                  // the pane is in the DOM.
                  display_.showPoppedOutPlaceholder();
                  display_.setStatus(Display.Status.READY);
               }
               // else: backend still starting from eager init — let it
               // finish; initializing_ guard prevents re-entry
               return;
            }
            initializeChat();
         }

         @Override
         public void onRestartBackend()
         {
            // The crashed / connection-lost "Restart" actions mean the bridge is
            // dead or unreachable, so recover it with the RAI hard reset. This
            // never touches the legacy Posit chat_start_backend path.
            resetAssistant();
         }

         @Override
         public void onRestartTerminal()
         {
            restartTerminal();
         }

         @Override
         public void onResetAssistant()
         {
            resetAssistant();
         }

         @Override
         public void onRetryManifest()
         {
            if (initializing_)
               return;
            initializing_ = true;
            checkForUpdates(true);
         }

         @Override
         public void onActivateChat()
         {
            ChatPresenter.this.onActivateChat();
         }

         @Override
         public void onReturnChatToMain()
         {
            returnChatToMain();
         }

         @Override
         public void onIframeError(String message)
         {
            Debug.log("Chat iframe error: " + message);
            display_.showConnectionLostNotification(message);
         }

         @Override
         public void onIframeWarning(String message)
         {
            Debug.log("Chat iframe warning: " + message);
         }

         @Override
         public void onIframeConnected()
         {
            display_.hideConnectionLostNotification();
         }

         @Override
         public void onAssistantStatus(String state)
         {
            // Relayed to GlobalToolbar (which owns the assistant toggle
            // button) via the EventBus rather than handled here directly --
            // ChatPresenter has no reference to that widget. The same event
            // also carries the status across from the popped-out satellite
            // window; see ChatSatelliteWindow.
            events_.fireEvent(new AssistantStatusEvent(state));
         }

         @Override
         public void onToggleCaffeinate(boolean caffeinate)
         {
            // Only edits ~/.raistudio/assistant.json; applies to the next
            // terminal session, same as a provider change from the gear
            // dialog. A live pty is deliberately left running.
            server_.raiSetCaffeinate(caffeinate, new ServerRequestCallback<JsObject>()
            {
               @Override
               public void onResponseReceived(JsObject response)
               {
                  String status = response.getString("status");
                  if (!StringUtil.equals(status, "ok"))
                  {
                     String detail = response.hasKey("message")
                        ? response.getString("message") : "";
                     globalDisplay_.showErrorMessage(
                        constants_.raiSettingsTitle(), detail);
                  }
               }

               @Override
               public void onError(ServerError error)
               {
                  globalDisplay_.showErrorMessage(
                     constants_.raiSettingsTitle(), error.getUserMessage());
               }
            });
         }
      });

      // Set up update observer
      display_.setUpdateObserver(new Display.UpdateObserver()
      {
         @Override
         public void onUpdateNow()
         {
            installUpdate();
         }

         @Override
         public void onRemindLater()
         {
            display_.hideUpdateNotification();
            // User wants to use current version - start backend now
            startBackend();
         }

         @Override
         public void onRetryUpdate()
         {
            installUpdate();
         }
      });

      // Listen for console prompt events (to detect when R is waiting for input)
      events_.addHandler(ConsolePromptEvent.TYPE, this);

      // Listen for console read completion (to dismiss notification after readline)
      events_.addHandler(ConsoleReadCompletedEvent.TYPE, this);

      events_.addHandler(RaiApprovalRequestEvent.TYPE, this::onRaiApprovalRequest);

      // Listen for backend exit events (crashes)
      events_.addHandler(ChatBackendExitEvent.TYPE, new ChatBackendExitEvent.Handler()
      {
         @Override
         public void onChatBackendExit(ChatBackendExitEvent event)
         {
            display_.hideReadlineNotification();
            if (event.getCrashed())
            {
               cachedUrl_ = null;
               if (poppedOut_)
               {
                  updateSavedGeometry();
                  satelliteManager_.closeSatelliteWindow(ChatSatellite.NAME);
               }
               display_.showCrashedMessage(event.getExitCode());
               setAutomationChatState("crashed", true);
            }
         }
      });

      // Listen for session suspension/resume events
      events_.addHandler(SessionSerializationEvent.TYPE, new SessionSerializationEvent.Handler()
      {
         @Override
         public void onSessionSerialization(SessionSerializationEvent event)
         {
            int action = event.getAction().getType();
            if (action == SessionSerializationAction.SUSPEND_SESSION)
            {
               backendPollGeneration_++; // invalidate existing poll callbacks
               display_.hideReadlineNotification();
               if (poppedOut_)
               {
                  // Save geometry; satellite stays open and shows its own
                  // suspend overlay via SessionSerializationEvent forwarding
                  updateSavedGeometry();
               }
               // Only dim the chat UI if it was actually loaded and running.
               // If chat was never initialized (e.g., sidebar hidden at startup),
               // there's nothing meaningful to dim.
               if (cachedUrl_ != null)
               {
                  display_.showSuspendedMessage();
               }
            }
            else if (action == SessionSerializationAction.RESUME_SESSION)
            {
               backendPollGeneration_++;
               boolean wasActive = initializing_ || cachedUrl_ != null;
               initializing_ = false;
               if (poppedOut_ && cachedUrl_ != null)
                  updateSavedGeometry();
               // RAI bridge is the sole assistant surface: the bridge child exits
               // with the session, so a previously-active pane always needs a fresh
               // rai_get_bridge_url round-trip. If the pane was never initialized
               // (e.g. sidebar hidden), leave startup to onPaneReady — do not spawn
               // the bridge eagerly on every resume.
               if (wasActive)
                  initializeChat();
            }
         }
      });

      // Listen for satellite closed events
      events_.addHandler(SatelliteClosedEvent.TYPE, this);

      // Track when the application is quitting so we don't reset poppedOut_
      // during shutdown. LastChanceSaveEvent fires early in the GWT quit flow,
      // before any windows close, so this flag is set regardless of which
      // window had focus when the user pressed Cmd+Q.
      events_.addHandler(LastChanceSaveEvent.TYPE,
         (LastChanceSaveEvent event) -> windowsClosing_ = true);

      // Listen for chat return-to-main events from satellite
      events_.addHandler(ChatReturnToMainEvent.TYPE, this);

      // Listen for satellite iframe action events (button clicks in
      // install/update/error views)
      events_.addHandler(ChatSatelliteActionEvent.TYPE, this);

      // Listen for chat provider preference changes (global setting)
      prefs_.chatProvider().addValueChangeHandler((event) ->
      {
         onChatProviderChanged();
      });

      // Listen for project options changes (project-level setting).
      // Explicitly update PaiUtil's cache before reading the provider so
      // we don't depend on EventBus handler registration order.
      events_.addHandler(ProjectOptionsChangedEvent.TYPE, (event) ->
      {
         paiUtil_.updateProjectOptions(event.getData().getAssistantOptions());
         onChatProviderChanged();
      });

      // Persist pop-out state and satellite geometry across sessions
      new JSObjectStateValue(
         "chat-window",
         "chatSatelliteState",
         ClientState.PROJECT_PERSISTENT,
         session.getSessionInfo().getClientState(),
         false)
      {
         @Override
         protected void onInit(JsObject value)
         {
            if (value != null)
            {
               // RAI-Studio: the assistant terminal is always embedded in
               // the main window -- never restore a persisted pop-out into
               // a separate satellite window, even if an earlier session
               // left "poppedOut": true in client state.
               if (value.hasKey("geometry"))
                  savedGeometry_ = value.getObject("geometry").cast();
            }
         }

         @Override
         protected JsObject getValue()
         {
            // Capture live geometry from the satellite window if it's open
            if (poppedOut_)
               updateSavedGeometry();

            stateDirty_ = false;

            JsObject state = JsObject.createJsObject();
            state.setBoolean("poppedOut", poppedOut_);
            if (savedGeometry_ != null)
               state.setObject("geometry", savedGeometry_);
            return state;
         }

         @Override
         protected boolean hasChanged()
         {
            return stateDirty_;
         }
      };
   }

   // When the console prompt fires while R is busy (i.e. executing code rather
   // than at the top-level REPL), it means something mid-execution is requesting
   // user input (e.g. readline, browser, scan). Show a notification so the user
   // knows to respond in the Console.
   //
   // NOTE: This intentionally triggers for all mid-execution prompts, not just
   // AI-initiated ones. A browser() or readline() call is worth surfacing even
   // if it wasn't triggered by the assistant, since the user may need to act.
   //
   // TODO: When Posit Assistant gains support for handling input requests
   // directly, we should signal the assistant here instead of (or in
   // addition to) showing a passive notification.
   // https://github.com/posit-dev/databot/issues/770
   @Override
   public void onConsolePrompt(ConsolePromptEvent event)
   {
      if (event.getPrompt().getBusy())
         display_.showReadlineNotification();
      else
         display_.hideReadlineNotification();
   }

   // When console input is received for a sub-prompt (readline, scan, etc.),
   // dismiss the notification immediately rather than waiting for R to return
   // to the top-level REPL. Browser prompts are not handled here because they
   // add to history; they are dismissed by onConsolePrompt() instead.
   @Override
   public void onConsoleReadCompleted(ConsoleReadCompletedEvent event)
   {
      if (!event.getHistory())
         display_.hideReadlineNotification();
   }

   @Override
   public void onSatelliteClosed(SatelliteClosedEvent event)
   {
      if (!ChatSatellite.NAME.equals(event.getName()) || !poppedOut_)
         return;

      // On Chrome, the satellite window is reloaded via window.open(url,
      // name) (see WebWindowOpener.doOpenWindow) instead of reactivated
      // in-place. The old content's unload handler fires a spurious
      // SatelliteClosedEvent even though the window is still open. Use
      // WindowCloseMonitor to poll the window and distinguish a real close
      // from a reload — the same pattern used by SourceWindowManager,
      // ShinyApplication, and PlumberAPI.
      //
      // The windowsClosing_ guard is still necessary: during Cmd+Q the
      // satellite closes for real and the callback fires, but
      // returnChatToMain() must be suppressed because the application is
      // shutting down (LastChanceSaveEvent sets windowsClosing_ early in
      // the quit flow).
      WindowCloseMonitor.monitorSatelliteClosure(
         ChatSatellite.NAME,
         () -> {
            if (!windowsClosing_)
               returnChatToMain();
            else
               events_.fireEvent(new ChatPaneActiveEvent(false));
         },
         null);
   }

   @Override
   public void onChatReturnToMain(ChatReturnToMainEvent event)
   {
      returnChatToMain();
   }

   @Override
   public void onChatSatelliteAction(ChatSatelliteActionEvent event)
   {
      String action = event.getAction();
      switch (action)
      {
         case "install-now":
            installUpdate();
            break;
         case "remind-later":
            display_.hideUpdateNotification();
            startBackend();
            break;
         case "restart-backend":
            resetAssistant();
            break;
         case "open-global-options":
            commands_.showAssistantOptions().execute();
            break;
         case "retry-manifest":
            if (initializing_)
               break;
            initializing_ = true;
            checkForUpdates(true);
            break;
         default:
            Debug.log("Unrecognized chat satellite action: " + action);
            break;
      }
   }

   @Handler
   // RAI-Studio: the assistant terminal must always be embedded in the
   // main window, never a separate satellite window. Redirect "pop out"
   // to just showing the embedded cover instead of opening a satellite.
   void onPopOutChat()
   {
      paneManager_.toggleAssistantCover();
   }

   // The native gear opens the single themed settings transaction.
   // No provider reset, native modal, or unrelated toggle writes occur here.
   @Handler
   void onRaiAssistantSettings()
   {
      // The toolbar exists before the bridge iframe. Initialize on demand,
      // without resetting an existing session; the view waits for its frame.
      // Probe existing helper health; cached URLs may refer to a stopped helper.
      // The healthy same-frame branch never reloads or interrupts its session.
      paneManager_.revealSidebar();
      initializeChat();
      display_.openRaiSettings();
   }

   @Handler
   void onReturnChatToMain()
   {
      returnChatToMain();
   }

   // No @Handler: bound via ChatTab.Shim so the command works before the
   // presenter is delay-loaded.
   void onUninstallPositAssistant()
   {
      globalDisplay_.showYesNoMessage(
         GlobalDisplay.MSG_WARNING,
         constants_.uninstallPositAssistantCaption(),
         constants_.uninstallPositAssistantMessage(),
         () -> performUninstall(),
         false);
   }

   private void performUninstall()
   {
      server_.chatUninstallPositAssistant(new ServerRequestCallback<VoidResponse>()
      {
         @Override
         public void onResponseReceived(VoidResponse response)
         {
            // doRestart() is cancelable (user can decline to save unsaved
            // changes). If canceled, PAI files are already deleted but the
            // session continues unrestarted — an acceptable edge case
            // consistent with other RStudio restart flows.
            applicationQuit_.doRestart(session_);
         }

         @Override
         public void onError(ServerError error)
         {
            // Backend delivers user-facing text via client_info; fall back
            // to the generic user message when no client_info is provided.
            String message = error.getUserMessage();
            JSONValue clientInfo = error.getClientInfo();
            if (clientInfo != null)
            {
               JSONString clientInfoStr = clientInfo.isString();
               if (clientInfoStr != null)
                  message = clientInfoStr.stringValue();
            }
            globalDisplay_.showErrorMessage(
               constants_.uninstallPositAssistantCaption(),
               message);
         }
      });
   }

   // No @Handler: bound via ChatTab.Shim so the command works before the
   // presenter is delay-loaded (e.g. sidebar hidden at startup).
   //
   // RAI-Studio: the assistant terminal must always be embedded in the
   // main window, never a separate satellite window -- ignore poppedOut_
   // (which can be stuck true from a stale persisted client-state value)
   // rather than route through satelliteManager_.
   void onActivateChat()
   {
      paneManager_.activateTab(PaneManager.Tab.Chat);
   }

   // No @Handler: bound via ChatTab.Shim so the command works before the
   // presenter is delay-loaded.
   void onAssistantPaneToggle()
   {
      // The Assistant is an exclusive right-side cover. Let PaneManager
      // determine visibility rather than inferring it from the selected
      // sidebar tab, which remains selected while the cover is hidden.
      paneManager_.toggleAssistantCover();
   }

   // Opens or focuses a real Terminal.app window running claude/codex, wired
   // to this session's MCP console bridge. Not currently wired to any
   // command -- the embedded xterm.js pane (above) is the active surface
   // for now; kept ready to resume once the Terminal.app path is fully
   // verified.
   private void openRaiTerminal()
   {
      server_.raiOpenTerminal(new ServerRequestCallback<JsObject>()
      {
         @Override
         public void onResponseReceived(JsObject response)
         {
            String status = response.getString("status");
            if (!StringUtil.equals(status, "ok"))
            {
               String detail = response.hasKey("message") ? response.getString("message") : "";
               globalDisplay_.showErrorMessage(constants_.raiNotFoundTitle(), detail);
            }
         }

         @Override
         public void onError(ServerError error)
         {
            globalDisplay_.showErrorMessage(constants_.raiNotFoundTitle(), error.getUserMessage());
         }
      });
   }

   private static final Size DEFAULT_SATELLITE_SIZE = new Size(500, 700);

   /**
    * Opens or reactivates the satellite window with the given parameters,
    * using saved geometry if available.
    */
   private void openChatSatellite(ChatSatelliteParams params)
   {
      Size size = (savedGeometry_ != null)
         ? savedGeometry_.getSize()
         : DEFAULT_SATELLITE_SIZE;
      Point position = (savedGeometry_ != null)
         ? savedGeometry_.getPosition()
         : null;
      boolean adjustSize = (savedGeometry_ == null);
      satelliteManager_.openSatellite(
         ChatSatellite.NAME,
         params,
         size,
         adjustSize,
         position);
   }

   /**
    * Opens or reactivates the satellite window with the given HTML content.
    */
   private void showHtmlInSatellite(String html)
   {
      openChatSatellite(ChatSatelliteParams.createWithHtml(html));
   }

   /**
    * Displays an error in the satellite (as HTML) or the main pane (via
    * display), and resets initialization state.
    */
   private void showErrorMessage(String errorMessage)
   {
      initializing_ = false;
      if (poppedOut_)
      {
         showHtmlInSatellite(display_.getErrorHTML(errorMessage));
      }
      else
      {
         display_.setStatus(Display.Status.ERROR);
         display_.showError(errorMessage);
      }
      setAutomationChatState("error", true);
   }

   /**
    * Displays content in the satellite (as HTML) or the main pane (via the
    * given action), and resets initialization state. Used for non-error
    * informational views (install prompts, version warnings, etc.).
    */
   private void showInDisplayOrSatellite(String satelliteHtml,
                                         Runnable displayAction)
   {
      initializing_ = false;
      if (poppedOut_)
      {
         showHtmlInSatellite(satelliteHtml);
      }
      else
      {
         displayAction.run();
      }
   }

   /**
    * Resets popped-out state when initialization fails before the satellite
    * could be opened (e.g. backend error, provider not selected).
    */
   private void cancelPopOut()
   {
      if (poppedOut_)
      {
         poppedOut_ = false;
         stateDirty_ = true;
         commands_.popOutChat().setEnabled(true);
         display_.hidePoppedOutPlaceholder();
      }
   }

   private void updateSavedGeometry()
   {
      WindowEx window = satelliteManager_.getSatelliteWindowObject(
         ChatSatellite.NAME);
      if (window != null)
      {
         // In desktop mode, use outer dimensions because Electron's
         // setSize() sets the outer window size including title bar.
         // In web mode, use inner dimensions because window.open()
         // width/height set the content area size.
         int width = Desktop.hasDesktopFrame()
            ? window.getOuterWidth()
            : window.getInnerWidth();
         int height = Desktop.hasDesktopFrame()
            ? window.getOuterHeight()
            : window.getInnerHeight();
         savedGeometry_ = SatelliteWindowGeometry.create(
            0,
            window.getScreenX(),
            window.getScreenY(),
            width,
            height);
         stateDirty_ = true;
      }
   }

   private void returnChatToMain()
   {
      if (!poppedOut_)
      {
         return;
      }

      updateSavedGeometry();
      poppedOut_ = false;
      stateDirty_ = true;
      commands_.popOutChat().setEnabled(true);
      satelliteManager_.closeSatelliteWindow(ChatSatellite.NAME);
      display_.hidePoppedOutPlaceholder();

      // Reload chat in the main window
      if (cachedUrl_ != null)
      {
         display_.loadUrl(cachedUrl_);
         display_.setStatus(Display.Status.READY);
      }
      else
      {
         // Backend wasn't initialized yet (e.g. pop-out triggered before
         // backend was ready). Re-initialize to load chat in the main pane.
         initializeChat();
      }

      // Ensure the chat pane is visible — handles both sidebar and
      // quadrant configurations correctly
      onActivateChat();

      events_.fireEvent(new ChatPaneActiveEvent(paneManager_.isChatActivatedInSidebar()));
   }

   /**
    * Called when either global chat provider preference or project options change.
    * Re-evaluates whether chat should be enabled based on the effective provider.
    */
   private void onChatProviderChanged()
   {
      // RAI-Studio: the docked terminal is the assistant surface regardless of
      // the legacy chatProvider pref. Keep the bridge loaded; the terminal's
      // own gear selects the CLI provider/model.
      if (cachedUrl_ == null && !initializing_)
         initializeChat();
   }

   private void onRaiApprovalRequest(RaiApprovalRequestEvent event)
   {
      String requestId = event.getRequestId();
      if (StringUtil.isNullOrEmpty(requestId) ||
          requestId.equals(approvalRequestId_) ||
          isApprovalQueued(requestId))
         return;

      // Distinct requests queue FIFO behind whatever request is active --
      // a visible card or an in-flight automatic apply is never silently
      // replaced by a newer one. The next queued request is processed once
      // the active one resolves (see submitApprovalRpc()).
      if (approvalRequestId_ == null)
         processApprovalRequest(event);
      else
         approvalQueue_.add(event);
   }

   // Full Auto requests (server-marked auto_approve) are settled without a
   // card: the same trusted native approval RPC runs, so every native
   // identity/anchor/stale/audit check still applies at apply time, and a
   // rejection is reported to the tool caller by the server, not by a card.
   private void processApprovalRequest(RaiApprovalRequestEvent event)
   {
      if (event.getAutoApprove())
      {
         approvalRequestId_ = event.getRequestId();
         approvalAutomatic_ = true;
         approvalSubmitting_ = false;
         submitApproval(event, "allow", "once");
         return;
      }
      showApprovalRequest(event);
   }

   private boolean isApprovalQueued(String requestId)
   {
      for (RaiApprovalRequestEvent queued : approvalQueue_)
         if (requestId.equals(queued.getRequestId()))
            return true;
      return false;
   }

   private void showApprovalRequest(RaiApprovalRequestEvent event)
   {
      approvalRequestId_ = event.getRequestId();
      approvalAutomatic_ = false;
      approvalSubmitting_ = false;
      // A preceding plot can reveal Plots and hide the retained Assistant cover.
      // Revealing the sidebar for a required approval is idempotent, and unlike
      // activateChat it neither toggles the cover off nor moves focus.
      paneManager_.revealSidebar();
      display_.showApprovalCard(approvalRequestId_,
                                event.getTool(),
                                event.getReason(),
                                event.getTarget(),
                                event.getPreview(),
                                event.getDiff(),
                                new RaiApprovalCard.Observer()
                                {
                                   @Override
                                   public void onDecision(String decision, String scope)
                                   {
                                      submitApproval(event, decision, scope);
                                   }

                                   @Override
                                   public void onDismiss()
                                   {
                                      dismissApproval(event.getRequestId());
                                   }
                                });
   }

   private void showNextQueuedApproval()
   {
      RaiApprovalRequestEvent next = approvalQueue_.poll();
      if (next != null)
         processApprovalRequest(next);
   }

   private void clearPendingApprovalsForReset()
   {
      if (approvalRequestId_ != null)
         display_.hideApprovalCard(approvalRequestId_);
      approvalRequestId_ = null;
      approvalAutomatic_ = false;
      approvalSubmitting_ = false;
      approvalQueue_.clear();
   }

   // Only reachable from the card's Dismiss button, which only appears once
   // submitApproval() has shown a terminal error (RPC failure, or a
   // non-granted/declined broker response -- e.g. the request is now unknown
   // to the broker after an R session reset). Never called for a live,
   // undecided request, so this can't be used to silently skip a decision.
   private void dismissApproval(String requestId)
   {
      if (!requestId.equals(approvalRequestId_))
         return;

      display_.hideApprovalCard(requestId);
      approvalRequestId_ = null;
      approvalSubmitting_ = false;
      showNextQueuedApproval();
   }

   private void submitApproval(RaiApprovalRequestEvent event, String decision, String scope)
   {
      String requestId = event.getRequestId();
      if (!requestId.equals(approvalRequestId_) || approvalSubmitting_)
         return;

      // The UI only ever says "allow this pending request at this scope" or
      // "decline it" -- the server derives tool/target from the pre-stored
      // request itself, so there is nothing here for the client to
      // reconstruct (and nothing it could use to broaden the grant).
      approvalSubmitting_ = true;
      display_.setApprovalSubmitting(requestId, true);
      if ("allow".equals(decision) && "edit_document".equals(event.getTool()))
      {
         EditingTarget target = sourceColumnManager_.findEditor(event.getDocumentId());
         if (target instanceof TextEditingTarget)
         {
            // Flush the authoritative open-buffer state to the session database
            // without writing to disk, then revalidate the pinned edit natively.
            ((TextEditingTarget) target).withSavedDoc(() ->
               submitApprovalRpc(requestId, decision, scope));
            return;
         }
      }
      submitApprovalRpc(requestId, decision, scope);
   }

   private void submitApprovalRpc(String requestId, String decision, String scope)
   {
      server_.raiSubmitApproval(requestId, decision, scope,
         new ServerRequestCallback<JsObject>()
         {
            @Override
            public void onResponseReceived(JsObject response)
            {
               if (!requestId.equals(approvalRequestId_))
                  return;

               String status = response == null || !response.hasKey("status")
                  ? ""
                  : response.getString("status");
               // A successful run_r approval returns "queued" after its exact
               // proposal has been atomically registered and handed to native
               // Console enqueue. It is terminal for this card just like a
               // generic grant or decline; errors remain visible for dismissal.
               if ("granted".equals(status) || "queued".equals(status) ||
                   "applied".equals(status) || "declined".equals(status) ||
                   approvalAutomatic_)
               {
                  // An automatic request has no card to hold an error; the
                  // server records the rejection for the polling tool call.
                  display_.hideApprovalCard(requestId);
                  approvalRequestId_ = null;
                  approvalAutomatic_ = false;
                  approvalSubmitting_ = false;
                  showNextQueuedApproval();
                  return;
               }

               approvalSubmitting_ = false;
               String message = response != null && response.hasKey("message")
                  ? response.getString("message")
                  : "Approval request was not accepted.";
               display_.showApprovalError(requestId, message);
            }

            @Override
            public void onError(ServerError error)
            {
               if (!requestId.equals(approvalRequestId_))
                  return;

               if (approvalAutomatic_)
               {
                  Debug.log("RAI automatic approval RPC failed: " + error.getUserMessage());
                  approvalRequestId_ = null;
                  approvalAutomatic_ = false;
                  approvalSubmitting_ = false;
                  showNextQueuedApproval();
                  return;
               }

               approvalSubmitting_ = false;
               display_.showApprovalError(requestId, error.getUserMessage());
            }
         });
   }

   /**
    * Initialize the Chat pane by fetching the local RAI bridge URL and loading
    * it into the pane. The session spawns the rai-chat-bridge on demand; this
    * asks for its URL and reacts to the reported status.
    *
    * Flow: initializeChat() -> rai_get_bridge_url -> loadUrl() (ready) /
    * retry (starting) / setup notice (not_found).
    */
   public void initializeChat()
   {
      // Prevent concurrent initialization (e.g., from multiple event sources)
      if (initializing_)
      {
         return;
      }

      initializing_ = true;

      // Sync the toolbar checkbox with the persisted setting. Independent of
      // the bridge-url flow below -- never gates or blocks chat init.
      server_.raiGetSettings(new ServerRequestCallback<JsObject>()
      {
         @Override
         public void onResponseReceived(JsObject config)
         {
            Boolean caffeinateValue = config.getBoolean("caffeinate");
            boolean caffeinate = caffeinateValue == null || caffeinateValue;
            display_.setCaffeinate(caffeinate);
            Double leaseStart = config.getDouble("caffeinateStartedAt");
            if (leaseStart != null)
               display_.setCaffeinateLeaseStart(leaseStart);
         }

         @Override
         public void onError(ServerError error)
         {
            // Non-fatal: leave the checkbox at its default (checked) state.
            Debug.log("Failed to read RAI Assistant caffeinate setting: " + error.getUserMessage());
         }
      });

      server_.raiGetBridgeUrl(new ServerRequestCallback<JsObject>()
      {
         @Override
         public void onResponseReceived(JsObject response)
         {
            String status = response.getString("status");
            if (StringUtil.equals(status, "ready"))
            {
               String url = response.getString("url");
               // Same bridge URL as before this round-trip means the bridge
               // (and the claude/codex pty it hosts) is the same one that
               // was already loaded -- it survived a session restart on its
               // own. Reloading the iframe in that case would tear down its
               // live WebSocket connection and kill that still-running pty
               // for nothing (see server.js's ws.on('close') handler). Only
               // an actual URL change (a genuinely fresh bridge) warrants a
               // reload; restartTerminal() nulls cachedUrl_ before calling
               // back in here specifically to force one when the user asks.
               boolean sameUrl = !poppedOut_ && StringUtil.equals(url, cachedUrl_) && display_.hasChatFrameForUrl(url);
               cachedUrl_ = url;
               if (poppedOut_)
               {
                  openChatSatellite(ChatSatelliteParams.create(url, null, false));
                  display_.setStatus(Display.Status.READY);
                  display_.showPoppedOutPlaceholder();
               }
               else if (sameUrl)
               {
                  display_.setStatus(Display.Status.READY);
                  display_.clearSuspendedMessage();
               }
               else
               {
                  display_.setStatus(Display.Status.READY);
                  display_.loadUrl(url);
               }
               initializing_ = false;
               setAutomationChatState("ready", false);
            }
            else if (StringUtil.equals(status, "starting"))
            {
               // Bridge is still spawning; show a themed notice and retry once.
               // showInDisplayOrSatellite() clears initializing_ so the retry
               // can re-enter.
               showInDisplayOrSatellite(
                  display_.getMessageHTML(constants_.raiStartingMessage()),
                  () -> display_.showMessage(constants_.raiStartingMessage()));
               setAutomationChatState("starting", false);
               Scheduler.get().scheduleFixedDelay(() -> {
                  initializeChat();
                  return false;
               }, RAI_RETRY_MS);
            }
            else
            {
               // not_found (or unexpected): node or the bridge is missing or
               // crash-looping. No retry; user can re-trigger via the pane's
               // activate command. Surface the server's actual diagnostic
               // (which file/step failed, or the exit code) rather than a
               // blanket string, so a stuck pane is actionable without
               // needing to dig through session logs.
               String detail = response.hasKey("message") ? response.getString("message") : "";
               String text = StringUtil.isNullOrEmpty(detail)
                  ? constants_.raiNotFoundMessage()
                  : constants_.raiNotFoundMessage() + " (" + detail + ")";
               showInDisplayOrSatellite(
                  display_.getMessageHTML(text),
                  () -> display_.showMessage(text));
               setAutomationChatState("not-found", true);
            }
         }

         @Override
         public void onError(ServerError error)
         {
            showErrorMessage(constants_.chatBackendStartError(error.getMessage()));
         }
      });
   }

   private void restartTerminal()
   {
      // A restart invalidates the bridge URL, so do not overlap it with an
      // initialization or another restart.
      if (initializing_ || terminalRestartInFlight_)
         return;

      final int restartGeneration = ++terminalRestartGeneration_;
      terminalRestartInFlight_ = true;
      initializing_ = true;
      server_.raiRestartBridge(new ServerRequestCallback<JsObject>()
      {
         @Override
         public void onResponseReceived(JsObject response)
         {
            if (restartGeneration != terminalRestartGeneration_)
               return;

            terminalRestartInFlight_ = false;
            String status = response.getString("status");
            if (StringUtil.equals(status, "starting") ||
                StringUtil.equals(status, "ready"))
            {
               // A ready response is handled deliberately: re-fetch the URL
               // so both statuses reload the current bridge endpoint.
               cachedUrl_ = null;
               initializing_ = false;
               initializeChat();
               return;
            }

            initializing_ = false;
            String message = response.hasKey("message")
               ? response.getString("message")
               : status;
            if (StringUtil.isNullOrEmpty(message))
               message = StringUtil.isNullOrEmpty(status)
                  ? "Bridge restart returned no status."
                  : "Bridge restart returned status '" + status + "'.";
            showErrorMessage(constants_.chatBackendStartError(message));
         }

         @Override
         public void onError(ServerError error)
         {
            if (restartGeneration != terminalRestartGeneration_)
               return;

            terminalRestartInFlight_ = false;
            initializing_ = false;
            showErrorMessage(constants_.chatBackendStartError(error.getMessage()));
         }
      });
   }

   private void startBackend()
   {
      // Legacy Posit-only backend path; not part of the RAI assistant surface.
      // Re-check preference before starting (guards against provider change
      // during the async update check)
      if (!paiUtil_.isChatProviderPosit())
      {
         initializing_ = false;
         cancelPopOut();
         display_.setStatus(Display.Status.ASSISTANT_NOT_SELECTED);
         setAutomationChatState("assistant-not-selected", true);
         return;
      }

      // Show loading state
      display_.setStatus(Display.Status.STARTING);
      setAutomationChatState("starting", false);

      // Start backend
      server_.chatStartBackend(new ServerRequestCallback<JsObject>()
      {
         @Override
         public void onResponseReceived(JsObject response)
         {
            if (response.getBoolean("success"))
            {
               // Poll for URL
               pollForBackendUrl();
            }
            else
            {
               String error = response.getString("error");
               showErrorMessage(
                  constants_.chatBackendStartFailed(error));
            }
         }

         @Override
         public void onError(ServerError error)
         {
            showErrorMessage(
               constants_.chatBackendStartError(error.getMessage()));
         }
      });
   }

   private void checkForUpdates()
   {
      checkForUpdates(false);
   }

   private void checkForUpdates(boolean forceRecheck)
   {
      installManager_.checkForUpdates(forceRecheck, new PositAiInstallManager.UpdateCheckCallback()
      {
         @Override
         public void onNoUpdateAvailable()
         {
            // No update available - start backend normally
            startBackend();
         }

         @Override
         public void onUpdateAvailable(String currentVersion, String newVersion,
                                       boolean isInitialInstall, boolean isDowngrade,
                                       boolean additionalProvidersAvailable)
         {
            // Pausing for user action — do NOT start backend.
            // Backend starts after user clicks "Update/Install Now" and it
            // completes, or after user clicks "Ignore".
            if (isInitialInstall)
            {
               showInDisplayOrSatellite(
                  display_.getNotInstalledWithInstallHTML(
                     newVersion, additionalProvidersAvailable),
                  () -> display_.showNotInstalledWithInstall(
                     newVersion, additionalProvidersAvailable));
               setAutomationChatState("not-installed", true);
            }
            else
            {
               showInDisplayOrSatellite(
                  display_.getUpdateAvailableWithVersionsHTML(
                     currentVersion, newVersion, isDowngrade),
                  () -> display_.showUpdateAvailableWithVersions(
                     currentVersion, newVersion, isDowngrade));
               setAutomationChatState("update-available", true);
            }
         }

         @Override
         public void onIncompatibleVersion()
         {
            showInDisplayOrSatellite(
               display_.getIncompatibleVersionHTML(),
               () -> display_.showIncompatibleVersion());
            setAutomationChatState("incompatible-version", true);
         }

         @Override
         public void onUnsupportedVersionUpgradeRequired(
             String currentVersion, String newVersion, boolean isDowngrade)
         {
            // The chat pane's "Update Required" page is shared between upgrade and
            // downgrade variants. isDowngrade is accepted for signature consistency
            // but not currently reflected in the chat pane copy; the preferences
            // dialog (AssistantPreferencesPane) is where this distinction is shown.
            showInDisplayOrSatellite(
               display_.getUnsupportedVersionUpgradeHTML(
                  currentVersion, newVersion),
               () -> display_.showUnsupportedVersionUpgradeRequired(
                  currentVersion, newVersion));
            setAutomationChatState("version-update-required", true);
         }

         @Override
         public void onUnsupportedVersionNoUpdate(String currentVersion)
         {
            showInDisplayOrSatellite(
               display_.getUnsupportedVersionNoUpdateHTML(currentVersion),
               () -> display_.showUnsupportedVersionNoUpdate(currentVersion));
            setAutomationChatState("version-no-update", true);
         }

         @Override
         public void onUnsupportedProtocol()
         {
            showInDisplayOrSatellite(
               display_.getUnsupportedProtocolHTML(),
               () -> display_.showUnsupportedProtocol());
            setAutomationChatState("unsupported-protocol", true);
         }

         @Override
         public void onManifestUnavailable(String errorMessage)
         {
            showInDisplayOrSatellite(
               display_.getManifestUnavailableHTML(errorMessage),
               () -> display_.showManifestUnavailable(errorMessage));
            setAutomationChatState("manifest-unavailable", true);
         }

         @Override
         public void onCheckFailed(String errorMessage)
         {
            // Network failure or other error - show message but don't block
            display_.showUpdateCheckFailure();

            // Try to start backend anyway - if nothing is installed, backend will
            // return an error that we handle gracefully. This handles the case where
            // there IS an existing installation but the update check failed due to
            // network issues.
            startBackend();
         }
      });
   }

   private void installUpdate()
   {
      installManager_.installUpdate(new PositAiInstallManager.InstallCallback()
      {
         @Override
         public void onInstallStarted()
         {
            display_.showUpdatingStatus();
            if (poppedOut_)
            {
               showHtmlInSatellite(display_.getMessageHTML(
                  constants_.chatUpdating()));
            }
         }

         @Override
         public void onInstallProgress(String status)
         {
            // Status is shown via showUpdatingStatus(), no additional action needed
         }

         @Override
         public void onInstallComplete()
         {
            // Update complete - restart backend and reload UI
            display_.showUpdateComplete();
            if (poppedOut_)
            {
               showHtmlInSatellite(display_.getMessageHTML(
                  constants_.chatUpdateComplete()));
            }

            // Give user a moment to see the success message
            Scheduler.get().scheduleFixedDelay(new RepeatingCommand()
            {
               @Override
               public boolean execute()
               {
                  // Set flag so we know to hide the notification after reload
                  reloadingAfterUpdate_ = true;
                  initializeChat();
                  return false;
               }
            }, 1000);
         }

         @Override
         public void onInstallFailed(String errorMessage)
         {
            display_.showUpdateError(errorMessage);
            if (poppedOut_)
            {
               showHtmlInSatellite(display_.getErrorHTML(errorMessage));
            }
         }
      });
   }

   private void pollForBackendUrl()
   {
      pollForBackendUrl(0, backendPollGeneration_);
   }

   private void pollForBackendUrl(final int attemptCount, final int pollGen)
   {
      if (pollGen != backendPollGeneration_)
         return; // stale callback from prior lifecycle

      if (attemptCount > 30) // 30 seconds timeout
      {
         showErrorMessage(constants_.chatBackendStartTimeout());
         return;
      }

      server_.chatGetBackendStatus(new ServerRequestCallback<JsObject>()
      {
         @Override
         public void onResponseReceived(JsObject response)
         {
            if (pollGen != backendPollGeneration_)
               return; // stale callback from prior lifecycle

            String status = response.getString("status");

            if (status.equals("ready"))
            {
               String wsUrl = response.getString("url");
               String authToken = response.hasKey("auth_token") ? response.getString("auth_token") : "";
               if (authToken.isEmpty())
               {
                  Debug.log("Chat backend reported ready but auth_token is missing");
               }
               boolean resumeChat = response.hasKey("resume_chat") && response.getBoolean("resume_chat");
               loadChatUI(wsUrl, authToken, resumeChat);
            }
            else
            {
               // Backend is still starting (could be "starting", "stopped", etc.)
               // Keep retrying until timeout or ready
               Scheduler.get().scheduleFixedDelay(new RepeatingCommand()
               {
                  @Override
                  public boolean execute()
                  {
                     pollForBackendUrl(attemptCount + 1, pollGen);
                     return false;
                  }
               }, 1000);
            }
         }

         @Override
         public void onError(ServerError error)
         {
            if (pollGen != backendPollGeneration_)
               return; // stale callback from prior lifecycle

            showErrorMessage(
               constants_.chatBackendStatusCheckFailed(error.getMessage()));
         }
      });
   }

   /**
    * Hard reset for the RAI Assistant. Unlike restartTerminal() (a soft
    * provider-PTY restart that re-points at the same running bridge), this asks
    * the session to SIGKILL a wedged or orphaned bridge, clear its state, and
    * spawn a fresh one in the active project directory -- so it recovers even
    * when the iframe, its WebSocket, or the bridge itself is dead. It routes
    * exclusively through the RAI bridge (rai_reset_bridge), never the legacy
    * Posit chat_start_backend backend.
    *
    * Deliberately not guarded by initializing_: a reset must be able to break a
    * stuck initialization. Instead it supersedes any in-flight work by bumping
    * the generation counters and nulling the cached URL before reloading.
    */
   private void resetAssistant()
   {
      // A hard bridge reset cancels every pending bridge-owned tool request.
      // Remove its native UI state immediately, rather than leaving an orphaned
      // approval overlay over the fresh terminal while the old bridge dies.
      clearPendingApprovalsForReset();
      terminalRestartInFlight_ = false;
      backendPollGeneration_++;
      terminalRestartGeneration_++;
      initializing_ = true;
      cachedUrl_ = null;
      display_.hideConnectionLostNotification();
      display_.hideReadlineNotification();
      display_.setStatus(Display.Status.RESTARTING);
      setAutomationChatState("restarting", false);

      server_.raiResetBridge(new ServerRequestCallback<JsObject>()
      {
         @Override
         public void onResponseReceived(JsObject response)
         {
            String status = response.getString("status");
            if (StringUtil.equals(status, "starting") ||
                StringUtil.equals(status, "ready"))
            {
               // Fresh bridge requested; nulling cachedUrl_ above forces
               // initializeChat() to reload the iframe once it is ready.
               initializing_ = false;
               initializeChat();
               return;
            }

            initializing_ = false;
            String message = response.hasKey("message")
               ? response.getString("message")
               : status;
            if (StringUtil.isNullOrEmpty(message))
               message = StringUtil.isNullOrEmpty(status)
                  ? "Assistant reset returned no status."
                  : "Assistant reset returned status '" + status + "'.";
            showErrorMessage(constants_.chatBackendStartError(message));
         }

         @Override
         public void onError(ServerError error)
         {
            initializing_ = false;
            showErrorMessage(constants_.chatBackendStartError(error.getMessage()));
         }
      });
   }

   private void loadChatUI(String wsUrl, String authToken, boolean resumeChat)
   {
      // Re-check preference before loading (guards against preference change during polling)
      if (!paiUtil_.isChatProviderPosit())
      {
         initializing_ = false;
         cancelPopOut();
         display_.setStatus(Display.Status.ASSISTANT_NOT_SELECTED);
         setAutomationChatState("assistant-not-selected", true);
         return;
      }

      // In dev mode, GWT.getHostPageBaseURL() may not include session prefix
      // Try relative URL first, which should work in both dev and production
      String baseUrl = "ai-chat/index.html";

      // Append WebSocket URL and timestamp as query parameters to bust cache
      long timestamp = System.currentTimeMillis();
      String params = "?wsUrl=" + URL.encodeQueryString(wsUrl) + "&_t=" + timestamp;

      // In Desktop mode, pass the auth token as a URL parameter since the
      // WebSocket connects to localhost directly. In Server mode, the token
      // is delivered via an HTTP-only cookie set by the static file handler,
      // avoiding exposure in browser history, logs, and the Referer header.
      if (Desktop.hasDesktopFrame() && authToken != null && !authToken.isEmpty())
      {
         params += "&authToken=" + URL.encodeQueryString(authToken);
      }

      String loadUrl = baseUrl + params;
      if (resumeChat)
      {
         loadUrl += "&resume";
      }

      // Cache the URL and auth token for satellite use
      cachedUrl_ = loadUrl;
      cachedAuthToken_ = authToken;

      // If popped out, send URL to satellite instead of loading in ChatPane
      if (poppedOut_)
      {
         openChatSatellite(ChatSatelliteParams.create(
            loadUrl, authToken, resumeChat));

         display_.setStatus(Display.Status.READY);
         display_.showPoppedOutPlaceholder();
      }
      else
      {
         display_.loadUrl(loadUrl);
         display_.setStatus(Display.Status.READY);
      }

      // Mark the backend so subsequent status responses include resume_chat=true
      server_.chatNotifyUILoaded(new VoidServerRequestCallback());

      // Always include &resume in the cached URL so that satellite windows
      // and session-resume reloads signal resume, even if the initial load
      // was fresh
      cachedUrl_ = baseUrl + params + "&resume";

      // Reset initialization flag - we're done
      initializing_ = false;

      // Handle notifications after successful load
      if (reloadingAfterUpdate_)
      {
         // After update/install completion, hide all notifications
         display_.hideUpdateNotification();
         reloadingAfterUpdate_ = false;
      }
      else
      {
         // Hide error notifications since backend started successfully
         // Keep "Update available" notifications visible so user can update later
         display_.hideErrorNotification();
      }

      setAutomationChatState("ready", false);
   }

   /**
    * Push the current chat-pane lifecycle state into window.rstudio.chat for
    * automation tests to poll. No-op when window.rstudio is absent (i.e.,
    * outside --automation-agent mode), so production builds pay nothing.
    *
    * <ul>
    *   <li><b>state</b>: identifies the specific state, e.g. "ready",
    *     "starting", "restarting", "manifest-unavailable",
    *     "unsupported-protocol", "incompatible-version",
    *     "version-update-required", "version-no-update", "not-installed",
    *     "update-available", "assistant-not-selected", "error",
    *     "crashed".</li>
    *   <li><b>blocked</b>: true when the iframe is showing a blocking page
    *     that prevents normal interaction (the user must take a setup action
    *     or RStudio cannot continue). Tests poll this when they only care
    *     whether the chat is unusable; the state field tells them why.</li>
    * </ul>
    */
   private native final void setAutomationChatState(String state, boolean blocked) /*-{
      if ($wnd.rstudio) {
         $wnd.rstudio.chat = $wnd.rstudio.chat || {};
         $wnd.rstudio.chat.state = state;
         $wnd.rstudio.chat.blocked = blocked;
         // History is bounded so a long-running session doesn't grow unbounded;
         // 50 transitions is plenty for any test, and lets us answer "what
         // states did the chat go through" after a failure.
         $wnd.rstudio.chat.history = $wnd.rstudio.chat.history || [];
         $wnd.rstudio.chat.history.push({ state: state, blocked: blocked, at: Date.now() });
         if ($wnd.rstudio.chat.history.length > 50) {
            $wnd.rstudio.chat.history.shift();
         }
      }
   }-*/;

   private final Display display_;
   private final EventBus events_;
   private final Commands commands_;
   private final ChatServerOperations server_;
   private final PaiUtil paiUtil_;
   private final UserPrefs prefs_;
   private final PositAiInstallManager installManager_;
   private final SatelliteManager satelliteManager_;
   private final PaneManager paneManager_;
   private final Session session_;
   private final GlobalDisplay globalDisplay_;
   private final ApplicationQuit applicationQuit_;
   private final SourceColumnManager sourceColumnManager_;

   // Track whether we're reloading after an install/update completion
   private boolean reloadingAfterUpdate_ = false;

   // Guard against concurrent initialization (multiple polling loops)
   private boolean initializing_ = false;

   // Guards terminal restart RPCs; generation ignores a stale callback after
   // a subsequent restart has begun.
   private boolean terminalRestartInFlight_ = false;
   private int terminalRestartGeneration_ = 0;
   private String approvalRequestId_;
   private boolean approvalSubmitting_;
   private boolean approvalAutomatic_ = false;
   private final Queue<RaiApprovalRequestEvent> approvalQueue_ = new LinkedList<>();

   // Delay before re-asking the session for the bridge URL while it starts
   private static final int RAI_RETRY_MS = 1500;

   // Monotonic counter invalidating stale pollForBackendUrl callbacks
   private int backendPollGeneration_ = 0;

   // Satellite pop-out state
   private boolean windowsClosing_ = false;
   private boolean poppedOut_ = false;
   private boolean stateDirty_ = false;
   private SatelliteWindowGeometry savedGeometry_ = null;
   private String cachedUrl_ = null;
   private String cachedAuthToken_ = null;

   private static final ChatConstants constants_ = com.google.gwt.core.client.GWT.create(ChatConstants.class);
}
