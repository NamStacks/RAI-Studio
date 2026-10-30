package org.rstudio.studio.client.workbench.views.source;

import com.google.gwt.junit.client.GWTTestCase;
import com.google.gwt.user.client.Command;

public class RaiReplacementGuardTests extends GWTTestCase
{
   @Override
   public String getModuleName()
   {
      return "org.rstudio.studio.RStudioTests";
   }

   public void testExactPreimageAllowsReplacement()
   {
      assertTrue(Source.canApplyRaiReplacement(true, "x <- 1\n", "x <- 1\n"));
   }

   public void testUnsyncedHumanTypingRefusesReplacement()
   {
      assertFalse(Source.canApplyRaiReplacement(true, "x <- 1\n", "x <- 12\n"));
   }

   public void testEmptyPreimageIsValid()
   {
      assertTrue(Source.canApplyRaiReplacement(true, "", ""));
      assertFalse(Source.canApplyRaiReplacement(true, "", "human"));
   }

   public void testMissingPreimageFailsClosed()
   {
      assertFalse(Source.canApplyRaiReplacement(true, null, "human"));
      assertFalse(Source.canApplyRaiReplacement(true, null, null));
   }

   public void testEqualLengthAndUnicodeChangesRefuseReplacement()
   {
      assertFalse(Source.canApplyRaiReplacement(true, "x <- 1", "x <- 2"));
      assertFalse(Source.canApplyRaiReplacement(true, "\uD83D\uDE00", "\uD83D\uDE01"));
      assertFalse(Source.canApplyRaiReplacement(true, "x\n", "x\r\n"));
   }

   public void testLegacyReplacementIsUnaffected()
   {
      assertTrue(Source.canApplyRaiReplacement(false, null, "human"));
   }
   public void testReplacementPathPreservesHumanBufferOnConflict()
   {
      final String[] buffer = {"human typing"};
      final int[] conflicts = {0};
      Source.doReplaceRanges(true, "authorized read", buffer[0], new Command()
      {
         public void execute() { buffer[0] = "replacement"; }
      }, new Command()
      {
         public void execute() { conflicts[0]++; }
      });
      assertEquals("conflict must preserve human buffer", "human typing", buffer[0]);
      assertEquals("conflict must be reported once", 1, conflicts[0]);
   }

   public void testReplacementPathAppliesOnceAfterGuard()
   {
      final int[] applied = {0};
      Source.doReplaceRanges(true, "same", "same", new Command()
      {
         public void execute() { applied[0]++; }
      }, new Command()
      {
         public void execute() { fail("matching preimage must not conflict"); }
      });
      assertEquals("replacement must run once", 1, applied[0]);
   }

   public void testReplacementPathMissingPreimageNeverMutates()
   {
      final int[] conflicts = {0};
      Source.doReplaceRanges(true, null, "human", new Command()
      {
         public void execute() { fail("missing preimage must not mutate"); }
      }, new Command()
      {
         public void execute() { conflicts[0]++; }
      });
      assertEquals(1, conflicts[0]);
   }

   public void testTypingDuringSaveAcknowledgementKeepsDirty()
   {
      assertFalse("new typing must remain dirty", org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel.canMarkRaiSaveClean(true, true, "postimage", "human typing"));
      assertFalse("a changed generation stays dirty even after text returns to the postimage", org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel.canMarkRaiSaveClean(true, true, "postimage", "postimage"));
   }

   public void testFailedSaveAcknowledgementKeepsDirty()
   {
      assertFalse("failed save must never clear dirty", org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel.canMarkRaiSaveClean(false, false, "postimage", "postimage"));
   }

   public void testMatchingSaveAcknowledgementCanClearDirty()
   {
      assertTrue("only a matching acknowledged save can clear dirty", org.rstudio.studio.client.workbench.views.source.model.DocUpdateSentinel.canMarkRaiSaveClean(true, false, "postimage", "postimage"));
   }
}
