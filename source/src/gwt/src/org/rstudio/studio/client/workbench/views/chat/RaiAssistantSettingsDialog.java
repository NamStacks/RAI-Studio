/*
 * RaiAssistantSettingsDialog.java
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

import java.util.ArrayList;
import java.util.List;

import org.rstudio.core.client.js.JsObject;
import org.rstudio.core.client.widget.ModalDialog;
import org.rstudio.core.client.widget.OperationWithInput;
import org.rstudio.core.client.widget.SelectWidget;

import com.google.gwt.aria.client.Roles;
import com.google.gwt.core.client.GWT;
import com.google.gwt.user.client.ui.CheckBox;
import com.google.gwt.user.client.ui.VerticalPanel;
import com.google.gwt.user.client.ui.Widget;

// Native provider picker for the RAI Assistant
public class RaiAssistantSettingsDialog extends ModalDialog<RaiAssistantSettingsDialog.Input>
{
   public static class Input
   {
      public Input(String provider, boolean caffeinate)
      {
         provider_ = provider;
         caffeinate_ = caffeinate;
      }

      public final String getProvider()
      {
         return provider_;
      }

      public final boolean getCaffeinate()
      {
         return caffeinate_;
      }

      public final boolean getAutoApproveReadOnly()
      {
         // Retired preference: keep the compatibility payload explicitly approved.
         return true;
      }

      private final String provider_;
      private final boolean caffeinate_;
   }

   public RaiAssistantSettingsDialog(JsObject config,
                                     OperationWithInput<Input> onSave)
   {
      super(constants_.raiSettingsTitle(), Roles.getDialogRole(), onSave);
      setThemeAware(true);
      setOkButtonCaption(constants_.raiSettingsSaveButton());

      JsObject providersConfig = config.hasKey("providers")
         ? config.getObject("providers")
         : JsObject.createJsObject();

      String currentProvider = config.hasKey("provider")
         ? config.getString("provider") : "";
      providerSelect_ = new SelectWidget(constants_.raiSettingsProviderLabel());
      List<String> providers = new ArrayList<>();
      if (providersConfig.hasKey("claude"))
         providers.add("claude");
      if (providersConfig.hasKey("codex"))
         providers.add("codex");
      if (providersConfig.hasKey("opencode"))
         providers.add("opencode");
      if (providersConfig.hasKey("grok"))
         providers.add("grok");
      providerSelect_.setChoices(providers.toArray(new String[0]));
      if (providers.contains(currentProvider))
         providerSelect_.setValue(currentProvider);

      // Defaults to checked/on -- mirrors rai-chat-bridge's
      // DEFAULT_CONFIG.caffeinate=true. Only affects the *next* terminal
      // launch; a live pty's wrapper is not restarted.
      boolean currentCaffeinate = !config.hasKey("caffeinate")
         || config.getBoolean("caffeinate");
      caffeinateCheckbox_ = new CheckBox(constants_.raiCaffeinateButton());
      caffeinateCheckbox_.setValue(currentCaffeinate);

      VerticalPanel panel = new VerticalPanel();
      panel.add(providerSelect_);
      panel.add(caffeinateCheckbox_);
      container_ = panel;
   }

   @Override
   protected Input collectInput()
   {
      return new Input(providerSelect_.getValue(), caffeinateCheckbox_.getValue());
   }

   @Override
   protected Widget createMainWidget()
   {
      return container_;
   }

   private final SelectWidget providerSelect_;
   private final CheckBox caffeinateCheckbox_;
   private final VerticalPanel container_;

   private static final ChatConstants constants_ = GWT.create(ChatConstants.class);
}
