package org.rstudio.studio.client.workbench.views.source.model;

// Unused interface methods fail so unexpected save paths cannot pass silently
public class RaiAckServerStub implements org.rstudio.studio.client.workbench.views.source.model.SourceServerOperations
{
   @Override
   public java.lang.String getApplicationURL(java.lang.String p0) { throw new AssertionError("Unexpected RaiAckServerStub.getApplicationURL"); }

   @Override
   public java.lang.String getFileUrl(org.rstudio.core.client.files.FileSystemItem p0) { throw new AssertionError("Unexpected RaiAckServerStub.getFileUrl"); }

   @Override
   public java.lang.String getFileExportUrl(java.lang.String p0, org.rstudio.core.client.files.FileSystemItem p1) { throw new AssertionError("Unexpected RaiAckServerStub.getFileExportUrl"); }

   @Override
   public java.lang.String getFileExportUrl(java.lang.String p0, org.rstudio.core.client.files.FileSystemItem p1, java.util.ArrayList<java.lang.String> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getFileExportUrl"); }

   @Override
   public java.lang.String getFileUploadUrl() { throw new AssertionError("Unexpected RaiAckServerStub.getFileUploadUrl"); }

   @Override
   public java.lang.String resolveAliasedPath(org.rstudio.core.client.files.FileSystemItem p0) { throw new AssertionError("Unexpected RaiAckServerStub.resolveAliasedPath"); }

   @Override
   public void executeUserCommand(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.executeUserCommand"); }

   @Override
   public void extractChunkOptions(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p1) { throw new AssertionError("Unexpected RaiAckServerStub.extractChunkOptions"); }

   @Override
   public void getArgs(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p3) { throw new AssertionError("Unexpected RaiAckServerStub.getArgs"); }

   @Override
   public void getCompletions(java.lang.String p0, org.rstudio.core.client.JsVector<org.rstudio.studio.client.workbench.views.console.shell.assist.RCompletionManager.AutocompletionContextData> p1, java.lang.String p2, org.rstudio.studio.client.workbench.views.source.editors.text.ace.Range p3, java.lang.String p4, com.google.gwt.core.client.JsArrayString p5, com.google.gwt.core.client.JsArrayString p6, boolean p7, java.lang.String p8, java.lang.String p9, java.lang.String p10, boolean p11, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.codetools.Completions> p12) { throw new AssertionError("Unexpected RaiAckServerStub.getCompletions"); }

   @Override
   public void getHelpAtCursor(java.lang.String p0, int p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getHelpAtCursor"); }

   @Override
   public void isFunction(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p2) { throw new AssertionError("Unexpected RaiAckServerStub.isFunction"); }

   @Override
   public void markdownGetCompletions(int p0, com.google.gwt.core.client.JavaScriptObject p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.codetools.Completions> p2) { throw new AssertionError("Unexpected RaiAckServerStub.markdownGetCompletions"); }

   @Override
   public void pythonGetCompletions(java.lang.String p0, org.rstudio.studio.client.workbench.views.console.shell.assist.PythonCompletionContext p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.codetools.Completions> p2) { throw new AssertionError("Unexpected RaiAckServerStub.pythonGetCompletions"); }

   @Override
   public void pythonGoToDefinition(java.lang.String p0, int p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p2) { throw new AssertionError("Unexpected RaiAckServerStub.pythonGoToDefinition"); }

   @Override
   public void pythonGoToHelp(java.lang.String p0, int p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p2) { throw new AssertionError("Unexpected RaiAckServerStub.pythonGoToHelp"); }

   @Override
   public void sqlGetCompletions(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.workbench.views.console.shell.assist.SqlCompletionParseContext p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.codetools.Completions> p3) { throw new AssertionError("Unexpected RaiAckServerStub.sqlGetCompletions"); }

   @Override
   public void stanGetArguments(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p1) { throw new AssertionError("Unexpected RaiAckServerStub.stanGetArguments"); }

   @Override
   public void stanGetCompletions(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.codetools.Completions> p1) { throw new AssertionError("Unexpected RaiAckServerStub.stanGetCompletions"); }

   @Override
   public void stanRunDiagnostics(java.lang.String p0, boolean p1, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArray<org.rstudio.studio.client.workbench.views.output.lint.model.AceAnnotation>> p2) { throw new AssertionError("Unexpected RaiAckServerStub.stanRunDiagnostics"); }

   @Override
   public void getPublicKey(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.crypto.PublicKeyInfo> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getPublicKey"); }

   @Override
   public void rpubsIsPublished(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.rpubsIsPublished"); }

   @Override
   public void rpubsTerminateUpload(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.rpubsTerminateUpload"); }

   @Override
   public void rpubsUpload(java.lang.String p0, java.lang.String p1, java.lang.String p2, java.lang.String p3, java.lang.String p4, boolean p5, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p6) { throw new AssertionError("Unexpected RaiAckServerStub.rpubsUpload"); }

   @Override
   public void copyFile(org.rstudio.core.client.files.FileSystemItem p0, org.rstudio.core.client.files.FileSystemItem p1, boolean p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p3) { throw new AssertionError("Unexpected RaiAckServerStub.copyFile"); }

   @Override
   public void getHTMLCapabilities(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.model.HTMLCapabilities> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getHTMLCapabilities"); }

   @Override
   public void previewHTML(org.rstudio.studio.client.htmlpreview.model.HTMLPreviewParams p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.previewHTML"); }

   @Override
   public void terminatePreviewHTML(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.terminatePreviewHTML"); }

   @Override
   public void quartoCapabilities(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.quarto.model.QuartoCapabilities> p0) { throw new AssertionError("Unexpected RaiAckServerStub.quartoCapabilities"); }

   @Override
   public void quartoCreateProject(java.lang.String p0, org.rstudio.studio.client.quarto.model.QuartoNewProjectOptions p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.console.ConsoleProcess> p2) { throw new AssertionError("Unexpected RaiAckServerStub.quartoCreateProject"); }

   @Override
   public void quartoPreview(java.lang.String p0, java.lang.String p1, com.google.gwt.core.client.JavaScriptObject p2, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p3) { throw new AssertionError("Unexpected RaiAckServerStub.quartoPreview"); }

   @Override
   public void quartoPublishDetails(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.QmdPublishDetails> p1) { throw new AssertionError("Unexpected RaiAckServerStub.quartoPublishDetails"); }

   @Override
   public void cancelPublish(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p0) { throw new AssertionError("Unexpected RaiAckServerStub.cancelPublish"); }

   @Override
   public void connectCloudUser(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.connectCloudUser"); }

   @Override
   public void connectRSConnectAccount(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.connectRSConnectAccount"); }

   @Override
   public void forgetRSConnectDeployments(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.forgetRSConnectDeployments"); }

   @Override
   public void generateAppName(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RSConnectAppName> p3) { throw new AssertionError("Unexpected RaiAckServerStub.generateAppName"); }

   @Override
   public void getDeploymentEnvVars(org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getDeploymentEnvVars"); }

   @Override
   public void getDeploymentFiles(java.lang.String p0, boolean p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RSConnectDeploymentFiles> p3) { throw new AssertionError("Unexpected RaiAckServerStub.getDeploymentFiles"); }

   @Override
   public void getEditPublishedDocs(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getEditPublishedDocs"); }

   @Override
   public void getLintResults(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RSConnectLintResults> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getLintResults"); }

   @Override
   public void getPreAuthToken(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RSConnectPreAuthToken> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getPreAuthToken"); }

   @Override
   public void getRSConnectAccountList(org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArray<org.rstudio.studio.client.rsconnect.model.RSConnectAccount>> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getRSConnectAccountList"); }

   @Override
   public void getRSConnectApp(java.lang.String p0, java.lang.String p1, java.lang.String p2, java.lang.String p3, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RSConnectApplicationResult> p4) { throw new AssertionError("Unexpected RaiAckServerStub.getRSConnectApp"); }

   @Override
   public void getRSConnectAppList(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArray<org.rstudio.studio.client.rsconnect.model.RSConnectApplicationInfo>> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getRSConnectAppList"); }

   @Override
   public void getRSConnectDeployments(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArray<org.rstudio.studio.client.rsconnect.model.RSConnectDeploymentRecord>> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getRSConnectDeployments"); }

   @Override
   public void getRmdPublishDetails(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RmdPublishDetails> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getRmdPublishDetails"); }

   @Override
   public void getServerUrls(org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArray<org.rstudio.studio.client.rsconnect.model.RSConnectServerEntry>> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getServerUrls"); }

   @Override
   public void getUserFromToken(java.lang.String p0, org.rstudio.studio.client.rsconnect.model.RSConnectPreAuthToken p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RSConnectAuthUser> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getUserFromToken"); }

   @Override
   public void hasOrphanedAccounts(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Double> p0) { throw new AssertionError("Unexpected RaiAckServerStub.hasOrphanedAccounts"); }

   @Override
   public void publishContent(org.rstudio.studio.client.rsconnect.model.RSConnectPublishSource p0, java.lang.String p1, java.lang.String p2, java.lang.String p3, java.lang.String p4, java.lang.String p5, org.rstudio.studio.client.rsconnect.model.RSConnectPublishSettings p6, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p7) { throw new AssertionError("Unexpected RaiAckServerStub.publishContent"); }

   @Override
   public void registerUserToken(java.lang.String p0, java.lang.String p1, int p2, org.rstudio.studio.client.rsconnect.model.RSConnectPreAuthToken p3, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p4) { throw new AssertionError("Unexpected RaiAckServerStub.registerUserToken"); }

   @Override
   public void removeRSConnectAccount(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.removeRSConnectAccount"); }

   @Override
   public void validateServerUrl(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.rsconnect.model.RSConnectServerInfo> p1) { throw new AssertionError("Unexpected RaiAckServerStub.validateServerUrl"); }

   @Override
   public void assistantDiagnostics(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes.AssistantDiagnosticsResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantDiagnostics"); }

   @Override
   public void assistantDidAcceptCompletion(org.rstudio.studio.client.workbench.assistant.model.AssistantTypes.AssistantCompletionCommand p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantDidAcceptCompletion"); }

   @Override
   public void assistantDidAcceptPartialCompletion(org.rstudio.studio.client.workbench.assistant.model.AssistantTypes.AssistantCompletion p0, int p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.assistantDidAcceptPartialCompletion"); }

   @Override
   public void assistantDidShowCompletion(org.rstudio.studio.client.workbench.assistant.model.AssistantTypes.AssistantCompletion p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantDidShowCompletion"); }

   @Override
   public void assistantDocFocused(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantDocFocused"); }

   @Override
   public void assistantGenerateCompletions(java.lang.String p0, java.lang.String p1, boolean p2, boolean p3, int p4, int p5, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes.AssistantGenerateCompletionsResponse> p6) { throw new AssertionError("Unexpected RaiAckServerStub.assistantGenerateCompletions"); }

   @Override
   public void assistantNextEditSuggestions(java.lang.String p0, java.lang.String p1, boolean p2, int p3, int p4, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes.AssistantNextEditSuggestionsResponse> p5) { throw new AssertionError("Unexpected RaiAckServerStub.assistantNextEditSuggestions"); }

   @Override
   public void assistantNotifyInstalled(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.assistantNotifyInstalled"); }

   @Override
   public void assistantRegisterOpenFiles(java.util.ArrayList<java.lang.String> p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantRegisterOpenFiles"); }

   @Override
   public void assistantSignIn(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes.AssistantSignInResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantSignIn"); }

   @Override
   public void assistantSignOut(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes.AssistantSignOutResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantSignOut"); }

   @Override
   public void assistantStatus(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.assistant.model.AssistantResponseTypes.AssistantStatusResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantStatus"); }

   @Override
   public void assistantVerifyInstalled(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.assistantVerifyInstalled"); }

   @Override
   public void findFunctionInSearchPath(java.lang.String p0, int p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.codesearch.model.SearchPathFunctionDefinition> p3) { throw new AssertionError("Unexpected RaiAckServerStub.findFunctionInSearchPath"); }

   @Override
   public void getMethodDefinition(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.codesearch.model.SearchPathFunctionDefinition> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getMethodDefinition"); }

   @Override
   public void getObjectDefinition(java.lang.String p0, int p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.codesearch.model.ObjectDefinition> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getObjectDefinition"); }

   @Override
   public void getSearchPathFunctionDefinition(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.codesearch.model.SearchPathFunctionDefinition> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getSearchPathFunctionDefinition"); }

   @Override
   public void searchCode(java.lang.String p0, int p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.codesearch.model.CodeSearchResults> p2) { throw new AssertionError("Unexpected RaiAckServerStub.searchCode"); }

   @Override
   public void devtoolsLoadAllPath(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p0) { throw new AssertionError("Unexpected RaiAckServerStub.devtoolsLoadAllPath"); }

   @Override
   public void getBookdownFormats(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.buildtools.model.BookdownFormats> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getBookdownFormats"); }

   @Override
   public void getCppCapabilities(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.CppCapabilities> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getCppCapabilities"); }

   @Override
   public void installBuildTools(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.installBuildTools"); }

   @Override
   public void startBuild(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p2) { throw new AssertionError("Unexpected RaiAckServerStub.startBuild"); }

   @Override
   public void terminateBuild(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p0) { throw new AssertionError("Unexpected RaiAckServerStub.terminateBuild"); }

   @Override
   public void chatCheckForUpdates(boolean p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p1) { throw new AssertionError("Unexpected RaiAckServerStub.chatCheckForUpdates"); }

   @Override
   public void chatDocFocused(java.lang.String p0, com.google.gwt.core.client.JsArray<com.google.gwt.core.client.JavaScriptObject> p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.chatDocFocused"); }

   @Override
   public void chatDocFocused(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.chatDocFocused"); }

   @Override
   public void chatGetBackendStatus(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatGetBackendStatus"); }

   @Override
   public void chatGetBackendUrl(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatGetBackendUrl"); }

   @Override
   public void chatGetUpdateStatus(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatGetUpdateStatus"); }

   @Override
   public void chatGetVersion(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatGetVersion"); }

   @Override
   public void chatInstallUpdate(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatInstallUpdate"); }

   @Override
   public void chatNotifyUILoaded(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatNotifyUILoaded"); }

   @Override
   public void chatSetUpdateCheckOverride(com.google.gwt.core.client.JavaScriptObject p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JavaScriptObject> p1) { throw new AssertionError("Unexpected RaiAckServerStub.chatSetUpdateCheckOverride"); }

   @Override
   public void chatStartBackend(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatStartBackend"); }

   @Override
   public void chatStopBackend(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatStopBackend"); }

   @Override
   public void chatUninstallPositAssistant(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatUninstallPositAssistant"); }

   @Override
   public void chatVerifyInstalled(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.chat.server.ChatServerOperations.ChatVerifyInstalledResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.chatVerifyInstalled"); }

   @Override
   public void raiDocumentEditAck(java.lang.String p0, boolean p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p3) { throw new AssertionError("Unexpected RaiAckServerStub.raiDocumentEditAck"); }

   @Override
   public void raiGetBridgeUrl(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.raiGetBridgeUrl"); }

   @Override
   public void raiGetSettings(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.raiGetSettings"); }

   @Override
   public void raiOpenTerminal(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.raiOpenTerminal"); }

   @Override
   public void raiResetBridge(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.raiResetBridge"); }

   @Override
   public void raiRestartBridge(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p0) { throw new AssertionError("Unexpected RaiAckServerStub.raiRestartBridge"); }

   @Override
   public void raiSetAutoApproveReadOnly(boolean p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p1) { throw new AssertionError("Unexpected RaiAckServerStub.raiSetAutoApproveReadOnly"); }

   @Override
   public void raiSetCaffeinate(boolean p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p1) { throw new AssertionError("Unexpected RaiAckServerStub.raiSetCaffeinate"); }

   @Override
   public void raiSetSettings(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p1) { throw new AssertionError("Unexpected RaiAckServerStub.raiSetSettings"); }

   @Override
   public void raiSubmitApproval(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p3) { throw new AssertionError("Unexpected RaiAckServerStub.raiSubmitApproval"); }

   @Override
   public void completeUpload(org.rstudio.studio.client.workbench.views.files.model.FileUploadToken p0, boolean p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.completeUpload"); }

   @Override
   public void createFile(org.rstudio.core.client.files.FileSystemItem p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.createFile"); }

   @Override
   public void createFolder(org.rstudio.core.client.files.FileSystemItem p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.createFolder"); }

   @Override
   public void deleteFiles(java.util.ArrayList<org.rstudio.core.client.files.FileSystemItem> p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.deleteFiles"); }

   @Override
   public void getIssueUrl(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getIssueUrl"); }

   @Override
   public void isGitDirectory(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.isGitDirectory"); }

   @Override
   public void isPackageDirectory(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.isPackageDirectory"); }

   @Override
   public void isTextFile(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.isTextFile"); }

   @Override
   public void listAllFiles(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p2) { throw new AssertionError("Unexpected RaiAckServerStub.listAllFiles"); }

   @Override
   public void listFiles(org.rstudio.core.client.files.FileSystemItem p0, boolean p1, boolean p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.files.model.DirectoryListing> p3) { throw new AssertionError("Unexpected RaiAckServerStub.listFiles"); }

   @Override
   public void makeProjectRelative(com.google.gwt.core.client.JsArrayString p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p1) { throw new AssertionError("Unexpected RaiAckServerStub.makeProjectRelative"); }

   @Override
   public void moveFiles(java.util.ArrayList<org.rstudio.core.client.files.FileSystemItem> p0, org.rstudio.core.client.files.FileSystemItem p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.moveFiles"); }

   @Override
   public void readConfigJSON(java.lang.String p0, boolean p1, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JavaScriptObject> p2) { throw new AssertionError("Unexpected RaiAckServerStub.readConfigJSON"); }

   @Override
   public void renameFile(org.rstudio.core.client.files.FileSystemItem p0, org.rstudio.core.client.files.FileSystemItem p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.renameFile"); }

   @Override
   public void stat(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.files.FileSystemItem> p1) { throw new AssertionError("Unexpected RaiAckServerStub.stat"); }

   @Override
   public void touchFile(org.rstudio.core.client.files.FileSystemItem p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.touchFile"); }

   @Override
   public void writeConfigJSON(java.lang.String p0, com.google.gwt.core.client.JavaScriptObject p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p2) { throw new AssertionError("Unexpected RaiAckServerStub.writeConfigJSON"); }

   @Override
   public void followHelpTopic(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p1) { throw new AssertionError("Unexpected RaiAckServerStub.followHelpTopic"); }

   @Override
   public void getCustomHelp(java.lang.String p0, java.lang.String p1, java.lang.String p2, java.lang.String p3, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.help.model.HelpInfo.Custom> p4) { throw new AssertionError("Unexpected RaiAckServerStub.getCustomHelp"); }

   @Override
   public void getCustomParameterHelp(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.help.model.HelpInfo.Custom> p3) { throw new AssertionError("Unexpected RaiAckServerStub.getCustomParameterHelp"); }

   @Override
   public void getHelp(java.lang.String p0, java.lang.String p1, int p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.help.model.HelpInfo> p3) { throw new AssertionError("Unexpected RaiAckServerStub.getHelp"); }

   @Override
   public void getVignetteDescription(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getVignetteDescription"); }

   @Override
   public void getVignetteTitle(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getVignetteTitle"); }

   @Override
   public void search(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p1) { throw new AssertionError("Unexpected RaiAckServerStub.search"); }

   @Override
   public void showCustomHelpTopic(java.lang.String p0, java.lang.String p1, java.lang.String p2) { throw new AssertionError("Unexpected RaiAckServerStub.showCustomHelpTopic"); }

   @Override
   public void showHelpTopic(java.lang.String p0, java.lang.String p1, int p2) { throw new AssertionError("Unexpected RaiAckServerStub.showHelpTopic"); }

   @Override
   public void showVignette(java.lang.String p0, java.lang.String p1) { throw new AssertionError("Unexpected RaiAckServerStub.showVignette"); }

   @Override
   public void suggestTopics(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p1) { throw new AssertionError("Unexpected RaiAckServerStub.suggestTopics"); }

   @Override
   public void getCppDiagnostics(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArray<org.rstudio.studio.client.workbench.views.source.model.CppDiagnostic>> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getCppDiagnostics"); }

   @Override
   public void lintRSourceDocument(java.lang.String p0, java.lang.String p1, java.lang.String p2, boolean p3, boolean p4, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArray<org.rstudio.studio.client.workbench.views.output.lint.model.LintItem>> p5) { throw new AssertionError("Unexpected RaiAckServerStub.lintRSourceDocument"); }

   @Override
   public void saveSnippets(com.google.gwt.core.client.JsArray<org.rstudio.studio.client.workbench.snippets.model.SnippetData> p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.saveSnippets"); }

   @Override
   public void clearPresentationCache(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.clearPresentationCache"); }

   @Override
   public void closePresentationPane(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.closePresentationPane"); }

   @Override
   public void createDesktopViewInBrowserPresentation(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p0) { throw new AssertionError("Unexpected RaiAckServerStub.createDesktopViewInBrowserPresentation"); }

   @Override
   public void createNewPresentation(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.createNewPresentation"); }

   @Override
   public void createPresentationRPubsSource(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.presentation.model.PresentationRPubsSource> p0) { throw new AssertionError("Unexpected RaiAckServerStub.createPresentationRPubsSource"); }

   @Override
   public void createStandalonePresentation(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.createStandalonePresentation"); }

   @Override
   public void getSlideNavigationForCode(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.presentation.model.SlideNavigation> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getSlideNavigationForCode"); }

   @Override
   public void getSlideNavigationForFile(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.presentation.model.SlideNavigation> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getSlideNavigationForFile"); }

   @Override
   public void presentationExecuteCode(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.presentationExecuteCode"); }

   @Override
   public void setPresentationSlideIndex(int p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.setPresentationSlideIndex"); }

   @Override
   public void setWorkingDirectory(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.setWorkingDirectory"); }

   @Override
   public void showPresentationPane(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.showPresentationPane"); }

   @Override
   public void tutorialQuizResponse(int p0, int p1, boolean p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p3) { throw new AssertionError("Unexpected RaiAckServerStub.tutorialQuizResponse"); }

   @Override
   public void explorerBeginInspect(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.editors.explorer.model.ObjectExplorerInspectionResult> p2) { throw new AssertionError("Unexpected RaiAckServerStub.explorerBeginInspect"); }

   @Override
   public void explorerEndInspect(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.explorerEndInspect"); }

   @Override
   public void explorerInspectObject(java.lang.String p0, java.lang.String p1, java.lang.String p2, java.lang.String p3, com.google.gwt.core.client.JsArrayString p4, int p5, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.editors.explorer.model.ObjectExplorerInspectionResult> p6) { throw new AssertionError("Unexpected RaiAckServerStub.explorerInspectObject"); }

   @Override
   public void cppProjectStyle(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p0) { throw new AssertionError("Unexpected RaiAckServerStub.cppProjectStyle"); }

   @Override
   public void cppSourceFile(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.cppSourceFile"); }

   @Override
   public void findCppUsages(java.lang.String p0, int p1, int p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p3) { throw new AssertionError("Unexpected RaiAckServerStub.findCppUsages"); }

   @Override
   public void getCppCompletions(java.lang.String p0, java.lang.String p1, java.lang.String p2, int p3, int p4, java.lang.String p5, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.CppCompletionResult> p6) { throw new AssertionError("Unexpected RaiAckServerStub.getCppCompletions"); }

   @Override
   public void goToCppDefinition(java.lang.String p0, int p1, int p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.CppSourceLocation> p3) { throw new AssertionError("Unexpected RaiAckServerStub.goToCppDefinition"); }

   @Override
   public void adaptToLanguage(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.adaptToLanguage"); }

   @Override
   public void checkForExternalEdit(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.CheckForExternalEditResult> p1) { throw new AssertionError("Unexpected RaiAckServerStub.checkForExternalEdit"); }

   @Override
   public void closeAllDocuments(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p0) { throw new AssertionError("Unexpected RaiAckServerStub.closeAllDocuments"); }

   @Override
   public void closeDocument(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.closeDocument"); }

   @Override
   public void createAliasedPath(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p1) { throw new AssertionError("Unexpected RaiAckServerStub.createAliasedPath"); }

   @Override
   public void createNotebook(org.rstudio.studio.client.notebook.CompileNotebookOptions p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.notebook.CompileNotebookResult> p1) { throw new AssertionError("Unexpected RaiAckServerStub.createNotebook"); }

   @Override
   public void createPlumberAPI(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p2) { throw new AssertionError("Unexpected RaiAckServerStub.createPlumberAPI"); }

   @Override
   public void createRdShell(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.RdShellResult> p2) { throw new AssertionError("Unexpected RaiAckServerStub.createRdShell"); }

   @Override
   public void createShinyApp(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p3) { throw new AssertionError("Unexpected RaiAckServerStub.createShinyApp"); }

   @Override
   public void defaultSqlConnectionName(org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p0) { throw new AssertionError("Unexpected RaiAckServerStub.defaultSqlConnectionName"); }

   @Override
   public void detectFreeVars(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<com.google.gwt.core.client.JsArrayString> p1) { throw new AssertionError("Unexpected RaiAckServerStub.detectFreeVars"); }

   @Override
   public void discoverPackageDependencies(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.events.AvailablePackagesReadyEvent.Data> p2) { throw new AssertionError("Unexpected RaiAckServerStub.discoverPackageDependencies"); }

   @Override
   public void ensureFileExists(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.ensureFileExists"); }

   @Override
   public void executeRCode(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p1) { throw new AssertionError("Unexpected RaiAckServerStub.executeRCode"); }

   @Override
   public void extractRmdFromNotebook(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceDocumentResult> p1) { throw new AssertionError("Unexpected RaiAckServerStub.extractRmdFromNotebook"); }

   @Override
   public void formatCode(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p3) { throw new AssertionError("Unexpected RaiAckServerStub.formatCode"); }

   @Override
   public void formatContext(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceServerOperations.FormatContext> p2) { throw new AssertionError("Unexpected RaiAckServerStub.formatContext"); }

   @Override
   public void formatDocument(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceServerOperations.FormatDocumentResult> p1) { throw new AssertionError("Unexpected RaiAckServerStub.formatDocument"); }

   @Override
   public void getDocumentProperties(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.core.client.js.JsObject> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getDocumentProperties"); }

   @Override
   public void getEditorContextCompleted(org.rstudio.studio.client.events.GetEditorContextEvent.SelectionData p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getEditorContextCompleted"); }

   @Override
   public void getFileContents(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getFileContents"); }

   @Override
   public void getMinimalSourcePath(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getMinimalSourcePath"); }

   @Override
   public void getScriptRunCommand(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getScriptRunCommand"); }

   @Override
   public void getSourceDocument(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceDocument> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getSourceDocument"); }

   @Override
   public void getSourceTemplate(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p2) { throw new AssertionError("Unexpected RaiAckServerStub.getSourceTemplate"); }

   @Override
   public void iconvlist(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.editors.text.IconvListResult> p0) { throw new AssertionError("Unexpected RaiAckServerStub.iconvlist"); }

   @Override
   public void ignoreExternalEdit(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.ignoreExternalEdit"); }

   @Override
   public void isReadOnlyFile(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.Boolean> p1) { throw new AssertionError("Unexpected RaiAckServerStub.isReadOnlyFile"); }

   @Override
   public void modifyDocumentProperties(java.lang.String p0, java.util.HashMap<java.lang.String, java.lang.String> p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.modifyDocumentProperties"); }

   @Override
   public void newDocument(java.lang.String p0, java.lang.String p1, org.rstudio.core.client.js.JsObject p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceDocument> p3) { throw new AssertionError("Unexpected RaiAckServerStub.newDocument"); }

   @Override
   public void openDocument(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceDocument> p3) { throw new AssertionError("Unexpected RaiAckServerStub.openDocument"); }

   @Override
   public void previewR2d3(java.lang.String p0, boolean p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.common.PreviewResult> p2) { throw new AssertionError("Unexpected RaiAckServerStub.previewR2d3"); }

   @Override
   public void removeCachedData(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.removeCachedData"); }

   @Override
   public void removeContentUrl(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.removeContentUrl"); }

   @Override
   public void reopenWithEncoding(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceDocument> p2) { throw new AssertionError("Unexpected RaiAckServerStub.reopenWithEncoding"); }

   @Override
   public void replaceCommentHeader(java.lang.String p0, java.lang.String p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p3) { throw new AssertionError("Unexpected RaiAckServerStub.replaceCommentHeader"); }

   @Override
   public void requestDocumentCloseCompleted(boolean p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.requestDocumentCloseCompleted"); }

   @Override
   public void requestDocumentSaveCompleted(boolean p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.requestDocumentSaveCompleted"); }

   @Override
   public void revertDocument(java.lang.String p0, java.lang.String p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.SourceDocument> p2) { throw new AssertionError("Unexpected RaiAckServerStub.revertDocument"); }

   @Override
   public void rstudioApiResponse(com.google.gwt.core.client.JavaScriptObject p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.rstudioApiResponse"); }

   @Override
   public void saveActiveDocument(java.lang.String p0, boolean p1, java.lang.String p2, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p3) { throw new AssertionError("Unexpected RaiAckServerStub.saveActiveDocument"); }

   @Override
   public void saveDocument(java.lang.String p0, java.lang.String p1, java.lang.String p2, java.lang.String p3, java.lang.String p4, com.google.gwt.core.client.JsArray<org.rstudio.studio.client.workbench.views.source.editors.text.rmd.ChunkDefinition> p5, java.lang.String p6, boolean p7, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p8) { throw new AssertionError("Unexpected RaiAckServerStub.saveDocument"); }

   @Override
   public void saveDocumentDiff(java.lang.String p0, java.lang.String p1, java.lang.String p2, java.lang.String p3, java.lang.String p4, com.google.gwt.core.client.JsArray<org.rstudio.studio.client.workbench.views.source.editors.text.rmd.ChunkDefinition> p5, java.lang.String p6, int p7, int p8, boolean p9, java.lang.String p10, boolean p11, org.rstudio.studio.client.server.ServerRequestCallback<java.lang.String> p12) { throw new AssertionError("Unexpected RaiAckServerStub.saveDocumentDiff"); }

   @Override
   public void setDocOrder(java.util.List<java.lang.String> p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p1) { throw new AssertionError("Unexpected RaiAckServerStub.setDocOrder"); }

   @Override
   public void setSourceDocumentDirty(java.lang.String p0, boolean p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.setSourceDocumentDirty"); }

   @Override
   public void setSourceDocumentOnSave(java.lang.String p0, boolean p1, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.server.VoidResponse> p2) { throw new AssertionError("Unexpected RaiAckServerStub.setSourceDocumentOnSave"); }

   @Override
   public void hasShinyTestResults(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.shiny.model.ShinyTestResults> p1) { throw new AssertionError("Unexpected RaiAckServerStub.hasShinyTestResults"); }

   @Override
   public void getChunkOptions(java.lang.String p0, org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.views.source.model.RnwChunkOptions> p1) { throw new AssertionError("Unexpected RaiAckServerStub.getChunkOptions"); }

   @Override
   public void getTexCapabilities(org.rstudio.studio.client.server.ServerRequestCallback<org.rstudio.studio.client.workbench.model.TexCapabilities> p0) { throw new AssertionError("Unexpected RaiAckServerStub.getTexCapabilities"); }

}
