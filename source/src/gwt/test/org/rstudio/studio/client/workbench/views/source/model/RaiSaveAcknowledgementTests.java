package org.rstudio.studio.client.workbench.views.source.model;

import com.google.gwt.junit.client.GWTTestCase;
import com.google.gwt.core.client.JsArray;
import org.rstudio.studio.client.application.events.EventBus;
import org.rstudio.studio.client.workbench.views.source.editors.text.ace.AceFold;
import org.rstudio.studio.client.workbench.views.source.editors.text.rmd.ChunkDefinition;
import com.google.gwt.user.client.Command;
import org.rstudio.core.client.CommandWithArg;
import org.rstudio.core.client.js.JsObject;
import org.rstudio.studio.client.server.ServerRequestCallback;
import org.rstudio.studio.client.workbench.model.ChangeTracker;

public class RaiSaveAcknowledgementTests extends GWTTestCase
{
   @Override
   public String getModuleName() { return "org.rstudio.studio.RStudioTests"; }

   private static class Tracker implements ChangeTracker
   {
      final int[] generation;
      int saved;
      Tracker(int[] generation) { this.generation = generation; saved = generation[0]; }
      public boolean hasChanged() { return saved != generation[0]; }
      public void reset() { saved = generation[0]; }
      public ChangeTracker fork() { return new Tracker(generation); }
   }

   private static class Display extends RaiAckDocDisplayStub
   {
      public JsArray<AceFold> getFolds() { return JsArray.createArray().cast(); }
      int saveEvents;
      public void fireEvent(com.google.gwt.event.shared.GwtEvent<?> event) { saveEvents++; }
      String code = "postimage";
      final int[] generation = {1};
      final Tracker tracker = new Tracker(generation);
      public ChangeTracker getChangeTracker() { return tracker; }
      public String getCode() { return code; }
      public boolean hasActiveCollabSession() { return false; }
      void type(String text) { code = text; generation[0]++; }
   }

   private static class Server extends RaiAckServerStub
   {
      ServerRequestCallback<String> ordinary;
      public void saveDocumentDiff(String id, String path, String type, String encoding,
            String folds, JsArray<ChunkDefinition> chunks, String replacement, int offset,
            int length, boolean valid, String hash, boolean retry, ServerRequestCallback<String> callback)
      { ordinary = callback; }
      boolean accepted;
      int sourceExecutions;
      public void executeRCode(String code, ServerRequestCallback<String> callback) { sourceExecutions++; }
      ServerRequestCallback<JsObject> ack;
      public void raiDocumentEditAck(String id, boolean accepted, String postimage,
                                    ServerRequestCallback<JsObject> callback)
      {
         this.accepted = accepted;
         ack = callback;
      }
   }

   private class Fixture
   {
      final Display display = new Display();
      final Server server = new Server();
      final SourceDocument doc = document();
      final DocUpdateSentinel sentinel = new DocUpdateSentinel(server, display, doc,
            null, null, new EventBus(null, null) {
               @Override public void fireEvent(com.google.gwt.event.shared.GwtEvent<?> event) {}
            }, null, () -> null, false);
      int completed, failed, primarySaved, primaryFailed;
      int ordinaryCompleted, ordinaryFailed;
      void ordinary(boolean edit)
      {
         if (edit) display.type("human ordinary save");
         assertTrue("ordinary save must dispatch", ordinarySave(sentinel));
         assertNotNull("ordinary save callback must be captured", server.ordinary);
         queue(sentinel, () -> ordinaryCompleted++, message -> ordinaryFailed++);
         queue(sentinel, () -> ordinaryCompleted++, message -> ordinaryFailed++);
      }
      void assertOrdinaryPending()
      {
         assertEquals("RAI settlement must not drain ordinary save callers", 0, ordinaryCompleted + ordinaryFailed);
         assertFalse("ordinary save must keep saving flag while pending", sentinel.canApplyRaiEdit());
         assertEquals("ordinary save retains its own queue", 2, pending(sentinel));
      }
      void finishOrdinary()
      {
         server.ordinary.onResponseReceived("ordinary-hash");
         assertEquals("ordinary completion releases its own callers", 2, ordinaryCompleted);
         assertEquals(0, ordinaryFailed);
      }
      String error;
      final Command onSaved = () -> completed++;
      final CommandWithArg<String> onFailed = message -> { failed++; error = message; };

      void begin() { begin(true); }
      void begin(boolean accepted)
      {
         sentinel.acknowledgeRaiEdit("operation", accepted, "postimage",
               () -> primarySaved++, message -> primaryFailed++);
         sentinel.withSavedDoc(onSaved);
         sentinel.withSavedDocNoRetry(onSaved);
         queue(sentinel, onSaved, onFailed);
         queue(sentinel, onSaved, onFailed);
         assertEquals("callers wait while acknowledgement is pending", 0, completed + failed);
      }
      void response(boolean saved)
      {
         JsObject result = JsObject.createJsObject();
         result.setBoolean("saved", saved);
         result.setString("hash", "new-hash");
         result.setString("path", "/document.R");
         result.setString("message", saved ? "" : "conflict or write failure");
         server.ack.onResponseReceived(result);
      }
      void assertReleased()
      {
         assertTrue("RAI saving flag must be cleared", sentinel.canApplyRaiEdit());
         assertEquals("acknowledgement queue must be empty", 0, pending(sentinel));
      }
   }

   private static native SourceDocument document() /*-{
      return {id: "doc", path: "/document.R", contents: "preimage", hash: "old-hash",
              dirty: true, source_on_save: true};
   }-*/;

   private static native void queue(DocUpdateSentinel sentinel, Command saved,
                                    CommandWithArg<String> failed) /*-{
      sentinel.@org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel::withSavedDocImpl(ZLcom/google/gwt/user/client/Command;Lorg/rstudio/core/client/CommandWithArg;)(true, saved, failed);
   }-*/;

   private static native int pending(DocUpdateSentinel sentinel) /*-{
      return sentinel.@org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel::saveCommands_.@java.util.List::size()();
   }-*/;

   public void testConcurrentSavedDocSuccessSettles()
   {
      Fixture f = new Fixture(); f.begin(); f.response(true);
      assertEquals("successful RAI acknowledgement must release all waiting callers", 4, f.completed);
      assertEquals(0, f.failed); assertEquals(1, f.primarySaved);
      assertFalse(f.doc.isDirty()); assertEquals("postimage", f.doc.getContents());
      f.assertReleased();
   }

   public void testConcurrentSavedDocFailureSettles()
   {
      Fixture f = new Fixture(); f.begin(); f.server.ack.onError(null);
      assertEquals("failed RAI acknowledgement must reject waiting callers", 2, f.failed);
      assertEquals(0, f.completed); assertEquals(1, f.primaryFailed);
      assertTrue(f.doc.isDirty()); f.assertReleased();
   }

   public void testConcurrentSavedDocConflictSettles()
   {
      Fixture f = new Fixture(); f.begin(false); f.response(false);
      assertFalse("conflict must use the refusal acknowledgement", f.server.accepted);
      assertEquals("conflicted RAI acknowledgement must reject waiting callers", 2, f.failed);
      assertEquals(0, f.completed); assertEquals(1, f.primaryFailed);
      assertTrue(f.doc.isDirty()); f.assertReleased();
   }

   public void testNewHumanEditsPreserved()
   {
      Fixture f = new Fixture(); f.begin(); f.display.type("human typing"); f.response(true);
      assertEquals("human typing", f.display.getCode());
      assertTrue("new human edits must remain dirty", f.display.tracker.hasChanged());
      assertTrue(f.doc.isDirty()); assertEquals("preimage", f.doc.getContents());
      assertEquals("newer edits must reject stale saved-doc continuations", 2, f.failed);
      assertEquals(0, f.completed); f.assertReleased();
   }

   public void testUndoToPostimagePreservesGeneration()
   {
      Fixture f = new Fixture(); f.begin(); f.display.type("human");
      f.display.type("postimage"); f.response(true);
      assertTrue("undo to identical bytes must retain changed generation", f.display.tracker.hasChanged());
      assertTrue(f.doc.isDirty()); assertEquals(2, f.failed); f.assertReleased();
   }

   public void testNoSourceOnSaveOrFixups()
   {
      Fixture f = new Fixture(); f.begin(); f.response(true);
      // Source-on-save is enabled; unexpected RPCs, editor fixups or save events throw in the stubs
      assertTrue("source-on-save remains enabled without being invoked", f.sentinel.sourceOnSave());
      assertEquals("RAI settlement must bypass normal save execution", 4, f.completed);
      assertEquals("postimage", f.display.getCode());
      assertNull("RAI acknowledgement must never dispatch an ordinary save", f.server.ordinary);
      assertEquals("source-on-save execution must never run", 0, f.server.sourceExecutions);
      assertEquals("source-on-save events must never fire", 0, f.display.saveEvents); f.assertReleased();
   }

   public void testDuplicateAcknowledgementsDoNotSettleTwice()
   {
      Fixture f = new Fixture(); f.begin(); f.response(true);
      f.response(true); f.server.ack.onError(null); f.response(false);
      assertEquals("waiting callers must settle exactly once", 4, f.completed);
      assertEquals(0, f.failed);
      assertEquals("primary acknowledgement must settle exactly once", 1, f.primarySaved);
      assertEquals(0, f.primaryFailed); f.assertReleased();
   }

   public void testFailureThenLateSuccessDoesNotClearNewEdits()
   {
      Fixture f = new Fixture(); f.begin(); f.server.ack.onError(null);
      f.display.type("later human"); f.response(true);
      assertEquals(2, f.failed); assertEquals(0, f.completed);
      assertEquals(1, f.primaryFailed); assertEquals(0, f.primarySaved);
      assertTrue(f.doc.isDirty()); assertEquals("later human", f.display.getCode()); f.assertReleased();
   }

   public void testTimeoutSettlesAndIgnoresLateAck()
   {
      Fixture f = new Fixture(); f.begin();
      assertTrue("acknowledgement must arm a timeout", hasTimeout(f.sentinel));
      timeout(f.sentinel);
      assertEquals("timed out acknowledgement must reject waiting callers", 2, f.failed);
      f.response(true);
      assertEquals(0, f.completed); assertEquals(0, f.primarySaved);
      assertEquals(1, f.primaryFailed); assertTrue(f.doc.isDirty()); f.assertReleased();
   }

   public void testOrdinaryPendingRaiFailure()
   {
      Fixture f = new Fixture(); f.begin(); f.ordinary(true); f.server.ack.onError(null);
      f.assertOrdinaryPending(); assertEquals(2, f.failed);
      f.finishOrdinary(); f.assertReleased();
   }

   public void testOrdinaryPendingRaiTimeout()
   {
      Fixture f = new Fixture(); f.begin(); f.ordinary(true);
      assertTrue("acknowledgement must arm a timeout", hasTimeout(f.sentinel));
      timeout(f.sentinel);
      f.assertOrdinaryPending(); f.response(true); f.assertOrdinaryPending();
      f.finishOrdinary(); f.assertReleased();
   }

   public void testBusyOrdinaryRefusalOwnsNothing()
   {
      Fixture f = new Fixture(); f.ordinary(true);
      f.sentinel.acknowledgeRaiEdit("busy", false, "postimage",
            () -> f.primarySaved++, message -> f.primaryFailed++);
      assertFalse("busy editor still sends a refusal acknowledgement", f.server.accepted);
      f.response(false); f.assertOrdinaryPending(); assertEquals(1, f.primaryFailed);
      f.finishOrdinary(); f.assertReleased();
   }

   public void testOrdinaryPendingRaiSuccess()
   {
      Fixture f = new Fixture(); f.begin(); f.ordinary(false); f.response(true);
      f.assertOrdinaryPending();
      assertEquals("superseded RAI owner must not mark document clean", 0, f.primarySaved);
      assertEquals("preimage", f.doc.getContents());
      f.finishOrdinary(); f.assertReleased();
   }

   public void testOrdinaryFinishesBeforeRai()
   {
      Fixture f = new Fixture(); f.begin(); f.ordinary(false); f.finishOrdinary();
      assertFalse("RAI request still owns saving state", f.sentinel.canApplyRaiEdit());
      assertEquals("ordinary completion must not release RAI callers", 0, f.completed + f.failed);
      f.response(true);
      assertEquals("superseded RAI owner must preserve ordinary hash", "ordinary-hash", f.doc.getHash());
      assertEquals(2, f.failed); f.assertReleased();
   }

   public void testBusyRaiRefusalPreservesOwner()
   {
      Fixture f = new Fixture(); f.begin();
      ServerRequestCallback<JsObject> first = f.server.ack;
      f.sentinel.acknowledgeRaiEdit("busy", false, "postimage",
            () -> f.primarySaved++, message -> f.primaryFailed++);
      f.response(false);
      assertEquals("refusal must not drain another RAI owner's callers", 0, f.completed + f.failed);
      assertFalse("refusal must not clear another RAI owner's flag", f.sentinel.canApplyRaiEdit());
      f.server.ack = first; f.response(true);
      assertEquals(4, f.completed); assertEquals(0, f.failed); f.assertReleased();
   }

   public void testRaiWaitersSettleOnceWithoutOrdinarySave()
   {
      Fixture f = new Fixture(); f.begin();
      assertTrue("acknowledgement must arm a timeout", hasTimeout(f.sentinel));
      timeout(f.sentinel);
      f.server.ack.onError(null); f.response(false); f.response(true);
      assertEquals("RAI waiters fail exactly once without an ordinary save", 2, f.failed);
      assertEquals(0, f.completed); assertEquals(1, f.primaryFailed); f.assertReleased();
   }

   private static native boolean ordinarySave(DocUpdateSentinel sentinel) /*-{
      return sentinel.@org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel::doSaveImpl(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ZLorg/rstudio/core/client/widget/ProgressIndicator;)(null, null, null, true, null);
   }-*/;

   private static native boolean hasTimeout(DocUpdateSentinel sentinel) /*-{
      return sentinel.@org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel::raiSaveTimeout_ != null;
   }-*/;

   private static native void timeout(DocUpdateSentinel sentinel) /*-{
      sentinel.@org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel::raiSaveTimeout_.@com.google.gwt.user.client.Timer::run()();
   }-*/;
}
