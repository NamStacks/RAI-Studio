/*
 * RaiApprovalCard.java
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

import com.google.gwt.dom.client.Style;
import com.google.gwt.user.client.ui.Button;
import com.google.gwt.user.client.ui.FlowPanel;
import com.google.gwt.user.client.ui.Label;
import com.google.gwt.user.client.ui.TextArea;

public class RaiApprovalCard extends FlowPanel
{
   public interface Observer
   {
      void onDecision(String decision, String scope);

      // Only reachable once an error is showing (see showError()) -- lets the
      // user abandon a request stuck behind a terminal RPC/broker failure
      // without that being an implicit grant or decline.
      void onDismiss();
   }

   public RaiApprovalCard(String tool,
                          String reason,
                          String target,
                          String preview,
                          String diff,
                          Observer observer,
                          String buttonStyleName)
   {
      setStyleName("rai-approval-card");
      Style style = getElement().getStyle();
      style.setProperty("boxSizing", "border-box");
      style.setProperty("padding", "12px");
      style.setProperty("overflowY", "auto");
      style.setProperty("background", "var(--rstudio-editorWidget-background, #f4f8f9)");
      style.setProperty("color", "var(--rstudio-editor-foreground, #333)");
      style.setProperty("border", "1px solid var(--rstudio-panel-border, #d6dadc)");
      style.setProperty("borderRadius", "4px");
      style.setProperty("boxShadow", "0 2px 8px rgba(0, 0, 0, 0.25)");
      getElement().setAttribute("role", "region");
      getElement().setAttribute("aria-label", "Tool approval request");

      addHeading("Tool approval required");
      addField("Tool", tool);
      addField("Reason", reason);
      addField("Target", target);
      addContent("Preview", preview);
      addContent("Diff", diff);

      error_ = new Label();
      error_.getElement().getStyle().setProperty("color", "#b00020");
      error_.getElement().getStyle().setProperty("marginTop", "8px");
      error_.setVisible(false);
      add(error_);

      FlowPanel actions = new FlowPanel();
      actions.getElement().getStyle().setProperty("display", "flex");
      actions.getElement().getStyle().setProperty("flexWrap", "wrap");
      actions.getElement().getStyle().setProperty("gap", "6px");
      actions.getElement().getStyle().setProperty("marginTop", "12px");
      add(actions);

      addButton(actions, "Allow once", "allow", "once", observer, buttonStyleName);
      // Neither run_r nor edit_document may receive a standing grant. Console
      // execution would authorize arbitrary R, while editor changes must each
      // retain their own reviewed exact replacement.
      if (!"run_r".equals(tool) && !"edit_document".equals(tool) && !"authorize_derived".equals(tool))
      {
         addButton(actions, "Allow for session", "allow", "session", observer, buttonStyleName);
         addButton(actions, "Allow for project", "allow", "project", observer, buttonStyleName);
      }
      addButton(actions, "Decline", "decline", "once", observer, buttonStyleName);

      // Hidden until showError() reveals it -- dismissal is only offered once
      // the request is already stuck behind a terminal error, not as a way
      // to skip deciding on a live, unresolved request.
      dismissButton_ = new Button("Dismiss");
      dismissButton_.addStyleName(buttonStyleName);
      dismissButton_.getElement().getStyle().setProperty("padding", "5px 10px");
      dismissButton_.getElement().getStyle().setProperty("cursor", "pointer");
      dismissButton_.setVisible(false);
      dismissButton_.addClickHandler((event) -> observer.onDismiss());
      buttons_.add(dismissButton_);
      actions.add(dismissButton_);
   }

   public void setSubmitting(boolean submitting)
   {
      for (Button button : buttons_)
         button.setEnabled(!submitting);
   }

   public void showError(String message)
   {
      error_.setText(message);
      error_.setVisible(true);
      setSubmitting(false);
      dismissButton_.setVisible(true);
   }

   private void addHeading(String text)
   {
      Label heading = new Label(text);
      heading.getElement().getStyle().setProperty("fontWeight", "600");
      heading.getElement().getStyle().setProperty("marginBottom", "8px");
      add(heading);
   }

   private void addField(String name, String value)
   {
      Label field = new Label(name + ": " + value);
      field.getElement().getStyle().setProperty("marginTop", "4px");
      field.getElement().getStyle().setProperty("wordBreak", "break-word");
      add(field);
   }

   private void addContent(String name, String content)
   {
      // No call site currently supplies a diff, and a preview-less request
      // has nothing to show either -- skip the box entirely rather than
      // rendering it permanently empty.
      if (content == null || content.isEmpty())
         return;

      Label label = new Label(name);
      label.getElement().getStyle().setProperty("fontWeight", "600");
      label.getElement().getStyle().setProperty("marginTop", "8px");
      add(label);

      TextArea text = new TextArea();
      text.setText(content);
      text.setReadOnly(true);
      // Wide enough that a short multi-statement run_r block (the common
      // case) is fully visible without scrolling before the user decides.
      text.setVisibleLines(10);
      text.setWidth("100%");
      text.getElement().getStyle().setProperty("boxSizing", "border-box");
      text.getElement().getStyle().setProperty("fontFamily", "monospace");
      add(text);
   }

   private void addButton(FlowPanel panel,
                          String label,
                          String decision,
                          String scope,
                          Observer observer,
                          String buttonStyleName)
   {
      Button button = new Button(label);
      button.addStyleName(buttonStyleName);
      button.getElement().getStyle().setProperty("padding", "5px 10px");
      button.getElement().getStyle().setProperty("cursor", "pointer");
      button.addClickHandler((event) -> observer.onDecision(decision, scope));
      buttons_.add(button);
      panel.add(button);
   }

   private final java.util.List<Button> buttons_ = new java.util.ArrayList<>();
   private Label error_;
   private Button dismissButton_;
}
