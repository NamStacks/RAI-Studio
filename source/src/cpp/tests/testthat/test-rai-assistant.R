#
# test-rai-assistant.R
#
# Copyright (C) 2026 by Posit Software, PBC
#
# Unless you have received this program directly from Posit Software pursuant
# to the terms of a commercial license agreement with Posit Software, then
# this program is licensed to you under the terms of version 3 of the
# GNU Affero General Public License. This program is distributed WITHOUT
# ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
# MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
# AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
#

context("RAI Assistant approvals")

rai_env <- new.env(parent = as.environment("tools:rstudio"))
source(file.path(.rs.sessionModulePath(), "SessionRaiAssistant.R"), local = rai_env)

# Model the fixed native policy; historical requests are seeded explicitly.
# Retain the real wrapper for narrowly scoped native-result refusal checks
rai_native_auto_approve <- get(".rs.rai.autoApproveReadOnlyEnabled", envir = rai_env)
assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
assign(".rs.rai.ownerToken", function() Sys.getenv("RAI_OWNER_TOKEN"), envir = rai_env)

rai_read_document_fixture <- function(text)
{
   connection <- rawConnection(charToRaw(text))
   on.exit(close(connection))
   contents <- rawToChar(readBin(connection, "raw", n = nchar(text, type = "bytes") + 1L))
   stopifnot(identical(contents, text))
   previous <- rai_get(".rs.rai.documentReadDigest")
   assign(".rs.rai.documentReadDigest", function(documentId) digest::digest(contents, algo = "sha256", serialize = FALSE), rai_env)
   previous
}

rai_get <- function(name)
{
   get(name, envir = rai_env, inherits = FALSE)
}

rai_approval_id <- function(value)
{
   sub("^approval_required: ", "", value)
}

rai_reset_grants <- function()
{
   state <- rai_get(".rs.rai.grantState")
   for (store in list(state$requests, state$once, state$session))
      rm(list = ls(store, all.names = TRUE), envir = store)
}

rai_restore_envvar <- function(name, value)
{
   if (is.na(value))
      Sys.unsetenv(name)
   else
      do.call(Sys.setenv, setNames(list(value), name))
}

rai_reset_runs <- function()
{
   state <- rai_get(".rs.rai.runState")
   rm(list = ls(state$records, all.names = TRUE), envir = state$records)
   rai_get(".rs.rai.setRunLimits")(maxRuns = 20L, runTtlSecs = 600, resultTtlSecs = 1800)
}

rai_queue <- function(code, max_lines = 200L, proposal_id = paste0("proposal-", code))
{
   rai_get(".rs.rai.queueConsoleRun")(proposal_id, code, max_lines)
}

test_that("grants require exact tool, path, and domain", {
   grant <- list(
      tool = "edit_document",
      path = "src/modules/assistant.R",
      domain = "project"
   )

   expect_true(rai_get(".rs.rai.grantMatches")(
      "edit_document",
      list(path = "src/modules/assistant.R", domain = "project"),
      grant
   ))
   expect_false(rai_get(".rs.rai.grantMatches")(
      "run_r",
      list(path = "src/modules/assistant.R", domain = "project"),
      grant
   ))
   expect_false(rai_get(".rs.rai.grantMatches")(
      "edit_document",
      list(path = "src/modules/other.R", domain = "project"),
      grant
   ))
   expect_false(rai_get(".rs.rai.grantMatches")(
      "edit_document",
      list(path = "src/modules/assistant.R", domain = "session"),
      grant
   ))
})

test_that("once grants are consumed exactly once", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")

   target <- list(path = "", domain = "r")
   # Historical grant primitive: fresh Console gates are automatic, so create
   # the old request directly rather than inferring consent from a fresh call.
   first <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      target, autoApprove = FALSE)
   expect_match(first, "^approval_required: ")

   request_id <- rai_approval_id(first)
   result <- rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")
   expect_identical(result$status, "granted")
   digest <- rai_get(".rs.rai.proposalDigest")("run_r", target, NULL)
   other_digest <- rai_get(".rs.rai.proposalDigest")("run_r", target, "21 + 21")
   expect_false(rai_get(".rs.rai.findGrant")("run_r", target, other_digest))
   expect_true(exists(request_id, envir = rai_get(".rs.rai.grantState")$once, inherits = FALSE))
   expect_true(rai_get(".rs.rai.findGrant")("run_r", target, digest))
   expect_false(rai_get(".rs.rai.findGrant")("run_r", target, digest))
})

test_that("declined requests stay blocked", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-1", path = "R/one.R", temp_name = NULL)),
      envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   target <- "doc-1"
   request <- rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", target)
   request_id <- rai_approval_id(request)
   result <- rai_get(".rs.rai.recordGrant")(request_id, "decline", "once")

   expect_identical(result$status, "declined")
   expect_identical(
      rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", target),
      "blocked: approval declined"
   )
})

test_that("a historical editor card retains its exact one-time payload", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-1", path = "R/analysis.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   # Historical manual card, pinned exactly as queueDocumentEdit stored it.
   historical <- rai_get(".rs.rai.requestApproval")("edit_document",
      "Approval required for edit_document", "doc-1",
      "Replace the exact highlighted text in the open editor.",
      paste0("--- current text\n", "x <- 1", "\n+++ replacement\n", "x <- 2"),
      digestPayload = paste("x <- 1", "x <- 2", "", "", sep = "\037"),
      documentEdit = list(expected = "x <- 1", replacement = "x <- 2",
         context_before = "", context_after = "", path = "R/analysis.R"), autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   before <- as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE)
   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-1", "x <- 1", "x <- 2")
   expect_identical(queued$request_id, rai_approval_id(historical))
   expect_identical(as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE), before)
   expect_identical(queued$status, "approval_required")
   state <- rai_get(".rs.rai.grantState")
   key <- rai_get(".rs.rai.requestKey")("edit_document", list(path = "doc-1", domain = "r"))
   request <- get(key, envir = state$requests, inherits = FALSE)
   expect_identical(request$document_edit$expected, "x <- 1")
   expect_identical(request$document_edit$replacement, "x <- 2")
   expect_match(request$diff, "x <- 1", fixed = TRUE)
   expect_match(request$diff, "x <- 2", fixed = TRUE)
   expect_identical(rai_get(".rs.rai.recordGrant")(queued$request_id, "allow", "session")$status, "error")
})

test_that("an approved editor request prepares one native apply and settles only after native completion", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-approval", path = "R/analysis.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   # Historical manual card, pinned exactly as queueDocumentEdit stored it.
   historical <- rai_get(".rs.rai.requestApproval")("edit_document",
      "Approval required for edit_document", "doc-approval",
      "Replace the exact highlighted text in the open editor.",
      paste0("--- current text\n", "x <- 1", "\n+++ replacement\n", "x <- 2"),
      digestPayload = paste("x <- 1", "x <- 2", "", "", sep = "\037"),
      documentEdit = list(expected = "x <- 1", replacement = "x <- 2",
         context_before = "", context_after = "", path = "R/analysis.R"), autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-approval", "x <- 1", "x <- 2")
   prepared <- rai_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")
   expect_identical(prepared$status, "apply_document")
   expect_identical(prepared$document_id, "doc-approval")
   expect_identical(prepared$expected_text, "x <- 1")
   expect_identical(prepared$replacement, "x <- 2")
   before <- as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE)
   retry <- rai_get(".rs.rai.queueDocumentEdit")("doc-approval", "x <- 1", "x <- 2")
   expect_identical(retry, list(status = "applying", request_id = queued$request_id))
   expect_identical(as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE), before)

   # A second approval cannot produce a second native mutation while the first
   # one is pending completion.
   expect_identical(
      rai_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")$status,
      "error"
   )

   completed <- rai_get(".rs.rai.completeDocumentEdit")(queued$request_id, TRUE)
   expect_identical(completed$status, "applied")
   expect_identical(
      rai_get(".rs.rai.completeDocumentEdit")(queued$request_id, TRUE)$status,
      "error"
   )
})

test_that("a different editor proposal cannot orphan a visible Allow-once card", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "fixture-a", path = "fixture-a.R", temp_name = NULL),
           list(id = "fixture-b", path = "fixture-b.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   queue <- rai_get(".rs.rai.queueDocumentEdit")
   decide <- rai_get(".rs.rai.recordGrant")
   finish <- rai_get(".rs.rai.completeDocumentEdit")
   # Historical manual card, pinned exactly as queueDocumentEdit stored it.
   historical <- rai_get(".rs.rai.requestApproval")("edit_document",
      "Approval required for edit_document", "fixture-a",
      "Replace the exact highlighted text in the open editor.",
      paste0("--- current text\n", "x <- 1", "\n+++ replacement\n", "x <- 2"),
      digestPayload = paste("x <- 1", "x <- 2", "", "", sep = "\037"),
      documentEdit = list(expected = "x <- 1", replacement = "x <- 2",
         context_before = "", context_after = "", path = "fixture-a.R"), autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   first <- queue("fixture-a", "x <- 1", "x <- 2")
   expect_identical(queue("fixture-a", "x <- 1", "x <- 2")$request_id, first$request_id)
   changed <- queue("fixture-a", "x <- 1", "x <- 3")
   expect_identical(changed$status, "error")
   expect_match(changed$message, "awaiting its exact approval")
   expect_identical(decide(first$request_id, "allow", "once")$status, "apply_document")
   expect_identical(decide(first$request_id, "allow", "once")$status, "error")
   expect_identical(finish(first$request_id, TRUE)$status, "applied")
   expect_identical(decide(first$request_id, "allow", "once")$status, "error")
   fresh <- queue("fixture-a", "x <- 1", "x <- 3")
   expect_identical(fresh$status, "applying")
   expect_identical(fresh$approval, "autonomous")
   expect_false(identical(fresh$request_id, first$request_id))

   other_document <- queue("fixture-b", "x <- 1", "x <- 2")
   expect_identical(decide(other_document$request_id, "allow", "once")$document_id, "fixture-b")
   expect_identical(decide("rai-not-a-request", "allow", "once")$status, "error")
})

test_that("expired editor cards fail closed and require a fresh proposal", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "fixture-expired", path = "fixture-expired.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)
   queue <- rai_get(".rs.rai.queueDocumentEdit")
   # Historical manual card, pinned exactly as queueDocumentEdit stored it.
   historical <- rai_get(".rs.rai.requestApproval")("edit_document",
      "Approval required for edit_document", "fixture-expired",
      "Replace the exact highlighted text in the open editor.",
      paste0("--- current text\n", "x <- 1", "\n+++ replacement\n", "x <- 2"),
      digestPayload = paste("x <- 1", "x <- 2", "", "", sep = "\037"),
      documentEdit = list(expected = "x <- 1", replacement = "x <- 2",
         context_before = "", context_after = "", path = "fixture-expired.R"), autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   first <- queue("fixture-expired", "x <- 1", "x <- 2")
   state <- rai_get(".rs.rai.grantState")
   key <- rai_get(".rs.rai.requestKey")("edit_document", list(path = "fixture-expired", domain = "r"))
   stored <- get(key, envir = state$requests, inherits = FALSE)
   stored$created_at <- Sys.time() - 3600
   assign(key, stored, envir = state$requests)
   rejected <- rai_get(".rs.rai.recordGrant")(first$request_id, "allow", "once")
   expect_identical(rejected$status, "error")
   expect_match(rejected$message, "expired")
   fresh <- queue("fixture-expired", "x <- 1", "x <- 2")
   expect_identical(fresh$status, "applying")
   expect_identical(fresh$approval, "autonomous")
   expect_false(identical(fresh$request_id, first$request_id))
   expect_identical(rai_get(".rs.rai.recordGrant")(first$request_id, "allow", "once")$status,
                    "error")
   rai_reset_grants() # synthetic session reset -- a stale card has no authority
   expect_identical(rai_get(".rs.rai.recordGrant")(fresh$request_id, "allow", "once")$status,
                    "error")
})

test_that("run_r canonicalizes NULL to the R Console target", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   event <- NULL
   had_enqueue <- exists(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   old_enqueue <- if (had_enqueue)
      get(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   assign(".rs.enqueClientEvent", function(type, data) event <<- data,
          envir = rai_env)
   on.exit({
      if (had_enqueue)
         assign(".rs.enqueClientEvent", old_enqueue, envir = rai_env)
      else
         rm(".rs.enqueClientEvent", envir = rai_env)
   }, add = TRUE)

   request <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r", NULL,
      preview = "preview", diff = "diff", autoApprove = FALSE)
   expect_match(request, "^approval_required: ")
   expect_identical(event$request_id, rai_approval_id(request))
   expect_identical(event$tool, "run_r")
   expect_identical(event$reason, "Approval required for run_r")
   expect_identical(event$target, "R Console")
   expect_identical(event$preview, "preview")
   expect_identical(event$diff, "diff")
})

test_that("a pending approval enqueues the rai_approval_request client event by its string name", {
   # .rs.enqueClientEvent() dispatches by name -- see ModuleTools.R -- and
   # rai_approval_request maps to kRaiApprovalRequest=210 in
   # SessionClientEvent.cpp. That mapping happens on the C++ side; the R
   # broker must always hand it the string name, never the numeric id, or
   # the client event dispatch silently breaks. Guard the contract here.
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   event_type <- NULL
   had_enqueue <- exists(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   old_enqueue <- if (had_enqueue)
      get(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   assign(".rs.enqueClientEvent", function(type, data) event_type <<- type,
          envir = rai_env)
   on.exit({
      if (had_enqueue)
         assign(".rs.enqueClientEvent", old_enqueue, envir = rai_env)
      else
         rm(".rs.enqueClientEvent", envir = rai_env)
   }, add = TRUE)

   request <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r", NULL,
      autoApprove = FALSE)
   expect_match(request, "^approval_required: ")
   expect_true(is.character(event_type))
   expect_identical(event_type, "rai_approval_request")
})

test_that("recordGrant takes no client-submitted target -- only requestId/decision/scope", {
   # This is the contract that makes the broker authoritative: the UI cannot
   # supply or reconstruct a tool/path/domain pattern at all, so it cannot
   # broaden a grant beyond the pre-stored request. If this ever grows a
   # fourth parameter again, this test is meant to fail loudly.
   expect_identical(
      names(formals(rai_get(".rs.rai.recordGrant"))),
      c("requestId", "decision", "scope")
   )
})

test_that("granting one pending request does not escalate to a different target", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "one.R", path = "one.R", temp_name = NULL),
           list(id = "two.R", path = "two.R", temp_name = NULL)),
      envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   target <- list(path = "one.R", domain = "project")
   request <- rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", target)
   request_id <- rai_approval_id(request)

   expect_identical(
      rai_get(".rs.rai.recordGrant")(request_id, "allow", "session")$status,
      "granted"
   )
   canonical <- rai_get(".rs.rai.canonicalTarget")("edit_document", target)
   expect_true(rai_get(".rs.rai.findGrant")("edit_document", canonical))
   expect_true(rai_get(".rs.rai.findGrant")("edit_document", canonical))
   expect_false(rai_get(".rs.rai.findGrant")("edit_document",
      rai_get(".rs.rai.canonicalTarget")("edit_document", list(path = "two.R", domain = "project"))))
})

test_that("a request whose stored target contains wildcard characters cannot be granted", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "weird*file.R", path = "weird*file.R", temp_name = NULL)),
      envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   target <- list(path = "weird*file.R", domain = "project")
   request <- rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", target)
   request_id <- rai_approval_id(request)

   for (scope in c("once", "session", "project"))
   {
      result <- rai_get(".rs.rai.recordGrant")(request_id, "allow", scope)
      expect_identical(result$status, "error")
   }
})

test_that("edit_document approval events resolve a human path via the safe document lookup", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-42", path = "R/analysis.R", temp_name = NULL)),
      envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   event <- NULL
   had_enqueue <- exists(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   old_enqueue <- if (had_enqueue)
      get(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   assign(".rs.enqueClientEvent", function(type, data) event <<- data,
          envir = rai_env)
   on.exit({
      if (had_enqueue)
         assign(".rs.enqueClientEvent", old_enqueue, envir = rai_env)
      else
         rm(".rs.enqueClientEvent", envir = rai_env)
   }, add = TRUE)

   request <- rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", "doc-42")
   expect_match(request, "^approval_required: ")
   expect_identical(event$target, "R/analysis.R")
})

test_that("edit_document approval requests reject an id that is not an open document", {
   # The document id is untrusted input from the tool caller. It must be
   # validated against the broker's own open-document listing before it can
   # become an approval target -- never taken on faith, and never allowed to
   # fall back to the raw (unverified) value.
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function() list(), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   event <- NULL
   had_enqueue <- exists(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   old_enqueue <- if (had_enqueue)
      get(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   assign(".rs.enqueClientEvent", function(type, data) event <<- data,
          envir = rai_env)
   on.exit({
      if (had_enqueue)
         assign(".rs.enqueClientEvent", old_enqueue, envir = rai_env)
      else
         rm(".rs.enqueClientEvent", envir = rai_env)
   }, add = TRUE)

   request <- rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", "doc-missing")
   expect_identical(request, "blocked: invalid approval target")
   expect_null(event)
})

test_that("the displayed document path is cosmetic and cannot authorize a different document", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(
         list(id = "doc-42", path = "R/analysis.R", temp_name = NULL),
         list(id = "doc-43", path = "R/analysis.R", temp_name = NULL)
      ),
      envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   request <- rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", "doc-42")
   request_id <- rai_approval_id(request)
   expect_identical(
      rai_get(".rs.rai.recordGrant")(request_id, "allow", "session")$status,
      "granted"
   )

   # Both documents display identically ("R/analysis.R"); only the internal
   # id is what's actually authorized, proving the display value is never
   # consulted for the grant decision.
   expect_identical(rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", "doc-42"), "ok")
   expect_match(
      rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", "doc-43"),
      "^approval_required: "
   )
})

test_that("project policies require a MAC and self-written policies round trip", {
   skip_if_not_installed("jsonlite")
   old_home <- Sys.getenv("HOME", unset = NA_character_)
   had_project <- exists(".rs.getProjectDirectory", envir = rai_env, inherits = FALSE)
   old_project <- if (had_project)
      get(".rs.getProjectDirectory", envir = rai_env, inherits = FALSE)
   home <- tempfile("rai-home-")
   project <- tempfile("rai-project-")
   dir.create(home)
   dir.create(project)
   Sys.setenv(HOME = home)
   assign(".rs.getProjectDirectory", function() project, envir = rai_env)
   on.exit({
      rai_restore_envvar("HOME", old_home)
      if (had_project)
         assign(".rs.getProjectDirectory", old_project, envir = rai_env)
      else
         rm(".rs.getProjectDirectory", envir = rai_env)
      unlink(c(home, project), recursive = TRUE, force = TRUE)
   }, add = TRUE)

   dir.create(file.path(project, ".raistudio"))
   policy <- file.path(project, ".raistudio", "policy.json")
   grants <- list(list(tool = "edit_document", path = "one.R", domain = "project"))
   writeLines(jsonlite::toJSON(list(version = 1L, grants = grants), auto_unbox = TRUE),
              policy)
   expect_identical(rai_get(".rs.rai.readProjectGrants")(), list())

   expect_true(rai_get(".rs.rai.writeProjectGrants")(grants))
   saved <- jsonlite::fromJSON(policy, simplifyVector = FALSE)
   expect_identical(saved$version, 1L)
   expect_true(is.character(saved$mac) && nzchar(saved$mac))
   expect_identical(rai_get(".rs.rai.readProjectGrants")(), grants)

   saved$grants[[1L]]$path <- "**"
   writeLines(jsonlite::toJSON(saved, auto_unbox = TRUE), policy)
   expect_identical(rai_get(".rs.rai.readProjectGrants")(), list())
})

test_that("project policies cannot be copied between project roots", {
   skip_if_not_installed("jsonlite")
   old_home <- Sys.getenv("HOME", unset = NA_character_)
   had_project <- exists(".rs.getProjectDirectory", envir = rai_env, inherits = FALSE)
   old_project <- if (had_project)
      get(".rs.getProjectDirectory", envir = rai_env, inherits = FALSE)
   home <- tempfile("rai-home-")
   project_a <- tempfile("rai-project-a-")
   project_b <- tempfile("rai-project-b-")
   dir.create(home)
   dir.create(project_a)
   dir.create(project_b)
   project <- project_a
   Sys.setenv(HOME = home)
   assign(".rs.getProjectDirectory", function() project, envir = rai_env)
   on.exit({
      rai_restore_envvar("HOME", old_home)
      if (had_project)
         assign(".rs.getProjectDirectory", old_project, envir = rai_env)
      else
         rm(".rs.getProjectDirectory", envir = rai_env)
      unlink(c(home, project_a, project_b), recursive = TRUE, force = TRUE)
   }, add = TRUE)

   grants <- list(list(tool = "edit_document", path = "one.R", domain = "project"))
   expect_true(rai_get(".rs.rai.writeProjectGrants")(grants))
   dir.create(file.path(project_b, ".raistudio"))
   expect_true(file.copy(file.path(project_a, ".raistudio", "policy.json"),
                         file.path(project_b, ".raistudio", "policy.json")))
   project <- project_b
   expect_identical(rai_get(".rs.rai.readProjectGrants")(), list())
})

context("RAI Assistant console run-result loop")

# The native session module now owns raw Console input and output capture. R no
# longer evaluates the approved source in a wrapper -- .rs.rai.recordConsoleCapture
# receives the natively-captured stdout/stderr and stores it for polling. These
# tests exercise that registry contract with simulated captures.

rai_capture <- function(run_id, stdout = "", stderr = "", elapsed = 1)
   rai_get(".rs.rai.recordConsoleCapture")(run_id, stdout, stderr, elapsed,
      conditionState = if (grepl("(^|\\n)Error", stderr)) "error" else "none",
      nativeErrorText = stderr)

test_that("the wrapper evaluator is gone -- raw source is never evaluated in R", {
   # A visible/internal wrapper such as .rs.rai.consoleRun does not satisfy the
   # raw-native-Console requirement; guard against its reintroduction.
   expect_false(exists(".rs.rai.consoleRun", envir = rai_env, inherits = FALSE))
   expect_true(exists(".rs.rai.recordConsoleCapture", envir = rai_env, inherits = FALSE))
})

test_that("a registered console run stays pending until a capture is recorded", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   register_run <- rai_get(".rs.rai.registerRun")
   # braces keep this one top-level expression -- "cat(...); 41 + 1" would be
   # two, which run_r rejects (see the single-statement tests below).
   run_id <- register_run("{ cat('hello\\n'); 41 + 1 }", 200L)
   expect_match(run_id, "^run-")
   expect_identical(
      rai_get(".rs.rai.getRunResult")(run_id),
      list(status = "pending", run_id = run_id)
   )

   # The native Console prints both the cat() output and the value "[1] 42".
   rai_capture(run_id, stdout = "hello\n[1] 42")
   result <- rai_get(".rs.rai.getRunResult")(run_id)

   expect_identical(result$status, "ok")
   expect_match(result$stdout, "hello")
   expect_match(result$stdout, "42")
   expect_null(result$error)
   expect_true(is.numeric(result$elapsed_ms) && result$elapsed_ms >= 0)
})

test_that("registered runs retain an exact code hash when SHA-256 is available", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   record <- get(run_id, envir = rai_get(".rs.rai.runState")$records, inherits = FALSE)

   if (requireNamespace("digest", quietly = TRUE))
      expect_identical(record$code_hash, digest::digest("1 + 1", algo = "sha256", serialize = FALSE))
   else
      expect_null(record$code_hash)
})

test_that("recordConsoleCapture bounds captured stdout at the run's max_lines", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("for (i in 1:5) cat(i, '\\n')", 2L)
   rai_capture(run_id, stdout = paste(1:5, collapse = "\n"))
   result <- rai_get(".rs.rai.getRunResult")(run_id)

   expect_identical(result$status, "ok")
   expect_match(result$stdout, "more line\\(s\\) hidden")
   expect_identical(length(strsplit(result$stdout, "\n")[[1L]]), 3L)
})

test_that("recordConsoleCapture derives error status from the error stream", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("stop('boom')", 200L)
   rai_capture(run_id, stderr = "Error: boom")
   result <- rai_get(".rs.rai.getRunResult")(run_id)

   expect_identical(result$status, "error")
   expect_match(result$error, "boom")
   expect_match(result$stderr, "boom")
})

test_that("recordConsoleCapture is single-shot and will not overwrite a settled run", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   rai_capture(run_id, stdout = "[1] 2")
   first <- rai_get(".rs.rai.getRunResult")(run_id)

   expect_error(rai_capture(run_id, stdout = "[1] 999"), NA)
   second <- rai_get(".rs.rai.getRunResult")(run_id)
   expect_identical(first, second)
})

test_that("a clean capture is reported as untainted", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("20 + 22", 200L)
   rai_capture(run_id, stdout = "[1] 42")
   result <- rai_get(".rs.rai.getRunResult")(run_id)

   expect_false(result$tainted)
   expect_null(result$taint_reason)
})

# The native capture attributes everything between the correlated input and the
# next top-level prompt to this run. If something else reached the Console in
# that window, the text may not be this run's alone -- it is still stored, but
# labelled so the caller cannot mistake it for a clean measurement.
test_that("a capture with interleaved console input is stored but marked tainted", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("20 + 22", 200L)
   rai_get(".rs.rai.recordConsoleCapture")(
      run_id, "[1] 42", "", 1,
      TRUE, "console input other than the approved source ran during capture"
   )
   result <- rai_get(".rs.rai.getRunResult")(run_id)

   expect_identical(result$status, "ok")
   expect_match(result$stdout, "42")
   expect_true(result$tainted)
   expect_match(result$taint_reason, "during capture")
})

test_that("recordConsoleCapture ignores an unknown run id without erroring", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   expect_error(rai_capture("run-never-registered", stdout = "x"), NA)
   expect_identical(
      rai_get(".rs.rai.getRunResult")("run-never-registered")$status,
      "unknown"
   )
})

test_that("getRunResult reports a stable object contract for every run state", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   get_run_result <- rai_get(".rs.rai.getRunResult")

   missing <- get_run_result("")
   expect_identical(missing$status, "unknown")
   expect_null(missing$run_id)
   expect_true(is.character(missing$message))

   unknown <- get_run_result("run-never")
   expect_identical(unknown$status, "unknown")
   expect_identical(unknown$run_id, "run-never")
   expect_match(unknown$message, "^unknown run id: run-never;")

   run_id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   expect_identical(get_run_result(run_id),
                    list(status = "pending", run_id = run_id))

   rai_capture(run_id, stdout = "[1] 2")
   settled <- get_run_result(run_id)
   expect_identical(settled$status, "ok")
   expect_identical(settled$run_id, run_id)
   expect_match(settled$stdout, "2")
})

test_that("terminalizeRun makes enqueue failure deterministic", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("20 + 22", 200L,
                                             "proposal-failed", "digest-failed")
   expect_true(rai_get(".rs.rai.terminalizeRun")(
      run_id, "could not enqueue approved console input"))
   result <- rai_get(".rs.rai.getRunResult")(run_id)
   expect_identical(result$status, "error")
   expect_identical(result$run_id, run_id)
   expect_match(result$error, "could not enqueue")

   # terminalization is single-shot, like capture settlement.
   expect_false(rai_get(".rs.rai.terminalizeRun")(run_id, "replacement"))
   expect_identical(rai_get(".rs.rai.getRunResult")(run_id), result)
})

test_that("active console records survive timeouts and retain late native results", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   state <- rai_get(".rs.rai.runState")
   rai_get(".rs.rai.setRunLimits")(runTtlSecs = 5, resultTtlSecs = 5)
   for (status in c("pending", "running"))
   {
      run_id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
      record <- get(run_id, envir = state$records, inherits = FALSE)
      record$status <- status
      record$registered_at <- Sys.time() - 3600
      assign(run_id, record, envir = state$records)
      expect_identical(rai_get(".rs.rai.getRunResult")(run_id)$status, "pending")
      expect_identical(get(run_id, envir = state$records)$status, status)
      rai_capture(run_id, "[1] 2")
      result <- rai_get(".rs.rai.getRunResult")(run_id)
      expect_identical(result$status, "ok")
      expect_identical(result$stdout, "[1] 2")
      rai_capture(run_id, "replacement")
      expect_identical(rai_get(".rs.rai.getRunResult")(run_id), result)
   }
})

test_that("settled console results still expire at their existing retention bound", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   state <- rai_get(".rs.rai.runState")
   rai_get(".rs.rai.setRunLimits")(resultTtlSecs = 5)
   run_id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   rai_capture(run_id, "[1] 2")
   record <- get(run_id, envir = state$records, inherits = FALSE)
   record$finished_at <- Sys.time() - 10
   assign(run_id, record, envir = state$records)
   result <- rai_get(".rs.rai.getRunResult")(run_id)
   expect_identical(result$status, "expired")
   expect_identical(result$run_id, run_id)
   expect_match(result$message, "no longer available")
})

test_that("the console run cap refuses new admission without evicting active authority", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   state <- rai_get(".rs.rai.runState")
   register_run <- rai_get(".rs.rai.registerRun")
   run_ids <- vapply(seq_len(20L), function(i)
      register_run("1 + 1", 200L, paste0("c2-", i), paste0("digest-", i)), character(1L))
   records_before <- as.list(state$records, all.names = TRUE)
   expect_null(register_run("1 + 1", 200L, "c2-over-cap", "digest-over-cap"))
   expect_identical(length(ls(state$records, all.names = TRUE)), 20L)
   expect_identical(as.list(state$records, all.names = TRUE), records_before)
   expect_identical(register_run("1 + 1", 200L, "c2-1", "digest-1"), run_ids[[1L]])
})

test_that("run admission reclaims settled records but never an active record", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   state <- rai_get(".rs.rai.runState")
   register_run <- rai_get(".rs.rai.registerRun")
   rai_get(".rs.rai.setRunLimits")(maxRuns = 2L)
   settled <- register_run("1 + 1", 200L)
   rai_capture(settled, "[1] 2")
   active <- register_run("1 + 1", 200L)
   next_run <- register_run("1 + 1", 200L)
   expect_type(next_run, "character")
   expect_length(ls(state$records, all.names = TRUE), 2L)
   expect_false(exists(settled, envir = state$records, inherits = FALSE))
   expect_true(exists(active, envir = state$records, inherits = FALSE))
   expect_null(register_run("1 + 1", 200L))
   expect_true(exists(active, envir = state$records, inherits = FALSE))
   expect_true(exists(next_run, envir = state$records, inherits = FALSE))
})

context("RAI Assistant console queue gate")

test_that("queueConsoleRun rejects prose with no run or approval side effects", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   state <- rai_get(".rs.rai.runState")
   grants <- rai_get(".rs.rai.grantState")

   result <- rai_queue("please run twenty plus twenty two")
   expect_identical(result$status, "error")
   expect_identical(length(ls(state$records, all.names = TRUE)), 0L)
   expect_identical(length(ls(grants$requests, all.names = TRUE)), 0L)
})

test_that("queueConsoleRun blocks R forms that can terminate or escape the IDE session", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)

   state <- rai_get(".rs.rai.runState")
   for (code in c("q()", "base::quit()", "options(error = q)",
                  "get('q', baseenv())()", "eval(parse(text = 'q()'))"))
   {
      result <- rai_queue(code)
      expect_identical(result$status, "error", info = code)
      expect_match(result$message, "session-safe", info = code)
      expect_identical(length(ls(state$records, all.names = TRUE)), 0L, info = code)
   }

   # Ordinary R work, including assignments in the existing workspace, remains
   # default-auto-approved and is entered only through the real Console.
   normal <- rai_queue("{ analysis_value <- 40; analysis_value + 2 }")
   expect_identical(normal$status, "queued")
})

test_that("queueConsoleRun accepts namespace-qualified package calls", {
   # Regression (live-claude-2, 2026-09-25): `pkg::fn(...)` parses to a call
   # whose head is the call `pkg::fn`, not a symbol. The session-safety walk
   # treated every non-symbol head as an uninspectable computed call, so real
   # Bioconductor work such as DESeq2::DESeq(...) or limma::voom(...) was
   # rejected before reaching the Console.
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)

   unsafe <- rai_get(".rs.rai.consoleSessionUnsafe")
   for (code in c("stats::median(c(1, 2, 3))",
                  "utils::head(stats::setNames(1:3, c('a', 'b', 'c')), 2)",
                  "{ x <- tools::toTitleCase('rai'); base::nchar(x) }",
                  "DESeq2::DESeq(DESeq2::DESeqDataSetFromMatrix(cts, data.frame(grp), ~ grp))",
                  "limma::eBayes(limma::lmFit(limma::voom(y, design), design))",
                  "stats::lm(y ~ x)", "utils::head(1:3)", "DESeq2::results(dds)",
                  "ggplot2::ggplot()", "dplyr::filter(tbl, x > 0)",
                  "Biobase::exprs(eset)", "base::paste('a', 'b')"))
   {
      expect_false(unsafe(parse(text = code)[[1L]]), info = code)
      rai_reset_runs()
      expect_identical(rai_queue(code)$status, "queued", info = code)
   }
   # Non-exported ::: calls could hide a mutating body. The Console session
   # parser still considers them R, but the stricter data guard refuses them.
   expect_false(unsafe(parse(text = "stats:::median.default(c(1, 2, 3))")[[1L]]))
   nonExported <- rai_queue("stats:::median.default(c(1, 2, 3))")
   expect_identical(nonExported$status, "error")
   expect_match(nonExported$message, "non-exported namespace")

   # Qualification still never launders a session-control primitive, and any
   # other computed head (including one that merely wraps `::`) stays rejected.
   for (code in c("base::quit()", "base::q('no')", "base:::quit()", "base::eval(1)",
                  "base::do.call('q', list())", "(base::quit)()", "(get('q'))()",
                  "base::get('q')()", "(function() q())()", "utils::head(base::quit)",
                  "stats::median(base::parse(text = 'q()'))",
                  "`::`(base, quit)()", "base::`::`(base, quit)()",
                  "list(f = q)$f()", "base::as.name('q')()"))
   {
      expect_true(unsafe(parse(text = code)[[1L]]), info = code)
      rai_reset_runs()
      result <- rai_queue(code)
      expect_identical(result$status, "error", info = code)
      expect_match(result$message, "session-safe", info = code)
   }
})

test_that("queueConsoleRun refuses namespace writers and computed destinations", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)
   for (code in c("readr::write_csv(x, 'raw/a.csv')",
                  "data.table::fwrite(x, 'raw/a.csv')",
                  "ggplot2::ggsave('raw/a.png')", "base::saveRDS(x, fi='raw/a.rds')",
                  "base::saveRDS(x, 'raw/a.rds')", "utils::write.csv(x, 'raw/a.csv')",
                  "DESeq2::writeResults(x, 'raw/a.csv')", "DESeq2::exportResults(x)",
                  "DESeq2::results(x, file=destination)",
                  "DESeq2::results(x, path=paste0('raw/', name))",
                  "DESeq2::results(x, file='raw/a.csv')"))
   {
      rai_reset_runs()
      expect_identical(rai_queue(code)$status, "error", info = code)
   }
})

test_that("queueConsoleRun retains a historical pending card before it will queue", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   state <- rai_get(".rs.rai.runState")
   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = paste0("proposal-", "20 + 22"), maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   result <- rai_queue("20 + 22")
   expect_identical(result$status, "approval_required")
   expect_match(result$message, "^approval_required: ")

   # nothing is registered into the run registry before approval
   expect_identical(length(ls(state$records, all.names = TRUE)), 0L)
})

test_that("queueConsoleRun registers a pending run once approved and never evaluates it", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   request <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r", NULL,
      preview = "20 + 22", proposalId = "proposal-20 + 22", maxLines = 200L, autoApprove = FALSE)
   request_id <- rai_approval_id(request)
   approved <- rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")
   expect_identical(approved$status, "queued")

   result <- rai_queue("20 + 22")
   expect_identical(result$run_id, approved$run_id)
   expect_identical(result$enqueue, "no")
   expect_identical(result$status, "queued")
   expect_match(result$run_id, "^run-")

   # queueConsoleRun registers only -- the run stays pending until the native
   # module captures the Console result, proving R never evaluated the source.
   expect_identical(
      rai_get(".rs.rai.getRunResult")(result$run_id),
      list(status = "pending", run_id = result$run_id)
   )
})

# Fixed automatic approval admits fresh parser-valid proposals. Native wrapper
# refusal is terminal, never a new manual card; historical decisions remain.
test_that("checkGate auto-approves every parser-valid Console proposal when enabled", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)

   assign(".rs.rai.autoApproveReadOnlyEnabled", function()
      stop("automatic approval unavailable", call. = FALSE), envir = rai_env)
   expect_identical(rai_get(".rs.rai.checkGate")("rai-test-owner", "run_r", NULL,
      preview = "20 + 22"), "blocked: automatic approval unavailable")
   expect_length(ls(rai_get(".rs.rai.grantState")$requests), 0L)

   # Shadow only the native call; the production wrapper must sanitize every result
   had_call <- exists(".Call", envir = rai_env, inherits = FALSE)
   if (had_call)
      old_call <- get(".Call", envir = rai_env, inherits = FALSE)
   on.exit({
      if (had_call)
         assign(".Call", old_call, envir = rai_env)
      else
         rm(list = ".Call", envir = rai_env)
   }, add = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", rai_native_auto_approve, envir = rai_env)
   for (native_result in list(FALSE, NULL, NA, list(enabled = TRUE),
                             simpleError("native detail must not escape")))
   {
      rai_reset_grants()
      assign(".Call", function(name, ...) {
         if (!identical(name, "rs_raiAutoApproveReadOnlyEnabled"))
            return(base::.Call(name, ...))
         if (inherits(native_result, "error"))
            stop(native_result)
         native_result
      }, envir = rai_env)
      expect_error(rai_get(".rs.rai.autoApproveReadOnlyEnabled")(),
                   "^automatic approval unavailable$")
      expect_identical(rai_get(".rs.rai.checkGate")("rai-test-owner", "run_r", NULL,
         preview = "20 + 22"), "blocked: automatic approval unavailable")
      expect_length(ls(rai_get(".rs.rai.grantState")$requests), 0L)
   }

   rai_reset_grants()
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
   expect_identical(rai_get(".rs.rai.checkGate")("wrong-owner", "run_r", NULL,
      preview = "20 + 22"), "blocked: owner token mismatch")
   expect_length(ls(rai_get(".rs.rai.grantState")$requests), 0L)
   for (code in c("20 + 22", "{ value <- 40; value + 2 }", "system('true')",
                  "setwd(tempdir())", "library(stats)"))
   {
      expect_identical(rai_get(".rs.rai.checkGate")("rai-test-owner", "run_r", NULL,
                                                       preview = code), "ok", info = code)
   }
})

test_that("checkGate retains open-document validation while full auto is enabled", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-1", path = "R/one.R", temp_name = NULL)),
      envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   expect_match(rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", "doc-1",
                                             preview = "threshold <- 0.01"),
                "^approval_required: ")
   expect_identical(rai_get(".rs.rai.checkGate")("rai-test-owner", "edit_document", "doc-missing",
                                                 preview = "threshold <- 0.01"),
                    "blocked: invalid approval target")
})

# Autonomy scope (supersedes per-edit
# Allow-once): under fixed Full Auto an exact document edit is
# marked auto_approve so the native client settles it without a card, and the
# caller is told it is applying (native revalidation still decides the outcome).
test_that("queueDocumentEdit makes fresh edits automatic and preserves historical manual cards", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-auto", path = "R/analysis.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)

   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(queued$status, "applying")
   expect_identical(queued$approval, "autonomous")
   expect_match(queued$request_id, "^rai-")
   key <- rai_get(".rs.rai.requestKey")("edit_document", list(path = "doc-auto", domain = "r"))
   expect_true(get(key, envir = rai_get(".rs.rai.grantState")$requests)$auto_approve)
   fresh <- get(key, envir = rai_get(".rs.rai.grantState")$requests)
   expect_match(fresh$diff, "--- current text\nx <- 1", fixed = TRUE)
   expect_match(fresh$diff, "+++ replacement\nx <- 2", fixed = TRUE)

   # A historical manual card is retained under the same always-automatic policy.
   rai_reset_grants()
   historical <- rai_get(".rs.rai.requestApproval")("edit_document",
      "Approval required for edit_document", "doc-auto",
      "Replace the exact highlighted text in the open editor.",
      "--- current text\nx <- 1\n+++ replacement\nx <- 3",
      digestPayload = paste("x <- 1", "x <- 3", "", "", sep = "\037"),
      documentEdit = list(expected = "x <- 1", replacement = "x <- 3",
         context_before = "", context_after = "", path = "R/analysis.R"), autoApprove = FALSE)
   manual <- rai_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 3")
   expect_identical(manual$status, "approval_required")
   expect_identical(manual$request_id, rai_approval_id(historical))
   expect_false(get(key, envir = rai_get(".rs.rai.grantState")$requests)$auto_approve)
})

# A decision the user actually made outranks the automatic path. Without the
# storedDecision check in checkGate these both regress silently, because the
# auto-approval branch returns before requestApproval's own decline check runs.
test_that("an explicit decline is not bypassed by auto-approval on retry", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)

   # Explicit historical decision on policy-clean code: only its stored
   # decline, not a changed policy, can block the retry.
   gate <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r", NULL,
      preview = "20 + 22", proposalId = "proposal-declined", autoApprove = FALSE)
   expect_match(gate, "^approval_required: ")
   request_id <- sub("^approval_required: ", "", gate)
   expect_identical(rai_get(".rs.rai.recordGrant")(request_id, "decline", "once")$status,
                    "declined")

   # The current automatic policy must not resurrect the historical decision.
   before <- as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
   expect_identical(
      rai_get(".rs.rai.checkGate")("rai-test-owner", "run_r", NULL,
                                   preview = "20 + 22", proposalId = "proposal-declined"),
      "blocked: approval declined"
   )
   expect_identical(as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE), before)

   # A genuinely different proposal is unaffected by that decline.
   expect_identical(
      rai_get(".rs.rai.checkGate")("rai-test-owner", "run_r", NULL,
                                   preview = "sum(1:10)", proposalId = "proposal-other"),
      "ok"
   )
})

test_that("a pending approval card is not settled behind the user by auto-approval", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)

   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)

   gate <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r", NULL,
      preview = "20 + 22", proposalId = "proposal-pending", autoApprove = FALSE)
   expect_match(gate, "^approval_required: ")

   before <- as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE)
   # The historical card stays pending under the current automatic policy:
   # keep handing back its exact id, not "ok".
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
   expect_identical(
      rai_get(".rs.rai.checkGate")("rai-test-owner", "run_r", NULL,
                                   preview = "20 + 22", proposalId = "proposal-pending"),
      gate
   )
   expect_identical(as.list(rai_get(".rs.rai.grantState")$requests, all.names = TRUE), before)
})

test_that("a failed Console approval cannot requeue when automatic approval becomes available", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)
   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   old_prepare <- rai_get(".rs.rai.prepareRunEvidence")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   on.exit(assign(".rs.rai.prepareRunEvidence", old_prepare, envir = rai_env), add = TRUE)
   availability <- new.env(parent = emptyenv())
   availability$calls <- 0L
   availability$fail_at <- Inf
   assign(".rs.rai.prepareRunEvidence", function(code) {
      availability$calls <- availability$calls + 1L
      if (identical(availability$calls, availability$fail_at))
         return(list(ok = FALSE, reason = "fixture evidence unavailable"))
      old_prepare(code)
   }, envir = rai_env)
   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "40 + 2", proposalId = "failed-console-approval", maxLines = 137L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   requested <- rai_queue("40 + 2", 137L, "failed-console-approval")
   expect_identical(requested$status, "approval_required")
   request_id <- rai_approval_id(requested$message)
   availability$fail_at <- availability$calls + 1L
   failed <- rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")
   expect_identical(failed$status, "error")
   key <- paste0("proposal\r", "failed-console-approval")
   stored <- get(key, envir = rai_get(".rs.rai.grantState")$requests)
   expect_identical(stored$decision, "failed")
   expect_null(stored$run_id)
   expect_length(ls(rai_get(".rs.rai.runState")$records), 0L)

   availability$fail_at <- Inf
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
   expect_identical(rai_queue("41 + 2", 137L, "failed-console-approval")$message,
                    "proposal_id payload mismatch")
   expect_identical(rai_queue("40 + 2", 138L, "failed-console-approval")$message,
                    "proposal_id payload mismatch")
   retried <- rai_queue("40 + 2", 137L, "failed-console-approval")
   expect_identical(retried$status, "error")
   expect_false(identical(retried$enqueue, "yes"))
   expect_length(ls(rai_get(".rs.rai.runState")$records), 0L)
   expect_identical(get(key, envir = rai_get(".rs.rai.grantState")$requests), stored)
   expect_identical(rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")$status, "error")
   fresh <- rai_queue("40 + 2", 137L, "fresh-console-after-failure")
   expect_identical(fresh$status, "queued")
   expect_identical(fresh$enqueue, "yes")
})

test_that("full-auto evidence refusal stays terminal after evidence recovers", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)
   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   old_prepare <- rai_get(".rs.rai.prepareRunEvidence")
   old_trace <- rai_get(".rs.rai.appendTrace")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   on.exit(assign(".rs.rai.prepareRunEvidence", old_prepare, envir = rai_env), add = TRUE)
   on.exit(assign(".rs.rai.appendTrace", old_trace, envir = rai_env), add = TRUE)
   availability <- new.env(parent = emptyenv())
   availability$calls <- 0L
   availability$fail_at <- 2L
   availability$fail_trace <- FALSE
   assign(".rs.rai.appendTrace", function(event, details) {
      if (identical(event, "run_queued") && isTRUE(availability$fail_trace))
         return(NULL)
      old_trace(event, details)
   }, envir = rai_env)
   assign(".rs.rai.prepareRunEvidence", function(code) {
      availability$calls <- availability$calls + 1L
      if (identical(availability$calls, availability$fail_at))
         return(list(ok = FALSE, reason = "fixture evidence unavailable"))
      old_prepare(code)
   }, envir = rai_env)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
   for (failure_at in 1:3)
   {
      rai_reset_grants()
      rai_reset_runs()
      availability$calls <- 0L
      availability$fail_at <- if (failure_at == 3L) Inf else failure_at
      availability$fail_trace <- failure_at == 3L
      proposal <- paste0("fullauto-failed-evidence-", failure_at)
      refused <- rai_queue("40 + 2", 137L, proposal)
      expect_identical(refused$status, "error")
      expect_identical(refused$policy, "refused")
      expect_identical(availability$calls, min(failure_at, 2L))
      expect_length(ls(rai_get(".rs.rai.runState")$records), 0L)

      availability$fail_at <- Inf
      availability$fail_trace <- FALSE
      retried <- rai_queue("40 + 2", 137L, proposal)
      expect_identical(retried$status, "error")
      expect_false(identical(retried$enqueue, "yes"))
      expect_length(ls(rai_get(".rs.rai.runState")$records), 0L)
      expect_identical(rai_queue("41 + 2", 137L, proposal)$message,
                       "proposal_id payload mismatch")
      fresh <- rai_queue("40 + 2", 137L, paste0(proposal, "-fresh"))
      expect_identical(fresh$status, "queued")
      expect_identical(fresh$enqueue, "yes")
   }
})

test_that("full-auto proposals stay spent after settled run cache eviction", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)
   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
   rai_get(".rs.rai.setRunLimits")(maxRuns = 1L)
   first <- rai_queue("40 + 2", 137L, "fullauto-spent-cache")
   expect_identical(first$status, "queued")
   expect_true(rai_get(".rs.rai.terminalizeRun")(first$run_id, "fixture: not executed"))
   second <- rai_queue("40 + 2", 137L, "fullauto-spent-cache-fresh")
   expect_identical(second$status, "queued")
   records <- rai_get(".rs.rai.runState")$records
   expect_false(exists(first$run_id, envir = records, inherits = FALSE))
   expect_true(rai_get(".rs.rai.terminalizeRun")(second$run_id, "fixture: not executed"))
   retried <- rai_queue("40 + 2", 137L, "fullauto-spent-cache")
   expect_identical(retried$status, "error")
   expect_false(identical(retried$enqueue, "yes"))
   expect_true(exists(second$run_id, envir = records, inherits = FALSE))
   expect_identical(rai_queue("41 + 2", 137L, "fullauto-spent-cache")$message,
                    "proposal_id payload mismatch")
})

test_that("a full-auto registration refusal cannot requeue after capacity recovers", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)
   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   assign(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE, envir = rai_env)
   rai_get(".rs.rai.setRunLimits")(maxRuns = 0L)
   refused <- rai_queue("40 + 2", 137L, "fullauto-registration-refused")
   expect_identical(refused$status, "error")
   expect_identical(refused$message, "could not register console run")
   expect_length(ls(rai_get(".rs.rai.runState")$records), 0L)
   rai_get(".rs.rai.setRunLimits")(maxRuns = 20L)
   retried <- rai_queue("40 + 2", 137L, "fullauto-registration-refused")
   expect_identical(retried$status, "error")
   expect_false(identical(retried$enqueue, "yes"))
   expect_length(ls(rai_get(".rs.rai.runState")$records), 0L)
   fresh <- rai_queue("40 + 2", 137L, "fullauto-registration-fresh")
   expect_identical(fresh$status, "queued")
   expect_identical(fresh$enqueue, "yes")
})

# Every run_r proposal canonicalizes to the one {domain:"r", path:""} Console
# target, so tool+target alone cannot tell two different code strings apart. The
# proposal digest is what stops an approval of one from authorizing the other.
test_that("both console admission paths propagate the validated line binding", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   old_enabled <- rai_get(".rs.rai.autoApproveReadOnlyEnabled")
   on.exit(assign(".rs.rai.autoApproveReadOnlyEnabled", old_enabled, envir = rai_env), add = TRUE)
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)
   code <- "{\n  \"café\"\n}"
   for (automatic in c(FALSE, TRUE))
   {
      rai_reset_grants()
      rai_reset_runs()
      proposal <- paste0("line-bound-", automatic)
      if (!automatic)
      {
         historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
            NULL, preview = code, proposalId = proposal, maxLines = 137L, autoApprove = FALSE)
         expect_match(historical, "^approval_required: ")
      }
      requested <- rai_queue(code, 137L, proposal)
      queued <- if (automatic) requested else
         rai_get(".rs.rai.recordGrant")(rai_approval_id(requested$message), "allow", "once")
      expect_identical(queued$status, "queued", info = paste(automatic, requested$message, queued$message))
      expect_identical(queued$max_lines, 137L)
      expect_identical(queued$max_lines,
         get(queued$run_id, envir = rai_get(".rs.rai.runState")$records)$max_lines)
      expect_identical(queued$code, code)
      expect_identical(rai_queue(code, 137L, proposal)$run_id, queued$run_id)
      expect_identical(rai_queue(code, 138L, proposal)$status, "error")
      expect_identical(rai_queue("21 + 21", 137L, proposal)$status, "error")
      crlf <- gsub(intToUtf8(10L), intToUtf8(c(13L, 10L)), code, fixed = TRUE)
      expect_identical(rai_queue(crlf, 137L, proposal)$status, "error")
      default_proposal <- paste0("default-bound-", automatic)
      if (!automatic)
      {
         historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
            NULL, preview = code, proposalId = default_proposal, maxLines = 200L, autoApprove = FALSE)
         expect_match(historical, "^approval_required: ")
      }
      requested <- rai_queue(code, proposal_id = default_proposal)
      default <- if (automatic) requested else
         rai_get(".rs.rai.recordGrant")(rai_approval_id(requested$message), "allow", "once")
      expect_identical(default$max_lines, 200L)
      expect_identical(rai_queue(code, 200L, default_proposal)$run_id, default$run_id)
   }
})

test_that("a proposal id is bound to exact code and max_lines", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   state <- rai_get(".rs.rai.runState")
   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = "proposal-exact", maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   requested <- rai_queue("20 + 22", proposal_id = "proposal-exact")
   expect_identical(requested$status, "approval_required")
   request_id <- rai_approval_id(requested$message)
   # A different, policy-clean payload under the same proposal id: the digest
   # binding (not the data policy) must reject it. Unsafe payloads are refused
   # earlier by policy and covered in test-rai-assistant-autonomy.R.
   swapped <- rai_queue("21 + 21", proposal_id = "proposal-exact")
   expect_identical(swapped$status, "error")
   expect_match(swapped$message, "payload mismatch")
   changed_lines <- rai_queue("20 + 22", 201L, "proposal-exact")
   expect_identical(changed_lines$status, "error")
   expect_identical(length(ls(state$records, all.names = TRUE)), 0L)

   approved <- rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")
   expect_identical(approved$status, "queued")
   expect_identical(rai_queue("20 + 22", proposal_id = "proposal-exact")$run_id,
                    approved$run_id)
})

test_that("an identical re-proposal reuses its pending request instead of raising a second card", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   queue_console_run <- rai_queue

   # the CLI retries the same tool call while it waits for the user to decide
   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = paste0("proposal-", "20 + 22"), maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   first <- queue_console_run("20 + 22")
   second <- queue_console_run("20 + 22")
   expect_identical(first$status, "approval_required")
   expect_identical(second$message, first$message)

   # A genuinely different proposal is automatic, never inheriting the card.
   other <- queue_console_run("1 + 1")
   expect_identical(other$status, "queued")
   expect_false(identical(other$message, first$message))
   expect_identical(queue_console_run("20 + 22")$message, first$message)
})

test_that("recordGrant atomically registers once and duplicate allow returns the same run", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   state <- rai_get(".rs.rai.runState")
   queue_console_run <- rai_queue
   record_grant <- rai_get(".rs.rai.recordGrant")

   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = paste0("proposal-", "20 + 22"), maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   requested <- queue_console_run("20 + 22")
   request_id <- rai_approval_id(requested$message)

   # simulate two duplicate/concurrent "Allow once" clicks racing on the
   # same pending request id
   first <- record_grant(request_id, "allow", "once")
   second <- record_grant(request_id, "allow", "once")

   expect_identical(first$status, "queued")
   expect_identical(second$status, "queued")
   expect_identical(second$run_id, first$run_id)
   expect_identical(length(ls(state$records, all.names = TRUE)), 1L)
   expect_identical(queue_console_run("20 + 22")$run_id, first$run_id)
})


test_that("duplicate approval reports an enqueue-terminalized run as error", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   state <- rai_get(".rs.rai.runState")
   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = "proposal-terminal-approval", maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   requested <- rai_queue("20 + 22", proposal_id = "proposal-terminal-approval")
   request_id <- rai_approval_id(requested$message)
   approved <- rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")
   expect_true(rai_get(".rs.rai.terminalizeRun")(
      approved$run_id, "could not enqueue approved console input"))

   duplicate <- rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")
   expect_identical(duplicate$status, "error")
   expect_identical(duplicate$run_id, approved$run_id)
   expect_identical(duplicate$message, "could not enqueue approved console input")
   expect_identical(length(ls(state$records, all.names = TRUE)), 1L)
})

test_that("duplicate proposal reports an enqueue-terminalized run as error", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   state <- rai_get(".rs.rai.runState")
   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = "proposal-terminal-retry", maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   requested <- rai_queue("20 + 22", proposal_id = "proposal-terminal-retry")
   request_id <- rai_approval_id(requested$message)
   approved <- rai_get(".rs.rai.recordGrant")(request_id, "allow", "once")
   expect_true(rai_get(".rs.rai.terminalizeRun")(
      approved$run_id, "could not enqueue approved console input"))

   duplicate <- rai_queue("20 + 22", proposal_id = "proposal-terminal-retry")
   expect_identical(duplicate$status, "error")
   expect_identical(duplicate$run_id, approved$run_id)
   expect_identical(duplicate$message, "could not enqueue approved console input")
   expect_identical(length(ls(state$records, all.names = TRUE)), 1L)
})

test_that("a run_r proposal cannot be granted a standing session or project scope", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   # A console proposal's canonical target is the single {domain:"r", path:""}
   # Console slot, so a standing session/project grant would authorize every
   # future proposal unattended -- exactly the approval-gate breach this test
   # exists to prevent. Only "once", bound to the exact proposal digest, is
   # accepted for run_r.
   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = "proposal-scope-session", maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   session_request <- rai_queue("20 + 22", proposal_id = "proposal-scope-session")
   session_result <- rai_get(".rs.rai.recordGrant")(
      rai_approval_id(session_request$message), "allow", "session")
   expect_identical(session_result$status, "error")
   expect_match(session_result$message, "one-time approval")

   # Pre-existing manual request; fresh valid proposals remain automatic.
   historical <- rai_get(".rs.rai.requestApproval")("run_r", "Approval required for run_r",
      NULL, preview = "20 + 22", proposalId = "proposal-scope-project", maxLines = 200L, autoApprove = FALSE)
   expect_match(historical, "^approval_required: ")
   project_request <- rai_queue("20 + 22", proposal_id = "proposal-scope-project")
   project_result <- rai_get(".rs.rai.recordGrant")(
      rai_approval_id(project_request$message), "allow", "project")
   expect_identical(project_result$status, "error")
   expect_match(project_result$message, "one-time approval")

   # Rejected standing grants confer no authority; a fresh proposal is admitted
   # by the fixed automatic policy, not by a leaked session/project grant.
   expect_length(ls(rai_get(".rs.rai.grantState")$session), 0L)
   expect_false(rai_get(".rs.rai.findGrant")("run_r", list(path = "", domain = "r"),
      rai_get(".rs.rai.proposalDigest")("run_r", list(path = "", domain = "r"), "1 + 1", 200L)))
   next_request <- rai_queue("1 + 1", proposal_id = "proposal-scope-next")
   expect_identical(next_request$status, "queued")
})

test_that("run_r accepts exactly one R statement per call", {
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   on.exit(rai_restore_envvar("RAI_OWNER_TOKEN", old_owner), add = TRUE)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-test-owner")
   rai_reset_grants()
   rai_reset_runs()
   on.exit(rai_reset_grants(), add = TRUE)
   on.exit(rai_reset_runs(), add = TRUE)

   # Fresh valid statements use the actual automatic queue path; never evaluate.
   expect_identical(rai_queue("20 + 22")$status, "queued")

   two_statements <- rai_queue("1 + 1; 2 + 2")
   expect_identical(two_statements$status, "error")
   expect_match(two_statements$message, "exactly one R statement")

   two_lines <- rai_queue("1 + 1\n2 + 2")
   expect_identical(two_lines$status, "error")
   expect_match(two_lines$message, "exactly one R statement")

   # one expression that happens to span lines is still one statement
   expect_identical(
      rai_queue("if (TRUE) {\n   1\n} else {\n   2\n}")$status,
      "queued"
   )
   expect_identical(
      rai_queue("function(x) {\n   x + 1\n}")$status,
      "queued"
   )
   expect_identical(rai_queue("{ cat('a\\n'); 1 + 1 }")$status, "queued")
})

test_that("registerRun never replays a settled record's result for a new proposal reusing its id", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   register_run <- rai_get(".rs.rai.registerRun")
   store_result <- rai_get(".rs.rai.storeRunResult")
   get_run_result <- rai_get(".rs.rai.getRunResult")

   # First proposal under this id runs and settles.
   first_run_id <- register_run("1 + 1", 200L, proposalId = "proposal-reused")
   expect_match(first_run_id, "^run-")
   store_result(first_run_id, list(status = "ok", stdout = "[1] 2", stderr = NULL,
      error = NULL, value_summary = NULL, visible = TRUE, elapsed_ms = 5,
      tainted = FALSE, taint_reason = NULL))
   expect_identical(get_run_result(first_run_id)$status, "ok")

   # Corrective execution requires a fresh identity, never replay of a spent id.
   expect_null(register_run("2 + 2", 200L, proposalId = "proposal-reused"))
   second_run_id <- register_run("2 + 2", 200L, proposalId = "proposal-fresh")
   expect_match(second_run_id, "^run-")
   expect_false(identical(second_run_id, first_run_id))
   expect_identical(get_run_result(second_run_id)$status, "pending")

   # The original settled record is untouched and still answers its own id.
   expect_identical(get_run_result(first_run_id)$status, "ok")
})

test_that("registerRun dedupes an exact-duplicate resubmission while the original run is still live", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   register_run <- rai_get(".rs.rai.registerRun")

   run_id <- register_run("Sys.sleep(0)", 200L, proposalId = "proposal-in-flight")
   expect_match(run_id, "^run-")

   # Exact resubmission (same code/max_lines/digest) while still pending --
   # this is a retried enqueue RPC for the SAME approved proposal, not a new
   # one, so it must dedupe onto the same run rather than spawn a second.
   duplicate_id <- register_run("Sys.sleep(0)", 200L, proposalId = "proposal-in-flight")
   expect_identical(duplicate_id, run_id)

   # A different code string reusing the same id while the original is still
   # in flight is a genuine conflict; it must be refused, not silently merged.
   conflicting_id <- register_run("Sys.sleep(1)", 200L, proposalId = "proposal-in-flight")
   expect_null(conflicting_id)
})

test_that("registerRun refuses multi-statement code outright", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)

   register_run <- rai_get(".rs.rai.registerRun")
   expect_null(register_run("1 + 1; 2 + 2", 200L))
   expect_null(register_run("1 + 1\n2 + 2", 200L))

   # assign first: expect_match() evaluates its object argument twice, which
   # would register this run twice and make the count below read 2.
   braced <- register_run("{ 1 + 1; 2 + 2 }", 200L)
   expect_match(braced, "^run-")
   expect_identical(length(ls(rai_get(".rs.rai.runState")$records, all.names = TRUE)), 1L)
})

context("RAI Assistant Stage 1 debugging support (get_debug_info)")

# get_debug_info is a strictly read-only reflection tool: it never evaluates
# code and never queues a Console run. These tests exercise its parsing of
# already-captured stderr text and its bounded, read-only object summaries --
# never a new execution path.

test_that("parseErrorDetail recovers the call and message from 'Error in ... : ...'", {
   parse_error <- rai_get(".rs.rai.parseErrorDetail")
   detail <- parse_error("Error in f() : boom")

   expect_identical(detail$class, c("simpleError", "error", "condition"))
   expect_identical(detail$call, "f()")
   expect_identical(detail$message, "boom")
})

test_that("parseErrorDetail recovers a callerless 'Error: ...' message", {
   parse_error <- rai_get(".rs.rai.parseErrorDetail")
   detail <- parse_error("Error: boom plain")

   expect_null(detail$call)
   expect_identical(detail$message, "boom plain")
})

test_that("parseErrorDetail preserves a multi-line error message in full", {
   parse_error <- rai_get(".rs.rai.parseErrorDetail")
   detail <- parse_error("Error: line one\nline two\nline three")

   expect_identical(detail$message, "line one\nline two\nline three")
})

test_that("parseErrorDetail returns NULL for text with no error line", {
   parse_error <- rai_get(".rs.rai.parseErrorDetail")
   expect_null(parse_error(""))
   expect_null(parse_error(NULL))
   expect_null(parse_error("[1] 42"))
})

test_that("parseWarnings recovers a single unnumbered warning block", {
   parse_warnings <- rai_get(".rs.rai.parseWarnings")
   warnings <- parse_warnings("Warning message:\nIn f() : w1")

   expect_identical(length(warnings), 1L)
   expect_identical(warnings[[1L]]$call, "f()")
   expect_identical(warnings[[1L]]$message, "w1")
})

test_that("parseWarnings recovers every entry of a numbered multi-warning block", {
   # This is the exact gap get_run_result leaves today: only the first
   # warning ever reaches the caller. get_debug_info must expose all of them.
   parse_warnings <- rai_get(".rs.rai.parseWarnings")
   warnings <- parse_warnings(
      "Warning messages:\n1: In f() : w1\n2: In g() : w2\n3: In h() : w3"
   )

   expect_identical(length(warnings), 3L)
   expect_identical(vapply(warnings, `[[`, character(1L), "call"), c("f()", "g()", "h()"))
   expect_identical(vapply(warnings, `[[`, character(1L), "message"), c("w1", "w2", "w3"))
})

test_that("parseWarnings returns an empty list when there are no warnings", {
   parse_warnings <- rai_get(".rs.rai.parseWarnings")
   expect_identical(parse_warnings("[1] 42"), list())
   expect_identical(parse_warnings(""), list())
   expect_identical(parse_warnings(NULL), list())
})

test_that("safeObjectSummary returns a bounded str()-like description for an existing object", {
   safe_summary <- rai_get(".rs.rai.safeObjectSummary")
   assign("rai_test_df", data.frame(a = 1:3, b = letters[1:3]), envir = globalenv())
   on.exit(rm("rai_test_df", envir = globalenv()), add = TRUE)

   summary <- safe_summary("rai_test_df")
   expect_identical(summary$name, "rai_test_df")
   expect_true(summary$found)
   expect_true(is.character(summary$summary))
   expect_match(summary$summary, "data.frame")
   expect_match(summary$summary, "3 obs\\. of 2 variables")
   expect_lte(nchar(summary$summary, type = "bytes"), 256L)
})

test_that("safeObjectSummary reports found = FALSE for a name that does not exist", {
   safe_summary <- rai_get(".rs.rai.safeObjectSummary")
   summary <- safe_summary("rai_test_object_does_not_exist")

   expect_false(summary$found)
   expect_null(summary$summary)
})

test_that("safeObjectSummary never evaluates its input -- only a bare identifier is looked up", {
   # This is the whole safety contract of Stage 1: get_debug_info must never
   # gain a new execution path. A name that is not a syntactically bare R
   # identifier is rejected outright, not parsed or evaluated.
   safe_summary <- rai_get(".rs.rai.safeObjectSummary")

   expect_false(safe_summary("1 + 1")$found)
   expect_false(safe_summary("system('echo pwned')")$found)
   expect_false(safe_summary("rai_test_object_does_not_exist; 1 + 1")$found)
   expect_false(safe_summary("x$y")$found)
   expect_false(safe_summary("x[1]")$found)
   expect_false(safe_summary("base::pi")$found)
})

test_that("safeObjectSummary does not dispatch str methods or execute active bindings", {
   safe_summary <- rai_get(".rs.rai.safeObjectSummary")
   marker <- FALSE
   makeActiveBinding("rai_test_active", function(value) {
      marker <<- TRUE
      stop("must not be forced")
   }, globalenv())
   on.exit(rm("rai_test_active", envir = globalenv()), add = TRUE)

   summary <- safe_summary("rai_test_active")
   expect_true(summary$found)
   expect_false(marker)
   expect_match(summary$summary, "active binding")

   delayedAssign("rai_test_delayed", {
      marker <<- TRUE
      stop("must not be forced")
   }, assign.env = globalenv())
   on.exit(rm("rai_test_delayed", envir = globalenv()), add = TRUE)
   summary <- safe_summary("rai_test_delayed")
   expect_true(summary$found)
   expect_false(marker)
   expect_match(summary$summary, "delayed binding")
})

test_that("safeObjectSummary only resolves names in .GlobalEnv, not via lexical scoping", {
   safe_summary <- rai_get(".rs.rai.safeObjectSummary")
   # A base-package binding (e.g. `pi`) exists on the search path but not in
   # .GlobalEnv directly; inherits = FALSE must keep it out of reach here.
   expect_false(exists("rai_never_defined_anywhere", inherits = FALSE))
   expect_false(safe_summary("rai_never_defined_anywhere")$found)
})

test_that("getDebugInfo adds error_detail and the full warning list to a settled error run", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   get_debug_info <- rai_get(".rs.rai.getDebugInfo")

   run_id <- rai_get(".rs.rai.registerRun")("stop('boom')", 200L)
   rai_capture(
      run_id,
      stderr = "Error in f() : boom\nWarning messages:\n1: In g() : w1\n2: In h() : w2"
   )

   info <- get_debug_info(run_id)
   expect_identical(info$status, "error")
   expect_identical(info$error_detail$call, "f()")
   expect_identical(info$error_detail$message, "boom")
   expect_identical(length(info$warnings), 2L)
   expect_identical(info$warnings[[1L]]$message, "w1")
   expect_identical(info$warnings[[2L]]$message, "w2")
})

test_that("getDebugInfo separates error warnings emitted with R's 'In addition' prefix", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   get_debug_info <- rai_get(".rs.rai.getDebugInfo")

   run_id <- rai_get(".rs.rai.registerRun")("stop('boom')", 200L)
   rai_capture(
      run_id,
      stderr = paste(
         "Error: boom",
         "In addition: Warning messages:",
         "1: first warning",
         "2: second warning",
         sep = "\n"
      )
   )

   info <- get_debug_info(run_id)
   expect_identical(info$error_detail$message, "boom")
   expect_identical(length(info$warnings), 2L)
   expect_identical(vapply(info$warnings, `[[`, character(1L), "message"),
      c("first warning", "second warning"))
})

test_that("getDebugInfo passes through pending/unknown/expired runs unchanged", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   get_debug_info <- rai_get(".rs.rai.getDebugInfo")
   get_run_result <- rai_get(".rs.rai.getRunResult")

   run_id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   expect_identical(get_debug_info(run_id), get_run_result(run_id))
   expect_identical(get_debug_info("run-never-registered"), get_run_result("run-never-registered"))
})

test_that("getDebugInfo attaches bounded object summaries only for explicitly requested names", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   get_debug_info <- rai_get(".rs.rai.getDebugInfo")

   assign("rai_test_vec", 1:3, envir = globalenv())
   on.exit(rm("rai_test_vec", envir = globalenv()), add = TRUE)

   run_id <- rai_get(".rs.rai.registerRun")("20 + 22", 200L)
   rai_capture(run_id, stdout = "[1] 42")

   info <- get_debug_info(run_id, objectNames = c("rai_test_vec", "rai_test_missing"))
   expect_identical(length(info$object_summaries), 2L)
   expect_true(info$object_summaries[[1L]]$found)
   expect_false(info$object_summaries[[2L]]$found)

   # No objectNames means no reflection surface is exercised at all.
   plain <- get_debug_info(run_id)
   expect_null(plain$object_summaries)
})

test_that("getDebugInfo bounds the number of object names it will summarize per call", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   get_debug_info <- rai_get(".rs.rai.getDebugInfo")

   run_id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   rai_capture(run_id, stdout = "[1] 2")

   many_names <- paste0("rai_test_object_", seq_len(50))
   info <- get_debug_info(run_id, objectNames = many_names)
   expect_true(length(info$object_summaries) <= 20L)
})

test_that("getDebugInfo never introduces a new execution path -- it only reads .rs.rai.getRunResult", {
   # Guard against get_debug_info growing an eval()/parse()-based code path in
   # the future: it must remain pure reflection over already-captured state.
   body_text <- paste(deparse(rai_get(".rs.rai.getDebugInfo")), collapse = "\n")
   expect_false(grepl("\\beval\\(", body_text))
   expect_false(grepl("\\bparse\\(", body_text))
   expect_false(grepl("enqueueConsoleInput", body_text, fixed = TRUE))
   expect_false(grepl("queueConsoleRun", body_text, fixed = TRUE))
})

test_that("getDebugInfo truthfully marks traceback unavailable without inventing frames", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   run_id <- rai_get(".rs.rai.registerRun")("stop('boom')", 200L)
   rai_capture(run_id, stderr = "Error: boom")

   info <- rai_get(".rs.rai.getDebugInfo")(run_id)
   expect_false(info$traceback_available)
   expect_true(is.character(info$traceback_unavailable_reason))
   expect_false("traceback" %in% names(info))
})

# --- get_environment_summary -------------------------------------------------

test_that("environmentSummary lists existing global bindings with bounded metadata only", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   assign("rai_test_env_df", data.frame(a = 1:3, b = letters[1:3]), envir = globalenv())
   assign("rai_test_env_num", 1:10, envir = globalenv())
   on.exit(rm("rai_test_env_df", "rai_test_env_num", envir = globalenv()), add = TRUE)

   listing <- env_summary()
   expect_true(is.list(listing$bindings))
   expect_identical(listing$binding_count, length(listing$bindings))
   expect_true(listing$total_count >= listing$binding_count)
   expect_identical(listing$max_bindings, 100L)

   names_seen <- vapply(listing$bindings, function(entry) entry$name, character(1))
   expect_true("rai_test_env_df" %in% names_seen)
   expect_true("rai_test_env_num" %in% names_seen)

   entry <- listing$bindings[[which(names_seen == "rai_test_env_df")]]
   expect_identical(sort(names(entry)), c("binding", "class", "name"))
   expect_identical(entry$binding, "value")
   expect_match(entry$class, "data.frame")

   # The listing is metadata only: no value, contents, or data field anywhere.
   for (binding in listing$bindings)
      expect_true(all(names(binding) %in% c("name", "binding", "class")))
})

test_that("environmentSummary never forces a promise or an active binding", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   marker <- FALSE
   makeActiveBinding("rai_test_env_active", function(value) {
      marker <<- TRUE
      stop("must not be forced")
   }, globalenv())
   delayedAssign("rai_test_env_delayed", {
      marker <<- TRUE
      stop("must not be forced")
   }, assign.env = globalenv())
   on.exit(rm("rai_test_env_active", "rai_test_env_delayed", envir = globalenv()), add = TRUE)

   listing <- env_summary()
   names_seen <- vapply(listing$bindings, function(entry) entry$name, character(1))
   expect_false(marker)

   active <- listing$bindings[[which(names_seen == "rai_test_env_active")]]
   expect_identical(active$binding, "active_binding")
   expect_identical(active$class, "")

   delayed <- listing$bindings[[which(names_seen == "rai_test_env_delayed")]]
   expect_identical(delayed$binding, "promise")

   # The named-detail path must not force them either.
   detail <- env_summary("rai_test_env_active,rai_test_env_delayed")
   expect_false(marker)
   expect_identical(detail$objects[[1L]]$binding, "active_binding")
   expect_match(detail$objects[[1L]]$summary, "value not read")
   expect_identical(detail$objects[[2L]]$binding, "promise")
   expect_match(detail$objects[[2L]]$summary, "value not read")
   # A binding that was never forced has no class, shape, or column list.
   expect_false("class" %in% names(detail$objects[[1L]]))
   expect_false("columns" %in% names(detail$objects[[2L]]))
})

test_that("dataObjectDetail describes a data.frame by class, dims, and columns without any values", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   assign("rai_test_detail_df",
          data.frame(mpg = c(21, 22.8), cyl = c(6L, 4L), name = c("secret1", "secret2"),
                     stringsAsFactors = FALSE),
          envir = globalenv())
   on.exit(rm("rai_test_detail_df", envir = globalenv()), add = TRUE)

   detail <- env_summary("rai_test_detail_df")$objects[[1L]]
   expect_true(detail$found)
   expect_identical(detail$binding, "value")
   expect_identical(detail$class, "data.frame")
   expect_identical(detail$dims, c(2L, 3L))
   expect_identical(detail$row_count, 2L)
   expect_identical(detail$column_count, 3L)
   expect_false(detail$columns_truncated)

   expect_identical(length(detail$columns), 3L)
   expect_identical(vapply(detail$columns, function(column) column$name, character(1)),
                    c("mpg", "cyl", "name"))
   expect_identical(vapply(detail$columns, function(column) column$class, character(1)),
                    c("numeric", "integer", "character"))

   # Class/dims/columns/summary only: no cell value ever leaves the session.
   serialized <- paste(unlist(detail), collapse = " ")
   expect_false(grepl("secret1", serialized, fixed = TRUE))
   expect_false(grepl("secret2", serialized, fixed = TRUE))
   expect_false(grepl("21", serialized, fixed = TRUE))
   expect_false(grepl("22.8", serialized, fixed = TRUE))
})

test_that("dataObjectDetail reports matrix shape and caps a wide object's column list", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   assign("rai_test_detail_mat",
          matrix(1:6, nrow = 2, dimnames = list(NULL, c("x", "y", "z"))),
          envir = globalenv())
   wide <- as.data.frame(matrix(0, nrow = 1, ncol = 60))
   assign("rai_test_detail_wide", wide, envir = globalenv())
   on.exit(rm("rai_test_detail_mat", "rai_test_detail_wide", envir = globalenv()), add = TRUE)

   matrix_detail <- env_summary("rai_test_detail_mat")$objects[[1L]]
   expect_identical(matrix_detail$dims, c(2L, 3L))
   expect_identical(matrix_detail$row_count, 2L)
   expect_identical(matrix_detail$column_count, 3L)
   expect_identical(vapply(matrix_detail$columns, function(column) column$name, character(1)),
                    c("x", "y", "z"))

   # A wide table is truncated, and says so rather than silently dropping names.
   wide_detail <- env_summary("rai_test_detail_wide")$objects[[1L]]
   expect_identical(wide_detail$column_count, 60L)
   expect_identical(length(wide_detail$columns), 40L)
   expect_true(wide_detail$columns_truncated)
})

test_that("environment missingness is bounded, labeled and never materializes ALTREP", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   assign("rai_test_missing_small", data.frame(a = c(1, NA_real_, 3),
      b = c("x", NA_character_, "z"), stringsAsFactors = FALSE), envir = globalenv())
   assign("rai_test_missing_large", data.frame(a = c(rep(1, 1000), NA_real_)),
          envir = globalenv())
   assign("rai_test_missing_altrep", data.frame(a = 1:10000), envir = globalenv())
   on.exit(rm("rai_test_missing_small", "rai_test_missing_large", "rai_test_missing_altrep",
              envir = globalenv()), add = TRUE)

   detail <- env_summary("rai_test_missing_small")$objects[[1L]]
   expect_identical(detail$columns[[1L]]$missingness,
                    list(scope = "first_rows", inspected_rows = 3L, missing_count = 1L))
   expect_identical(detail$columns[[2L]]$missingness$missing_count, 1L)
   expect_false("columns" %in% names(env_summary("rai_test_missing_small", summaryMode = "nrow")$objects[[1L]]))
   large <- env_summary("rai_test_missing_large", requestedColumns = "a")$objects[[1L]]
   expect_identical(large$columns[[1L]]$missingness$inspected_rows, 1000L)
   expect_identical(large$columns[[1L]]$missingness$missing_count, 0L)
   expect_identical(large$requested_columns[[1L]]$missingness$inspected_rows, 1000L)
   altrep <- env_summary("rai_test_missing_altrep")$objects[[1L]]
   expect_identical(altrep$columns[[1L]]$missingness$scope,
                    "unavailable_unrealized_or_unsupported")
})

test_that("environmentSummary reports found = FALSE and never evaluates a non-identifier", {
   env_summary <- rai_get(".rs.rai.environmentSummary")

   missing <- env_summary("rai_test_env_does_not_exist")$objects[[1L]]
   expect_false(missing$found)

   # The whole safety contract: a name that is not a syntactically bare R
   # identifier is rejected outright, never parsed or evaluated.
   for (bad in c("1 + 1", "system('echo pwned')", "x$y", "x[1]", "base::pi",
                 "rai_test_env_does_not_exist; 1 + 1"))
      expect_false(env_summary(bad)$objects[[1L]]$found, info = bad)

   # Lexical scoping is not a lookup path either: base bindings are not global.
   expect_false(env_summary("pi")$objects[[1L]]$found)
})

test_that("environmentSummary bounds a named request to 20 objects and dedupes it", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   many <- paste(paste0("rai_test_env_many", seq_len(30)), collapse = ",")

   expect_true(length(env_summary(many)$objects) <= 20L)
   expect_identical(length(env_summary("rai_test_env_dup,rai_test_env_dup")$objects), 1L)

   # An empty object_names field is the listing shape, not an empty detail set.
   expect_true("bindings" %in% names(env_summary("")))
   expect_true("bindings" %in% names(env_summary(NULL)))
})

test_that("environmentSummary summary_mode 'nrow' reports identity/class/row_count and never enumerates columns", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   assign("rai_test_nrow_df",
          data.frame(secret_col_a = c("s1", "s2"), secret_col_b = c(9, 8),
                     stringsAsFactors = FALSE),
          envir = globalenv())
   on.exit(rm("rai_test_nrow_df", envir = globalenv()), add = TRUE)

   detail <- env_summary("rai_test_nrow_df", summaryMode = "nrow")$objects[[1L]]
   expect_true(detail$found)
   expect_identical(detail$binding, "value")
   expect_identical(detail$class, "data.frame")
   expect_identical(detail$row_count, 2L)

   # The whole point of nrow mode: no column enumeration anywhere in the result.
   expect_false("columns" %in% names(detail))
   expect_false("column_names" %in% names(detail))
   expect_false("column_count" %in% names(detail))
   expect_false("columns_truncated" %in% names(detail))
   serialized <- paste(unlist(detail), collapse = " ")
   expect_false(grepl("secret_col_a", serialized, fixed = TRUE))
   expect_false(grepl("secret_col_b", serialized, fixed = TRUE))

   # Default mode is unaffected and still "full".
   full_default <- env_summary("rai_test_nrow_df")$objects[[1L]]
   expect_true("columns" %in% names(full_default))

   # A non-data.frame/non-matrix object has no row concept: safe, no row_count.
   assign("rai_test_nrow_scalar", 42, envir = globalenv())
   on.exit(rm("rai_test_nrow_scalar", envir = globalenv()), add = TRUE)
   scalar_detail <- env_summary("rai_test_nrow_scalar", summaryMode = "nrow")$objects[[1L]]
   expect_true(scalar_detail$found)
   expect_false("row_count" %in% names(scalar_detail))
})

test_that("environmentSummary requestedColumns returns metadata-only class lookup beyond the 40-column cap", {
   env_summary <- rai_get(".rs.rai.environmentSummary")
   wide <- as.data.frame(matrix(0, nrow = 1, ncol = 45))
   names(wide) <- paste0("col", seq_len(45))
   wide$col45 <- "character value"
   assign("rai_test_wide_named", wide, envir = globalenv())
   on.exit(rm("rai_test_wide_named", envir = globalenv()), add = TRUE)

   detail <- env_summary("rai_test_wide_named", requestedColumns = "col45,col1,col_missing")$objects[[1L]]
   expect_true(detail$columns_truncated)
   expect_identical(length(detail$columns), 40L)

   requested <- detail$requested_columns
   expect_identical(length(requested), 3L)
   by_name <- setNames(requested, vapply(requested, function(r) r$name, character(1)))
   expect_true(by_name$col45$found)
   expect_identical(by_name$col45$class, "character")
   expect_true(by_name$col1$found)
   expect_identical(by_name$col1$class, "numeric")
   expect_false(by_name$col_missing$found)

   # No cell value ever leaves the session, even for the explicitly requested column.
   serialized <- paste(unlist(detail), collapse = " ")
   expect_false(grepl("character value", serialized, fixed = TRUE))

   # A non-data.frame object with requested columns is handled safely: reported not found.
   assign("rai_test_scalar_cols", 1:5, envir = globalenv())
   on.exit(rm("rai_test_scalar_cols", envir = globalenv()), add = TRUE)
   scalar_detail <- env_summary("rai_test_scalar_cols", requestedColumns = "x")$objects[[1L]]
   expect_true(scalar_detail$found)
   expect_false(scalar_detail$requested_columns[[1L]]$found)
})

test_that("environmentSummary never introduces a new execution path", {
   # Same guard the debug endpoint carries: this must remain pure reflection,
   # never growing an eval()/parse()/get()-based route into the workspace.
   for (fn in c(".rs.rai.environmentSummary", ".rs.rai.dataObjectDetail"))
   {
      body_text <- paste(deparse(rai_get(fn)), collapse = "\n")
      expect_false(grepl("\\beval\\(", body_text), info = fn)
      expect_false(grepl("\\bparse\\(", body_text), info = fn)
      expect_false(grepl("\\bget\\(", body_text), info = fn)
      expect_false(grepl("enqueueConsoleInput", body_text, fixed = TRUE), info = fn)
      expect_false(grepl("queueConsoleRun", body_text, fixed = TRUE), info = fn)
   }
})

# --- Anchored edit context (Task 2: native <-> R contract) -----------------

test_that("queueDocumentEdit accepts and pins an optional context pair into the stored request", {
   old_read <- rai_read_document_fixture("```{r}\nx <- 1\n```")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-ctx", path = "R/analysis.Rmd", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-ctx", "x <- 1", "x <- 2",
                                                  "```{r}\n", "\n```")
   expect_identical(queued$status, "applying")
   expect_identical(queued$approval, "autonomous")

   state <- rai_get(".rs.rai.grantState")
   key <- rai_get(".rs.rai.requestKey")("edit_document", list(path = "doc-ctx", domain = "r"))
   request <- get(key, envir = state$requests, inherits = FALSE)
   expect_identical(request$document_edit$expected, "x <- 1")
   expect_identical(request$document_edit$replacement, "x <- 2")
   expect_identical(request$document_edit$context_before, "```{r}\n")
   expect_identical(request$document_edit$context_after, "\n```")
})

test_that("queueDocumentEdit omitting context still works and stores empty context", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-noctx", path = "R/analysis.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-noctx", "x <- 1", "x <- 2")
   expect_identical(queued$status, "applying")
   expect_identical(queued$approval, "autonomous")

   state <- rai_get(".rs.rai.grantState")
   key <- rai_get(".rs.rai.requestKey")("edit_document", list(path = "doc-noctx", domain = "r"))
   request <- get(key, envir = state$requests, inherits = FALSE)
   expect_identical(request$document_edit$context_before, "")
   expect_identical(request$document_edit$context_after, "")
})

test_that("a distinct context pair on an otherwise-identical edit produces a distinct digest", {
   old_read <- rai_read_document_fixture("## Header A\nx <- 1\n")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-digest", path = "R/analysis.Rmd", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   queued_a <- rai_get(".rs.rai.queueDocumentEdit")("doc-digest", "x <- 1", "x <- 2",
                                                     "## Header A\n", "\n")
   state <- rai_get(".rs.rai.grantState")
   key <- rai_get(".rs.rai.requestKey")("edit_document", list(path = "doc-digest", domain = "r"))
   digest_a <- get(key, envir = state$requests, inherits = FALSE)$digest

   rai_reset_grants()
   rai_read_document_fixture("## Header B\nx <- 1\n")
   queued_b <- rai_get(".rs.rai.queueDocumentEdit")("doc-digest", "x <- 1", "x <- 2",
                                                     "## Header B\n", "\n")
   digest_b <- get(key, envir = state$requests, inherits = FALSE)$digest

   expect_false(identical(digest_a, digest_b))
})

test_that("an approved editor request with context prepares native apply carrying that context", {
   old_read <- rai_read_document_fixture("```{r}\nx <- 1\n```")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-apply-ctx", path = "R/analysis.Rmd", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-apply-ctx", "x <- 1", "x <- 2",
                                                   "```{r}\n", "\n```")
   prepared <- rai_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")
   expect_identical(prepared$status, "apply_document")
   expect_identical(prepared$context_before, "```{r}\n")
   expect_identical(prepared$context_after, "\n```")
})

test_that("completeDocumentEdit returns pre/post audit fields only when the edit applied", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-audit", path = "R/analysis.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-audit", "x <- 1", "x <- 2")
   rai_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")

   completed <- rai_get(".rs.rai.completeDocumentEdit")(
      queued$request_id, TRUE, "",
      3L, 1L, 0L, 1L,   # before: totalLines, blankLines, fenceCount, chunkParseCount
      3L, 1L, 0L, 1L)   # after: same shape
   expect_identical(completed$status, "applied")
   expect_identical(completed$before$total_lines, 3L)
   expect_identical(completed$before$blank_lines, 1L)
   expect_identical(completed$before$fence_count, 0L)
   expect_identical(completed$before$chunk_parse_count, 1L)
   expect_identical(completed$after$total_lines, 3L)

   rai_reset_grants()
   rai_read_document_fixture("y <- 1")
   queued2 <- rai_get(".rs.rai.queueDocumentEdit")("doc-audit", "y <- 1", "y <- 2")
   rai_get(".rs.rai.recordGrant")(queued2$request_id, "allow", "once")
   failed <- rai_get(".rs.rai.completeDocumentEdit")(
      queued2$request_id, FALSE, "buffer audit detected changes outside the requested edit")
   expect_identical(failed$status, "error")
   expect_null(failed$before)
   expect_null(failed$after)
   expect_match(failed$message, "buffer audit", fixed = TRUE)
})

test_that("completeDocumentEdit without any audit arguments still settles the request (back-compat)", {
   old_read <- rai_read_document_fixture("x <- 1")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   rai_reset_grants()
   on.exit(rai_reset_grants(), add = TRUE)
   old_list_documents <- rai_get(".rs.rai.listOpenDocuments")
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "doc-legacy", path = "R/analysis.R", temp_name = NULL)), envir = rai_env)
   on.exit(assign(".rs.rai.listOpenDocuments", old_list_documents, envir = rai_env), add = TRUE)

   queued <- rai_get(".rs.rai.queueDocumentEdit")("doc-legacy", "x <- 1", "x <- 2")
   rai_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")
   completed <- rai_get(".rs.rai.completeDocumentEdit")(queued$request_id, TRUE)
   expect_identical(completed$status, "applied")
})

test_that(".rs.rai.countParseableChunks parses without evaluating and never writes a file", {
   count_parseable <- rai_get(".rs.rai.countParseableChunks")

   expect_identical(count_parseable(character(0)), 0L)
   expect_identical(count_parseable(list()), 0L)

   # One parseable, one not.
   expect_identical(count_parseable(list("x <- 1", "x <-")), 1L)
   expect_identical(count_parseable(list("x <- 1", "y <- 2")), 2L)

   # Proves parse-only: a chunk that would error on evaluation, but is
   # syntactically valid, still counts as parseable.
   marker <- paste0("rai_test_count_parseable_", as.integer(Sys.time()))
   expect_false(exists(marker, envir = .GlobalEnv))
   expect_identical(count_parseable(list(paste0(marker, " <- stop('should never run')"))), 1L)
   expect_false(exists(marker, envir = .GlobalEnv))

   # Never touches disk: no new files appear in the working directory.
   before_files <- list.files(tempdir())
   count_parseable(list("z <- 1", "invalid <- syntax((("))
   after_files <- list.files(tempdir())
   expect_identical(before_files, after_files)

   body_text <- paste(deparse(count_parseable), collapse = "\n")
   expect_false(grepl("\\beval\\(", body_text))
   expect_false(grepl("\\bsource\\(", body_text))
   expect_false(grepl("\\bwriteLines\\(", body_text))
   expect_false(grepl("\\bwrite\\(", body_text))
   expect_false(grepl("\\bcat\\(.*file", body_text))
})


test_that("completion retains its own Console epoch, not a later session epoch", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   expect_error(rai_get(".rs.rai.recordConsoleCapture")(id, "[1] 2", "", 1, FALSE, "", "123", 27), NA)
   expect_identical(rai_get(".rs.rai.getRunResult")(id)$console_epoch, "123")
   expect_identical(rai_get(".rs.rai.getRunResult")(id)$output_bytes, 27)
})

test_that("a settled auto-approved proposal id cannot execute again", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L, "single-use-proposal", "digest")
   rai_get(".rs.rai.recordConsoleCapture")(id, "[1] 2", "", 1)
   expect_null(rai_get(".rs.rai.registerRun")("1 + 1", 200L, "single-use-proposal", "digest"))
})

test_that("native observed conditions separate warnings from localized errors", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   old <- get0(".rs.rai.conditionObserverReady", envir = rai_env, inherits = FALSE)
   assign(".rs.rai.conditionObserverReady", function() TRUE, envir = rai_env)
   on.exit(if (is.null(old)) rm(".rs.rai.conditionObserverReady", envir = rai_env) else assign(".rs.rai.conditionObserverReady", old, envir = rai_env), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("warning('w')", 200L)
   expect_error(rai_get(".rs.rai.recordConsoleCapture")(id, "42", "Warning message:\nw", 1, FALSE, "", "1", 20, "non_error"), NA)
   expect_identical(rai_get(".rs.rai.getRunResult")(id)$status, "ok")
   id <- rai_get(".rs.rai.registerRun")("message('e')", 200L)
   rai_get(".rs.rai.recordConsoleCapture")(id, "42", "Error: this is a message", 1, FALSE, "", "1", 20, "non_error")
   expect_identical(rai_get(".rs.rai.getRunResult")(id)$status, "ok")
   expect_null(rai_get(".rs.rai.getDebugInfo")(id)$error_detail)
   id <- rai_get(".rs.rai.registerRun")("stop('e')", 200L)
   expect_error(rai_get(".rs.rai.recordConsoleCapture")(id, "", "Erreur : localise", 1, FALSE, "", "2", 20, "error"), NA)
   result <- rai_get(".rs.rai.getRunResult")(id)
   expect_identical(result$status, "error")
   expect_match(result$error, "localise")
})

test_that("indeterminate completed output retains bounded debug and honest traceback state", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("42", 200L)
   rai_get(".rs.rai.recordConsoleCapture")(id, "42", "Error budget exhausted: unclassified text", 1)
   info <- rai_get(".rs.rai.getDebugInfo")(id)
   expect_identical(info$status, "indeterminate")
   expect_false(info$traceback_available)
})

test_that("debug details use the native error segment, not earlier stderr", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("stop('actual')", 200L)
   rai_get(".rs.rai.recordConsoleCapture")(id, "", "Error: decoy\nError in actual() : actual", 1, FALSE, "", "1", 40, "error", "Error in actual() : actual")
   info <- rai_get(".rs.rai.getDebugInfo")(id)
   expect_identical(info$error_detail$message, "actual")
   expect_identical(info$error_detail$call, "actual()")
})

test_that("localized stderr without interpreter outcome is not reported successful", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("stop('x')", 200L)
   rai_get(".rs.rai.recordConsoleCapture")(id, "", "Erreur : x", 1)
   expect_identical(rai_get(".rs.rai.getRunResult")(id)$status, "indeterminate")
})

test_that("settled native captures identify completion and exact source", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("1 + 1", 200L)
   rai_get(".rs.rai.recordConsoleCapture")(id, "[1] 2", "", 1)
   result <- rai_get(".rs.rai.getRunResult")(id)
   expect_identical(result$completion, "top_level_prompt")
   expect_identical(result$code_hash, rai_get(".rs.rai.codeHash")("1 + 1"))
})

test_that("verified native error details preserve qualified calls and localized messages", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   for (call in c("stats::filter()", "pkg:::private()")) {
      id <- rai_get(".rs.rai.registerRun")("stop('actual')", 200L)
      text <- paste0("Error in ", call, " : actual")
      rai_get(".rs.rai.recordConsoleCapture")(id, "", paste0("Error: decoy\n", text), 1, FALSE, "", "1", 40, "error", text)
      info <- rai_get(".rs.rai.getDebugInfo")(id)
      expect_identical(info$error_detail$call, call)
      expect_identical(info$error_detail$message, "actual")
   }
   id <- rai_get(".rs.rai.registerRun")("stop('localise')", 200L)
   text <- "Erreur dans fonction() : localise"
   rai_get(".rs.rai.recordConsoleCapture")(id, "", paste0("Error: decoy\n", text), 1, FALSE, "", "2", 40, "error", text)
   info <- rai_get(".rs.rai.getDebugInfo")(id)
   expect_identical(info$error_detail$message, text)
   expect_null(info$error_detail$call)
   expect_identical(info$error_detail$class, c("error", "condition"))
})

test_that("localized Error prefix cannot invent an English simpleError subclass", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   id <- rai_get(".rs.rai.registerRun")("stop('fallo')", 200L)
   text <- "Error en f(): fallo"
   rai_get(".rs.rai.recordConsoleCapture")(id, "", text, 1, FALSE, "", "1", 20, "error", text)
   detail <- rai_get(".rs.rai.getDebugInfo")(id)$error_detail
   expect_identical(detail$class, c("error", "condition"))
   expect_identical(detail$message, text)
   expect_null(detail$call)
})

test_that("native localized deferred warnings do not contaminate the error segment", {
   rai_reset_runs()
   oldLocale <- Sys.getlocale("LC_MESSAGES")
   oldLanguage <- Sys.getenv("LANGUAGE", unset = NA_character_)
   on.exit({
      rai_reset_runs()
      Sys.setlocale("LC_MESSAGES", oldLocale)
      if (is.na(oldLanguage)) Sys.unsetenv("LANGUAGE") else Sys.setenv(LANGUAGE = oldLanguage)
   }, add = TRUE)
   expect_true(nzchar(Sys.setlocale("LC_MESSAGES", "fr_FR.UTF-8")))
   Sys.setenv(LANGUAGE = "fr")
   id <- rai_get(".rs.rai.registerRun")("stop('actual')", 200L)
   text <- "Erreur : actual\nDe plus : Message d'avis :\nprior warning \n"
   rai_get(".rs.rai.recordConsoleCapture")(id, "", text, 1, FALSE, "", "1", 70, "error", text, "prior warning", expectedError = "actual")
   result <- rai_get(".rs.rai.getRunResult")(id)
   expect_match(result$stderr, "prior warning")
   expect_identical(trimws(result$native_error_text), "Erreur : actual")
   expect_false(grepl("prior warning", rai_get(".rs.rai.getDebugInfo")(id)$error_detail$message, fixed = TRUE))
})

test_that("warning-like text inside the observed error message is retained", {
   rai_reset_runs()
   on.exit(rai_reset_runs(), add = TRUE)
   message <- "actual\nDe plus : Message d'avis :\nprior warning"
   id <- rai_get(".rs.rai.registerRun")("stop('actual')", 200L)
   text <- paste0("Erreur : ", message)
   rai_get(".rs.rai.recordConsoleCapture")(id, "", text, 1, FALSE, "", "1", 70, "error", text, "prior warning", expectedError = message)
   expect_identical(rai_get(".rs.rai.getRunResult")(id)$native_error_text, text)
})

test_that("native error observation invalidates old message before any rejecting guard", {
   cpp <- readLines(testthat::test_path("../../session/modules/SessionRaiAssistant.cpp"), warn = FALSE)
   begin <- grep("^SEXP rs_raiExpectError", cpp)
   end <- grep("^SEXP rs_raiObserveCondition", cpp)
   block <- cpp[seq.int(begin, end - 1L)]
   clear <- grep("s_captureExpectedError.clear()", block, fixed = TRUE)
   validation <- grep("TYPEOF(condition)", block, fixed = TRUE)
   expect_length(clear, 1L)
   if (length(clear)) expect_lt(clear, validation[[1L]])
})

test_that("deferred metadata is explicit and requested lookup stays unavailable", {
   detail <- rai_get(".rs.rai.dataObjectDetail")
   x <- list(1L, 2L, 3L)
   attr(x, "class") <- as.character(1:3)
   assign("raiS3Class", x, .GlobalEnv)
   y <- data.frame(a = c(1L, 2L, 3L))
   names(y) <- as.character(1:1)
   assign("raiS3Names", y, .GlobalEnv)
   assign("raiS3Rows", data.frame(a = 1:3), .GlobalEnv)
   on.exit(rm(list = c("raiS3Class", "raiS3Names", "raiS3Rows"), envir = .GlobalEnv))
   expect_identical(detail("raiS3Class")$class, "unavailable")
   expect_match(detail("raiS3Class")$summary, "unavailable", fixed = TRUE)
   d <- detail("raiS3Names", requestedColumns = "a")
   expect_identical(d$metadata_unavailable, "column_names")
   expect_identical(d$requested_columns[[1L]]$availability, "unavailable")
   expect_null(d$requested_columns[[1L]]$found)
   expect_identical(d$row_count, 3L)
   rows <- detail("raiS3Rows", summaryMode = "nrow")
   expect_identical(rows$row_count, "unavailable")
   expect_true(rows$found)
})

test_that("ordinary metadata survives and unavailable row counts stay explicit", {
   detail <- rai_get(".rs.rai.dataObjectDetail")
   assign("raiS3Ordinary", data.frame(a = 1:3, b = letters[1:3]), .GlobalEnv)
   assign("raiS3Matrix", matrix(c(1L, 2L, 3L, 4L), nrow = 2L), .GlobalEnv)
   assign("raiS3Empty", structure(list(), class = "data.frame", row.names = c("x", "y")), .GlobalEnv)
   on.exit(rm(list = c("raiS3Ordinary", "raiS3Matrix", "raiS3Empty"), envir = .GlobalEnv))
   d <- detail("raiS3Ordinary")
   expect_identical(d$row_count, 3L)
   expect_identical(d$dims, c(3L, 2L))
   expect_identical(d$class, "data.frame")
   expect_identical(vapply(d$columns, `[[`, "", "name"), c("a", "b"))
   expect_null(d$metadata_unavailable)
   expect_identical(detail("raiS3Matrix")$dims, c(2L, 2L))
   expect_identical(detail("raiS3Empty")$row_count, "unavailable")
   expect_identical(detail("raiS3Empty")$column_count, 0L)
})

test_that("consumer distinguishes unavailable requested lookup from absent", {
   had <- exists(".Call", envir = rai_env, inherits = FALSE)
   if (had) previous <- get(".Call", envir = rai_env, inherits = FALSE)
   on.exit(if (had) assign(".Call", previous, rai_env) else rm(".Call", envir = rai_env))
   assign(".Call", function(...) list(found = TRUE, binding = "value",
      classes = "data.frame", row_count = "unavailable",
      metadata_unavailable = "column_names",
      requested_column_names = c("a", "b"), requested_column_found = c(FALSE, FALSE),
      requested_column_classes = c("", ""), requested_column_missing_available = c(FALSE, FALSE),
      requested_column_missing_sample_rows = c(0L, 0L), requested_column_missing_sample_counts = c(0L, 0L),
      requested_column_availability = c("unavailable", "available")), envir = rai_env)
   d <- rai_get(".rs.rai.dataObjectDetail")("raiS3Mock", summaryMode = "nrow", requestedColumns = c("a", "b"))
   expect_identical(d$row_count, "unavailable")
   expect_identical(d$requested_columns[[1L]], list(name = "a", availability = "unavailable"))
   expect_identical(d$requested_columns[[2L]]$found, FALSE)
})

test_that("native deferred metadata callbacks stay untouched through the R consumer", {
   fixture_library <- Sys.getenv("RAI_S3C_FIXTURE_LIBRARY")
   expect_true(nzchar(fixture_library), info = "Set RAI_S3C_FIXTURE_LIBRARY to the test-only fixture library")
   if (!nzchar(fixture_library)) stop("S3c native fixture library is required")
   dll <- dyn.load(fixture_library)
   fixture <- getNativeSymbolInfo("rai_s3c_fixture", dll)$address
   reset <- getNativeSymbolInfo("rai_s3c_reset", dll)$address
   counts <- getNativeSymbolInfo("rai_s3c_counts", dll)$address
   detail <- rai_get(".rs.rai.dataObjectDetail")
   on.exit(rm("A_raiS3cR", envir = .GlobalEnv), add = TRUE)
   consumer_detail <- detail
   detail <- function(...) {
      d <- consumer_detail(...)
      if (kind == 8L) {
         expect_true("column_names" %in% d$metadata_unavailable)
         if (length(d$requested_columns)) {
            expect_true(all(vapply(d$requested_columns, function(x) identical(x$availability, "unavailable"), logical(1))))
            expect_true(all(vapply(d$requested_columns, function(x) is.null(x$found), logical(1))))
         }
      }
      d
   }
   for (kind in 0:8) {
      assign("A_raiS3cR", .Call(fixture, kind), .GlobalEnv)
      operations <- list(
         function() .Call("rs_raiSafeObjectSummary", "A_raiS3cR", PACKAGE = "(embedding)"),
         function() stopifnot("A_raiS3cR" %in% .Call("rs_raiEnvironmentBindings", PACKAGE = "(embedding)")$names),
         function() detail("A_raiS3cR", summaryMode = "full"),
         function() detail("A_raiS3cR", summaryMode = "nrow"),
         function() detail("A_raiS3cR", summaryMode = "full", requestedColumns = c("a", "absent")),
         function() detail("A_raiS3cR", summaryMode = "nrow", requestedColumns = c("a", "absent")))
      for (i in seq_along(operations)) {
         .Call(reset)
         operations[[i]]()
         expect_identical(.Call(counts), integer(4L), info = paste("fixture", kind, "operation", i))
      }
   }
})


test_that("direct condition and control entries leave deferred callbacks untouched", {
   dll <- dyn.load(Sys.getenv("RAI_S3C_FIXTURE_LIBRARY"))
   fixture <- getNativeSymbolInfo("rai_s3c_fixture", dll)$address
   reset <- getNativeSymbolInfo("rai_s3c_reset", dll)$address
   counts <- getNativeSymbolInfo("rai_s3c_counts", dll)$address
   native <- function(name, ...) .Call(name, ..., PACKAGE = "(embedding)")
   for (kind in 9:11) {
      x <- .Call(fixture, kind)
      operations <- if (kind != 11L) list(
         function() native("rs_raiExpectWarning", x),
         function() native("rs_raiExpectError", x)) else list(
         function() native("rs_raiObserveCondition", x),
         function() expect_identical(native("rs_raiSafeObjectSummary", x)$summary, "<bad argument: deferred string>"),
         function() expect_false(native("rs_raiRealizedBindingIdentity", .GlobalEnv, x, baseenv())),
         function() expect_identical(native("rs_raiDataObjectDetail", x, "full", character())$summary, "<bad argument: deferred string>"),
         function() expect_identical(native("rs_raiDataObjectDetail", "x", x, character())$summary, "<bad argument: deferred string>"),
         function() expect_identical(native("rs_raiDataObjectDetail", "x", "full", x)$summary, "<bad argument: deferred string>"))
      for (operation in operations) {
         .Call(reset)
         operation()
         expect_identical(.Call(counts), integer(4L), info = paste("direct fixture", kind))
      }
   }
})


test_that("native approval policy ignores legacy false without rewriting its bytes", {
   old_home <- Sys.getenv("HOME", unset = NA_character_)
   home <- tempfile("rai-policy-home-")
   dir.create(home)
   dir.create(file.path(home, ".raistudio"))
   Sys.setenv(HOME = home)
   on.exit({
      rai_restore_envvar("HOME", old_home)
      unlink(home, recursive = TRUE, force = TRUE)
   }, add = TRUE)
   config <- file.path(home, ".raistudio", "assistant.json")
   for (legacy in c("true", "false")) {
      bytes <- charToRaw(paste0('{"autoApproveReadOnly":', legacy,
         ',"caffeinate":false,"custom":"keep"}\n'))
      writeBin(bytes, config)
      before <- file.info(config)$mtime
      expect_true(.Call("rs_raiAutoApproveReadOnlyEnabled", PACKAGE = "(embedding)"),
                  info = paste("legacy", legacy))
      expect_identical(readBin(config, "raw", n = length(bytes) + 1L), bytes)
      expect_identical(file.info(config)$mtime, before)
   }
})


test_that("S10 native path policy gates the R editor queue before requests or events", {
   old_documents <- rai_get(".rs.rai.listOpenDocuments")
   old_event <- get0(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   on.exit({
      assign(".rs.rai.listOpenDocuments", old_documents, rai_env)
      if (is.null(old_event)) rm(".rs.enqueClientEvent", envir = rai_env)
      else assign(".rs.enqueClientEvent", old_event, rai_env)
      rai_reset_grants()
   }, add = TRUE)
   events <- list()
   assign(".rs.enqueClientEvent", function(...) events[[length(events)+1L]] <<- list(...), rai_env)
   for (path in c("data/x.R", "Raw/x.py", "reference/x.R", "x.yaml", "x.foo", "x.csv", ".env"))
   {
      rai_reset_grants()
      assign(".rs.rai.listOpenDocuments", function()
         list(list(id = "s10-doc", path = path, type = "r_source")), rai_env)
      result <- rai_get(".rs.rai.queueDocumentEdit")("s10-doc", "old", "new")
      expect_identical(result$policy, "refused", info = path)
      expect_identical(result$status, "error", info = path)
      expect_identical(length(events), 0L, info = path)
      expect_identical(length(ls(rai_get(".rs.rai.grantState")$requests, all.names = TRUE)), 0L, info = path)
   }
})

test_that("S10 missing or malformed native classifier fails closed without a card", {
   wrapper <- rai_get(".rs.rai.writePathClass")
   native <- new.env(parent = environment(wrapper))
   environment(wrapper) <- native
   old_wrapper <- rai_get(".rs.rai.writePathClass")
   old_documents <- rai_get(".rs.rai.listOpenDocuments")
   old_event <- get0(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   on.exit({
      assign(".rs.rai.writePathClass", old_wrapper, rai_env)
      assign(".rs.rai.listOpenDocuments", old_documents, rai_env)
      if (is.null(old_event)) rm(".rs.enqueClientEvent", envir = rai_env)
      else assign(".rs.enqueClientEvent", old_event, rai_env)
      rai_reset_grants()
   }, add = TRUE)
   assign(".rs.rai.writePathClass", wrapper, rai_env)
   assign(".rs.rai.listOpenDocuments", function()
      list(list(id = "s10-doc", path = "src/x.py", type = "python")), rai_env)
   events <- list()
   assign(".rs.enqueClientEvent", function(...) events[[length(events)+1L]] <<- list(...), rai_env)
   for (response in list(NULL, NA_character_, TRUE, c("code", "code"), "unknown", "deniedData", "deniedEnv"))
   {
      rai_reset_grants()
      native$.Call <- function(...) response
      result <- rai_get(".rs.rai.queueDocumentEdit")("s10-doc", "old", "new")
      expect_identical(result$policy, "refused")
      expect_length(events, 0L)
      expect_length(ls(rai_get(".rs.rai.grantState")$requests, all.names = TRUE), 0L)
   }
   native$.Call <- function(...) stop("S10 classifier unavailable")
   expect_identical(rai_get(".rs.rai.queueDocumentEdit")("s10-doc", "old", "new")$policy, "refused")
   expect_length(events, 0L)
   expect_length(ls(rai_get(".rs.rai.grantState")$requests, all.names = TRUE), 0L)
})

test_that("S10 native class wrapper uses the shared resolved classifier", {
   for (path in c("src/x.py", "src/x.js", "src/x.ts", "src/x.c", "src/x.cpp", "src/x.sh", "src/x.sql", "src/x.css", "src/x.R", "src/x.Rmd", "src/x.qmd"))
      expect_identical(rai_get(".rs.rai.writePathClass")(path), "code", info = path)
   for (path in c("data/x.R", "Raw/x.py", "reference/x.R"))
      expect_identical(rai_get(".rs.rai.writePathClass")(path), "deniedData", info = path)
   expect_identical(rai_get(".rs.rai.writePathClass")(".env"), "deniedEnv")
   expect_identical(rai_get(".rs.rai.writePathClass")("x.yaml"), "unknown")
})

test_that("S10 open code buffers queue autonomous edits across languages", {
   old_read <- rai_read_document_fixture("old")
   on.exit(assign(".rs.rai.documentReadDigest", old_read, rai_env), add = TRUE)

   old_documents <- rai_get(".rs.rai.listOpenDocuments")
   old_event <- get0(".rs.enqueClientEvent", envir = rai_env, inherits = FALSE)
   on.exit({
      assign(".rs.rai.listOpenDocuments", old_documents, rai_env)
      if (is.null(old_event)) rm(".rs.enqueClientEvent", envir = rai_env)
      else assign(".rs.enqueClientEvent", old_event, rai_env)
      rai_reset_grants()
   }, add = TRUE)
   for (path in c("src/x.py", "src/x.js", "src/x.ts", "src/x.c", "src/x.cpp", "src/x.sh",
                  "src/x.sql", "src/x.css", "src/x.R", "src/x.Rmd", "src/x.qmd"))
   {
      rai_reset_grants()
      events <- list()
      assign(".rs.enqueClientEvent", function(...) events[[length(events)+1L]] <<- list(...), rai_env)
      assign(".rs.rai.listOpenDocuments", function()
         list(list(id = "s10-code", path = path, type = "text")), rai_env)
      result <- rai_get(".rs.rai.queueDocumentEdit")("s10-code", "old", "new")
      expect_identical(result$status, "applying", info = path)
      expect_identical(result$approval, "autonomous", info = path)
      expect_identical(length(events), 1L, info = path)
      key <- rai_get(".rs.rai.requestKey")("edit_document", list(path = "s10-code", domain = "r"))
      expect_true(get(key, envir = rai_get(".rs.rai.grantState")$requests)$auto_approve, info = path)
   }
})

test_that("S10 untitled writes retain only the existing R buffer types", {
   old_documents <- rai_get(".rs.rai.listOpenDocuments")
   on.exit(assign(".rs.rai.listOpenDocuments", old_documents, rai_env), add = TRUE)
   for (type in c("r_source", "r_markdown", "python", "text", ""))
   {
      assign(".rs.rai.listOpenDocuments", function()
         list(list(id = "s10-untitled", path = "", type = type)), rai_env)
      expect_identical(rai_get(".rs.rai.writePathClass")("", "s10-untitled"),
                       if (type %in% c("r_source", "r_markdown")) "code" else "unknown", info = type)
   }
})

test_that("S10c whole buffer queue preserves empty contents and cached completion", {
   old_documents <- rai_get(".rs.rai.listOpenDocuments")
   old_valid <- get0(".rs.rai.wholeFileReadValid", envir=rai_env, inherits=FALSE)
   on.exit({ assign(".rs.rai.listOpenDocuments", old_documents, rai_env)
             assign(".rs.rai.wholeFileReadValid", old_valid, rai_env); rai_reset_grants() }, add = TRUE)
   rai_reset_grants()
   assign(".rs.rai.listOpenDocuments", function() list(list(id="s10c",path="analysis.R",type="r_source")), rai_env)
   assign(".rs.rai.wholeFileReadValid", function(...) TRUE, rai_env)
   digest <- paste(rep("a",64L),collapse="")
   # A completed read may cover more than 1 MiB; empty replacement stays valid.
   queued <- rai_get(".rs.rai.queueDocumentEdit")("s10c",strrep("x",1024L*1024L+1L),"",wholeFile=TRUE,expectedDigest=digest)
   expect_identical(queued$status,"applying")
   expect_identical(queued$approval,"autonomous")
   prepared <- if (identical(queued$status,"applying")) rai_get(".rs.rai.recordGrant")(queued$request_id,"allow","once") else list()
   expect_identical(prepared$status,"apply_document")
   expect_identical(prepared$whole_file,"true")
   expect_identical(prepared$expected_digest,digest)
   expect_identical(prepared$replacement,"")
   done <- if (identical(prepared$status,"apply_document")) rai_get(".rs.rai.completeDocumentEdit")(queued$request_id,TRUE) else list()
   expect_identical(done$status,"applied")
   peek <- rai_get(".rs.rai.peekDocumentEditStatus")("s10c","changed buffer","",wholeFile=TRUE,expectedDigest=digest)
   expect_identical(peek$status,"applied")
   expect_identical(peek$trace,done$trace)
   expect_null(rai_get(".rs.rai.peekDocumentEditStatus")("s10c","old","",wholeFile=TRUE,expectedDigest=paste(rep("b",64L),collapse="")))
})

test_that("S10c unavailable token check refuses before a request", {
   old_documents <- rai_get(".rs.rai.listOpenDocuments")
   old_valid <- get0(".rs.rai.wholeFileReadValid", envir=rai_env, inherits=FALSE)
   on.exit({ assign(".rs.rai.listOpenDocuments", old_documents, rai_env)
             assign(".rs.rai.wholeFileReadValid", old_valid, rai_env); rai_reset_grants() }, add = TRUE)
   rai_reset_grants()
   assign(".rs.rai.listOpenDocuments", function() list(list(id="s10c",path="analysis.R",type="r_source")), rai_env)
   assign(".rs.rai.wholeFileReadValid", function(...) FALSE, rai_env)
   result <- rai_get(".rs.rai.queueDocumentEdit")("s10c","old","new",wholeFile=TRUE,expectedDigest=paste(rep("a",64L),collapse=""))
   expect_identical(result$status,"error")
   expect_identical(result$policy,"refused")
   expect_length(ls(rai_get(".rs.rai.grantState")$requests,all.names=TRUE),0L)
   expect_false(old_valid("not-open",paste(rep("a",64L),collapse=""),"old"))
})


test_that("S10fix snippet queue requires current full read before requests and events", {
   old_documents <- rai_get(".rs.rai.listOpenDocuments")
   old_read <- rai_get(".rs.rai.documentReadDigest")
   old_event <- get0(".rs.enqueClientEvent", envir=rai_env, inherits=FALSE)
   on.exit({ assign(".rs.rai.listOpenDocuments", old_documents, rai_env)
             assign(".rs.rai.documentReadDigest", old_read, rai_env)
             if (is.null(old_event)) rm(".rs.enqueClientEvent", envir=rai_env)
             else assign(".rs.enqueClientEvent", old_event, rai_env)
             rai_reset_grants() }, add=TRUE)
   events <- list()
   assign(".rs.enqueClientEvent", function(...) events[[length(events)+1L]] <<- list(...), rai_env)
   assign(".rs.rai.listOpenDocuments", function() list(list(id="snippet",path="x.R",type="r_source")), rai_env)
   for (reason in c("unread", "stale", "partial")) {
      rai_reset_grants()
      assign(".rs.rai.documentReadDigest", function(...) "", rai_env)
      result <- rai_get(".rs.rai.queueDocumentEdit")("snippet","a","b")
      expect_identical(result$status,"error",info=reason)
      expect_identical(result$policy,"refused",info=reason)
      expect_identical(result$message,"read whole file first / file changed since read",info=reason)
      expect_length(ls(rai_get(".rs.rai.grantState")$requests),0L)
      expect_length(events,0L)
   }
   rai_read_document_fixture("a")
   result <- rai_get(".rs.rai.queueDocumentEdit")("snippet","a","b")
   expect_identical(result$status,"applying")
   expect_length(ls(rai_get(".rs.rai.grantState")$requests),1L)
})

test_that("S10d disk trace records autonomous intent and completion and fails closed", {
   old <- rai_get(".rs.rai.appendTrace")
   on.exit(assign(".rs.rai.appendTrace", old, rai_env), add = TRUE)
   calls <- list()
   assign(".rs.rai.appendTrace", function(event, fields) {
      calls[[length(calls) + 1L]] <<- list(event = event, fields = fields)
      list(file = "fixture", seq = length(calls))
   }, rai_env)
   trace <- rai_get(".rs.rai.traceDiskWrite")
   expect_true(trace("edit_apply_requested", "src/a.R", "before", "after"))
   expect_true(trace("edit_applied", "src/a.R", "before", "after"))
   expect_identical(vapply(calls, `[[`, character(1), "event"), c("edit_apply_requested", "edit_applied"))
   expect_identical(calls[[2L]]$fields, list(path = "src/a.R", before_digest = "before",
      content_digest = "after", target = "project_disk", approval = "autonomous"))
   expect_false(trace("other", "src/a.R", "before", "after"))
   expect_length(calls, 2L)
   assign(".rs.rai.appendTrace", function(...) NULL, rai_env)
   expect_false(trace("edit_apply_requested", "src/a.R", "before", "after"))
   expect_false(trace("edit_applied", "src/a.R", "before", "after"), info = "S10d NULL completion trace must be refused")
})


test_that("S11 saving is always on: no save-on-edit accessor remains in R or native code", {
   expect_false(exists(".rs.rai.saveOnEditEnabled", envir = rai_env, inherits = FALSE))
   expect_error(.Call("rs_raiSaveOnEditEnabled", PACKAGE = "(embedding)"))
})


test_that("S11 native outcome remains pending until acknowledgement and caches saved result", {
   rai_reset_grants()
   state <- rai_get(".rs.rai.grantState")
   request <- list(requestId = "s11-cache", tool = "edit_document", decision = "allow",
                   target = list(path = "doc-cache"), trace = list(seq = 1L))
   assign("s11-cache", request, envir = state$requests)
   update <- rai_get(".rs.rai.setDocumentEditOutcome")
   authorize <- rai_get(".rs.rai.documentSaveAuthorized")
   update("s11-cache", "applying", FALSE, "Waiting for editor acknowledgement")
   expect_true(authorize("s11-cache", "doc-cache"))
   expect_false(authorize("s11-cache", "other-document"))
   expect_false(get("s11-cache", state$requests)$native_outcome$saved)
   update("s11-cache", "applied", TRUE, "")
   result <- get("s11-cache", state$requests)$native_outcome
   expect_true(result$saved)
   expect_identical(result$status, "applied")
   expect_false(authorize("s11-cache", "doc-cache"))
   update("s11-cache", "conflict", FALSE, "Editor conflict; human buffer preserved")
   expect_identical(get("s11-cache", state$requests)$native_outcome$status, "conflict")
   expect_false(get("s11-cache", state$requests)$native_outcome$saved)
})


# S12 uses synthetic inputs under one isolated project; no user data is opened
s12_writer_cases <- list(
   lines_percent = 'writeLines("replacement", "raw%input.csv")',
   lines_partial = 'writeLines(text="replacement", co=".env")',
   lines_mixed = 'writeLines(text="replacement", ".Renviron")',
   cat_partial = 'cat("replacement", file="raw%input.csv")',
   write_partial = 'write(x="replacement", fi="data/input.csv")',
   csv_partial = 'write.csv(x=data.frame(x=2), file="ref/input.csv")',
   table_partial = 'write.table(x=data.frame(x=2), file="reference/input.csv", app=FALSE)',
   rds_partial = 'saveRDS(object="replacement", fi="raw/input.rds")',
   sink_partial = '{ sink(fi=".env"); cat("replacement"); sink() }',
   file_partial = '{ con <- file(des=".Renviron", op="w"); writeLines("replacement", con); close(con) }',
   file_positional = '{ con <- file("data/input.csv", "w"); writeLines("replacement", con); close(con) }',
   connection_partial = '{ con <- file(des="ref/input.csv", op="w"); writeLines("replacement", con); close(con) }',
   graphics_existing = '{ png("raw/Rplot%03d.png"); plot.new(); dev.off() }',
   graphics_far = '{ png("Rplot%03d.png"); plot.new(); dev.off() }',
   graphics_type = '{ png("data%03d.csv"); plot.new(); dev.off() }',
   readr_partial = 'readr::write_lines(x="replacement", fi=".env")',
   datatable_partial = 'data.table::fwrite(x=data.frame(x=2), fi="data/input.csv")'
)

s12_project <- function()
{
   project <- tempfile("s12-project-")
   dir.create(project)
   for (dir in c("raw", "data", "ref", "reference")) dir.create(file.path(project, dir))
   paths <- c("raw%input.csv", ".env", ".Renviron", "raw/input.csv", "data/input.csv",
      "ref/input.csv", "reference/input.csv", "raw/input.rds", "raw/Rplot001.png",
      "Rplot001.png", "Rplot999999.png", "data001.csv")
   for (path in paths) writeLines("original", file.path(project, path))
   list(path=project, files=file.path(project, paths))
}

s12_bytes <- function(paths) lapply(paths, function(path) readBin(path, "raw", n=file.info(path)$size))

s12_execute <- function(code)
{
   connections <- as.integer(rownames(showConnections(all=TRUE)))
   outputSinks <- sink.number()
   devices <- dev.list()
   on.exit({
      while (sink.number() > outputSinks) sink()
      for (id in setdiff(dev.list(), devices)) dev.off(id)
      opened <- setdiff(as.integer(rownames(showConnections(all=TRUE))), connections)
      for (id in opened) close(getConnection(id))
   }, add=TRUE)
   fixtureEnv <- new.env(parent=globalenv())
   eval(parse(text=code), envir=fixtureEnv)
}

for (s12_name in names(s12_writer_cases)) local({
   name <- s12_name
   code <- s12_writer_cases[[name]]
   test_that(paste("S12 writer preserves synthetic project", name), {
      project <- s12_project()
      on.exit(unlink(project$path, recursive=TRUE), add=TRUE)
      old <- setwd(project$path)
      on.exit(setwd(old), add=TRUE)
      before <- s12_bytes(project$files)
      # Trusted test control proves this exact call can overwrite a synthetic input
      s12_execute(code)
      expect_false(identical(s12_bytes(project$files), before), info=paste(name, "write control"))
      for (i in seq_along(project$files)) writeBin(before[[i]], project$files[[i]])
      snapshot <- rai_get(".rs.rai.globalSnapshot")()
      policy <- rai_get(".rs.rai.dataGuard")(parse(text=code)[[1L]], snapshot, project$path)
      # A permissive guard really runs the attack, so RED proves file damage
      if (isTRUE(policy$ok)) s12_execute(code)
      expect_false(policy$ok, info=name)
      expect_identical(s12_bytes(project$files), before, info=name)
   })
})

s12_matching_cases <- function()
{
   project <- s12_project()
   on.exit(unlink(project$path, recursive=TRUE), add=TRUE)
   snapshot <- rai_get(".rs.rai.globalSnapshot")()
   guard <- function(code) rai_get(".rs.rai.dataGuard")(parse(text=code)[[1L]], snapshot, project$path)
   for (code in c('writeLines(text="x", c=".env")',
                  'writeLines(text="x", co=".env", con="new.txt")',
                  'write.table(data.frame(a=1), "new.csv", q=TRUE)',
                  'writeLines(text="x", con="new.txt", con=".env")',
                  'writeLines(text="x", ...)', 'unavailable::writeLines("x", "new.txt")',
                  'readr::write_lines("x", "new.txt", mystery=".env")',
                  'png(".env%03d")', 'png("raw/new%03d.png")',
                  'png("new%03d.csv")', 'png("new%03d.png")', 'png("new%q.png")', 'png("raw%03d/plot.png")'))
      test_that(paste("S12 matching refuses", code), expect_false(guard(code)$ok, info=code))
   for (code in c('writeLines(text="x", "new.txt")',
                  'writeLines("x", co="new.txt")', 'writeLines(con="new.txt", "x")',
                  'write.table(x=data.frame(a=1), "new.csv")', 'cat("x", file="new.txt")',
                  'file(description="new.txt", "w")'))
      test_that(paste("S12 matching accepts", code), expect_true(guard(code)$ok, info=code))
   unlink(file.path(project$path, "Rplot001.png"))
   test_that("S12 matching refuses far graphics page", expect_false(guard('png("Rplot%03d.png")')$ok))
   test_that("S12 matching preserves far graphics page", expect_identical(readLines(file.path(project$path, "Rplot999999.png")), "original"))
}
s12_matching_cases()

for (s12_writer in c("write.table", "write.csv")) local({
   writer <- s12_writer
   test_that(paste("S12 ambiguous prefix refuses without execution", writer), {
      project <- s12_project()
      on.exit(unlink(project$path, recursive=TRUE), add=TRUE)
      before <- s12_bytes(project$files)
      code <- sprintf('%s(x=data.frame(x=2), fi="reference/input.csv")', writer)
      snapshot <- rai_get(".rs.rai.globalSnapshot")()
      policy <- rai_get(".rs.rai.dataGuard")(parse(text=code)[[1L]], snapshot, project$path)
      expect_false(policy$ok)
      expect_identical(s12_bytes(project$files), before)
      expect_identical(sort(list.files(project$path, all.files=TRUE, recursive=TRUE)),
         sort(substring(project$files, nchar(project$path)+2L)))
   })
})

fix4_connection_cases <- function(guard, snapshot, project) {
   project <- normalizePath(project)
   dir.create(file.path(project, ".raistudio"))
   paths <- c(".Renviron", ".raistudio/assistant.json", "raw.csv", ".RData", "new.R", "normal.txt")
   for (path in paths[c(1, 2, 3, 4, 6)]) writeLines("SYNTHETIC_FIX4", file.path(project, path))
   modes <- c("'r'", "'rb'", "'rt'", "'r+'", "'w'", "'a'", "'wb'", "'w+'", "''", "OMITTED", "mode", "paste0('r', '')")
   for (constructor in c("file", "gzfile", "bzfile", "xzfile"))
      for (path in paths) for (mode in modes) for (binding in c("open=", "op=", "ope=", "")) {
         suffix <- if (mode == "OMITTED") "" else paste0(", ", binding, mode)
         code <- paste0(constructor, "(", deparse(file.path(project, path)), suffix, ")")
         result <- guard(parse(text = code)[[1L]], snapshot, project)
         reading <- mode %in% c("'r'", "'rb'", "'rt'")
         writing <- mode %in% c("'r+'", "'w'", "'a'", "'wb'", "'w+'")
         allowed <- if (reading) !path %in% c(".Renviron", ".raistudio/assistant.json") else (writing || mode %in% c("OMITTED", "''")) && path == "new.R"
         expect_identical(result$ok, allowed, info = code)
         if (allowed && reading) expect_identical(result$files_read, file.path(project, path), info = code)
         if (allowed && writing) expect_identical(result$files_written, file.path(project, path), info = code)
      }
   for (path in paths[c(1, 2, 4)]) for (reader in c("readLines", "load", "file.copy")) {
      suffix <- switch(reader, load = ", envir=new.env()", file.copy = paste0(", ", deparse(file.path(project, "copy.txt"))), "")
      code <- paste0(reader, "(", deparse(file.path(project, path)), suffix, ")")
      result <- guard(parse(text=code)[[1L]], snapshot, project)
      expect_identical(result$ok, !path %in% c(".Renviron", ".raistudio/assistant.json"), info=code)
      if (result$ok) expect_identical(result$files_read, normalizePath(file.path(project, path)), info=code)
   }
}

test_that("S12 fix4 connection modes preserve read and write policy", {
   project <- tempfile("fix4-connections-"); dir.create(project)
   on.exit(unlink(project, recursive=TRUE), add=TRUE)
   fix4_connection_cases(rai_get(".rs.rai.dataGuard"), list(names=character(), identities=list()), project)
})

fix5_cases <- function(guard, snapshot, project) {
   old <- getwd()
   on.exit(setwd(old), add = TRUE)
   project <- normalizePath(project)
   dir.create(file.path(project, "raw"))
   target <- file.path(project, "raw", "input.csv")
   cases <- c(
      capture = sprintf('utils::capture.output(1, file=%s)', deparse(target)),
      capture_partial = sprintf('utils::capture.output(1, fi=%s)', deparse(target)),
      capture_append = sprintf('utils::capture.output(1, file=%s, append=TRUE)', deparse(target)),
      setwd = '{setwd("raw"); writeLines("replacement", "input.csv")}',
      with_dir = sprintf('withr::with_dir(%s, writeLines("replacement", "input.csv"))', deparse(dirname(target))),
      local_dir = 'withr::local_dir("raw")',
      home = 'Sys.setenv(HOME="raw", R_USER="raw")',
      locale = 'Sys.setlocale("LC_ALL", "C")',
      options = 'options(expressions=1000)',
      trace = 'trace("writeLines", quote(unlink("input.csv")))',
      serialize = sprintf('serialize(1, %s)', deparse(target)),
      yaml = sprintf('yaml::write_yaml(1, %s)', deparse(target)),
      unknown = 'unavailable::innocent()',
      hidden = 'base:::setwd("raw")',
      closure = '(function() utils::capture.output(1, file="raw/input.csv"))()',
      dynamic = 'do.call("capture.output", list(1, file="raw/input.csv"))',
      lookup = 'match.fun("capture.output")(1, file="raw/input.csv")',
      exported = 'getExportedValue("utils", "capture.output")(1, file="raw/input.csv")',
      r6 = 'obj$write()')
   for (name in names(cases)) {
      writeLines("SYNTHETIC_ORIGINAL", target)
      setwd(project)
      result <- guard(parse(text=cases[[name]])[[1L]], snapshot, project)
      if (isTRUE(result$ok) && name %in% c("capture", "setwd"))
         eval(parse(text=cases[[name]]), new.env(parent=globalenv()))
      setwd(old)
      expect_false(result$ok, info=paste(name, cases[[name]]))
      expect_identical(readLines(target), "SYNTHETIC_ORIGINAL", info=name)
   }
}

fix5_inventory_cases <- function(guard, snapshot, project, inventory) {
   rows <- read.delim(inventory, stringsAsFactors=FALSE, check.names=FALSE)
   packages <- c("base", "utils", "tools", "stats", "methods", "graphics", "grDevices",
      "readr", "data.table", "arrow", "jsonlite", "openxlsx", "writexl", "yaml", "fs",
      "withr", "readxl", "haven", "vroom", "qs", "feather", "fst")
   keys <- character()
   for (package in packages) {
      if (!requireNamespace(package, quietly=TRUE)) next
      ns <- asNamespace(package)
      functions <- Filter(function(name) !bindingIsActive(name,ns) &&
         is.function(get(name,ns,inherits=FALSE)), ls(ns,all.names=TRUE))
      keys <- c(keys, paste(package,functions,sep="::"))
   }
   expect_setequal(paste(rows$package,rows$name,sep="::"), keys)
   expect_identical(anyDuplicated(paste(rows$package,rows$name,sep="::")), 0L)
   for (i in seq_len(nrow(rows))) {
      row <- rows[i,]
      call <- as.call(list(as.call(list(as.name("::"),as.name(row$package),as.name(row$name)))))
      result <- guard(call,snapshot,project)
      expect_identical(result$ok, row$guard != "refused", info=paste(row$package,row$name))
      if (row$class != "neutral")
         expect_true(!result$ok || row$guard == "validated", info=paste(row$package,row$name,row$class))
   }
}

test_that("S12 fix5 refuses unclassified effects and inventories namespace calls", {
 p <- tempfile("fix5-");dir.create(p);on.exit(unlink(p,recursive=TRUE))
 guard <- rai_env$.rs.rai.dataGuard
 snapshot <- list(names=character(),identities=list())
 fix5_cases(guard,snapshot,p)
 inventory <- Sys.getenv("RAI_NAMESPACE_INVENTORY_TSV", unset = test_path("fixtures", "NAMESPACE-INVENTORY.tsv"))
 if (!nzchar(inventory)) inventory <- test_path("fixtures", "NAMESPACE-INVENTORY.tsv")
 expect_true(file.exists(inventory), info = inventory)
 fix5_inventory_cases(guard,snapshot,p,inventory)
})


# S12 protected tempfile destinations and canonical partial-reader sources.
test_that("S12 P1 tempfile destinations cannot create files inside protected directories", {
   guard <- rai_get(".rs.rai.dataGuard")
   snapshot <- list(names = character(), identities = list())
   project <- tempfile("rai-p1-destination-"); dir.create(project)
   on.exit(unlink(project, recursive = TRUE), add = TRUE)
   dirs <- c("raw", "data", "ref", "reference", "references", "environment", ".raistudio")
   for (name in dirs) dir.create(file.path(project, name))
   stopifnot(file.symlink(file.path(project, "raw"), file.path(project, "safe-looking-alias")))
   paths <- file.path(project, c(dirs, "safe-looking-alias"))
   for (path in paths) {
      literal <- encodeString(path, quote = '"')
      calls <- c(paste0("tempfile(tmpdir=", literal, ", fileext='.R')"),
                 paste0("tempfile(tmpd=", literal, ", fileext='.R')"),
                 paste0("tempfile('rai-', ", literal, ", '.R')"))
      for (call in calls) {
         expression <- parse(text = paste0("writeLines('RAI_DUMMY', ", call, ")"))[[1L]]
         before <- sort(list.files(path, all.files = TRUE, no.. = TRUE))
         policy <- guard(expression, snapshot, project)
         expect_false(isTRUE(policy$ok), info = call)
         if (isTRUE(policy$ok)) eval(expression, envir = new.env(parent = baseenv()))
         expect_identical(sort(list.files(path, all.files = TRUE, no.. = TRUE)), before,
                          info = paste("guarded write created protected output:", call))
      }
   }
})

test_that("S12 P1 safe tempfile destinations retain normal guarded write behavior", {
   guard <- rai_get(".rs.rai.dataGuard")
   snapshot <- list(names = character(), identities = list())
   project <- tempfile("rai-p1-safe-"); dir.create(project)
   on.exit(unlink(project, recursive = TRUE), add = TRUE)
   output <- file.path(project, "code-output"); dir.create(output)
   literal <- encodeString(output, quote = '"')
   calls <- c("tempfile()", "tempfile(pattern='rai-', tmpdir=tempdir(), fileext='.R')",
              paste0("tempfile(pattern='rai-', tmpdir=", literal, ", fileext='.R')"))
   for (call in calls) {
      policy <- guard(parse(text = paste0("writeLines('RAI_DUMMY', ", call, ")"))[[1L]], snapshot, project)
      expect_true(isTRUE(policy$ok), info = call)
      expect_true(length(policy$files_written) > 0L, info = call)
   }
})

test_that("S12 P1 partially named readers cannot disclose internal credential-state sources", {
   guard <- rai_get(".rs.rai.dataGuard")
   snapshot <- list(names = character(), identities = list())
   project <- tempfile("rai-p1-internal-reader-"); dir.create(project)
   on.exit(unlink(project, recursive = TRUE), add = TRUE)
   internal <- file.path(project, ".raistudio"); dir.create(internal)
   text <- file.path(internal, "dummy-state.txt"); writeLines("RAI_DUMMY_ONLY", text)
   rds <- file.path(internal, "dummy-state.rds"); saveRDS("RAI_DUMMY_ONLY", rds)
   calls <- c(paste0("readLines(co=", encodeString(text, quote='"'), ")"),
              paste0("base::readLines(n=1L, co=", encodeString(text, quote='"'), ")"),
              paste0("readRDS(fi=", encodeString(rds, quote='"'), ")"),
              paste0("base::readRDS(fi=", encodeString(rds, quote='"'), ")"))
   for (call in calls) {
      policy <- guard(parse(text=call)[[1L]], snapshot, project)
      expect_false(isTRUE(policy$ok), info=call)
   }
})

test_that("S12 P1 ordinary partially named reads retain canonical receipts and original lineage", {
   guard <- rai_get(".rs.rai.dataGuard")
   snapshot <- list(names = character(), identities = list())
   project <- tempfile("rai-p1-ordinary-reader-"); dir.create(project)
   on.exit(unlink(project, recursive = TRUE), add = TRUE)
   text <- file.path(project, "input.txt"); writeLines("RAI_DUMMY_ONLY", text)
   rds <- file.path(project, "input.rds"); saveRDS("RAI_DUMMY_ONLY", rds)
   calls <- c(paste0("readLines(co=", encodeString(text, quote='"'), ")"),
              paste0("base::readLines(n=1L, co=", encodeString(text, quote='"'), ")"),
              paste0("readRDS(fi=", encodeString(rds, quote='"'), ")"),
              paste0("base::readRDS(fi=", encodeString(rds, quote='"'), ")"))
   paths <- c(text, text, rds, rds)
   for (index in seq_along(calls)) {
      policy <- guard(parse(text=paste0("rai_original <- ", calls[[index]]))[[1L]], snapshot, project)
      expect_true(isTRUE(policy$ok), info=calls[[index]])
      expect_true(normalizePath(paths[[index]], winslash="/", mustWork=TRUE) %in% policy$files_read,
                  info=paste("missing canonical receipt", calls[[index]]))
      expect_true("rai_original" %in% policy$original_targets, info=calls[[index]])
   }
})
