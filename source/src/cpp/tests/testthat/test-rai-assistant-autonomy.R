#
# test-rai-assistant-autonomy.R
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

# Autonomy and derived-data contract: supported code edits and strict R Console runs
# proceed without approval cards; original data is never edited directly
# (refused outright, never offered as an approval); every Assistant run leaves a
# durable exact-code trace linked to its result. Fixtures are temporary files
# and uniquely named .GlobalEnv bindings removed after each test -- never user
# data, and the trace directory is always a per-test temporary directory.

context("RAI Assistant autonomy and derived data")

test_that("Full Auto applies an exact code edit without an approval card and traces it", {
   fx <- aut_fixture()
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)

   queued <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(queued$status, "applying")
   expect_identical(queued$approval, "autonomous")

   # One client event, flagged automatic: ChatPresenter settles it with no card.
   expect_length(fx$events$items, 1L)
   expect_identical(fx$events$items[[1L]]$type, "rai_approval_request")
   expect_true(fx$events$items[[1L]]$data$auto_approve)

   prepared <- aut_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")
   expect_identical(prepared$status, "apply_document")
   expect_identical(prepared$expected_text, "x <- 1")
   expect_identical(prepared$replacement, "x <- 2")

   done <- aut_get(".rs.rai.completeDocumentEdit")(queued$request_id, TRUE)
   expect_identical(done$status, "applied")
   expect_false(is.null(done$trace$seq))

   # Re-polling the identical edit reports the settled result, never a second apply.
   again <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(again$status, "applied")
   expect_length(fx$events$items, 1L)
   # The settled trace link carried through the cache hit must be the exact
   # same durable record .rs.rai.completeDocumentEdit produced, not a fresh
   # or empty one -- this is the concrete regression for the QA report of a
   # poll-after-apply losing the trace linkage (trace_seq: null): the C++
   # handler now reaches this exact cached result via
   # .rs.rai.peekDocumentEditStatus() before ever re-running native anchor
   # validation, so it must still expose a real, non-NULL seq/file.
   expect_identical(again$trace$seq, done$trace$seq)
   expect_identical(again$trace$file, done$trace$file)
   expect_false(is.null(again$trace$seq))

   # .rs.rai.peekDocumentEditStatus is the new cache-only helper the C++
   # handler calls before native anchor revalidation; it must report the
   # exact same settled result as the cache-hit branch of queueDocumentEdit
   # above. It still re-validates document identity (the id must resolve to
   # a currently-open document, exactly like queueDocumentEdit) -- that
   # check is deliberately preserved even on the fast cache-hit path, since
   # it is an identity/authorization check, not the anchor/content
   # revalidation this fix is bypassing. It does NOT touch buffer content,
   # read-only status, or run any anchor matching.
   peeked <- aut_get(".rs.rai.peekDocumentEditStatus")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(peeked$status, "applied")
   expect_identical(peeked$trace$seq, done$trace$seq)
   expect_identical(peeked$trace$file, done$trace$file)

   # A different (non-matching) proposal for the same document has no cache
   # entry, so the peek must report NULL (signalling "fall through to native
   # validation"), never fabricate a result for an unrelated edit.
   miss <- aut_get(".rs.rai.peekDocumentEditStatus")("doc-auto", "y <- 1", "y <- 2")
   expect_null(miss)

   # Closing the document invalidates identity for the peek path exactly as
   # it does for queueDocumentEdit -- a stale/no-longer-open id must never
   # resolve to a cached grant.
   aut_set(".rs.rai.listOpenDocuments", function() list())
   closedMiss <- aut_get(".rs.rai.peekDocumentEditStatus")("doc-auto", "x <- 1", "x <- 2")
   expect_null(closedMiss)
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())

   records <- aut_trace_records(fx)
   applied <- Filter(function(r) identical(r$event, "edit_applied"), records)
   expect_length(applied, 1L)
   expect_identical(applied[[1L]]$approval, "autonomous")
   expect_identical(applied[[1L]]$expected_text, "x <- 1")
   expect_identical(applied[[1L]]$replacement, "x <- 2")
   expect_match(applied[[1L]]$undo, "Undo")
})

test_that("missing edit intent trace refuses before native apply", {
   fx <- aut_fixture()
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)
   queued <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   append <- aut_get(".rs.rai.appendTrace")
   aut_set(".rs.rai.appendTrace", function(event, fields = list())
      if (identical(event, "edit_apply_requested")) NULL else append(event, fields))
   on.exit(aut_set(".rs.rai.appendTrace", append), add = TRUE)
   result <- aut_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")
   expect_identical(result$status, "error")
   expect_match(result$message, "trace")
   expect_identical(aut_get(".rs.rai.queueDocumentEdit")(
      "doc-auto", "x <- 1", "x <- 2")$status, "error")
   expect_length(fx$events$items, 1L)
   expect_length(Filter(function(r) identical(r$event, "edit_applied"), aut_trace_records(fx)), 0L)
})

test_that("failed final edit trace never reports an applied request", {
   fx <- aut_fixture()
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)
   queued <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(aut_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")$status,
                    "apply_document")
   append <- aut_get(".rs.rai.appendTrace")
   aut_set(".rs.rai.appendTrace", function(event, fields = list())
      if (identical(event, "edit_applied")) NULL else append(event, fields))
   on.exit(aut_set(".rs.rai.appendTrace", append), add = TRUE)
   result <- aut_get(".rs.rai.completeDocumentEdit")(queued$request_id, TRUE)
   expect_identical(result$status, "error")
   expect_match(result$message, "trace", ignore.case = TRUE)
   expect_identical(aut_get(".rs.rai.queueDocumentEdit")(
      "doc-auto", "x <- 1", "x <- 2")$status, "error")
   expect_length(fx$events$items, 1L)
   expect_length(Filter(function(r) identical(r$event, "edit_applied"), aut_trace_records(fx)), 0L)
})

test_that("a stale automatic edit is rejected terminally and never re-armed", {
   fx <- aut_fixture()
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)

   queued <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(aut_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")$status,
                    "apply_document")
   # Native revalidation found the buffer changed since the proposal.
   stale <- aut_get(".rs.rai.completeDocumentEdit")(
      queued$request_id, FALSE, "expected_text no longer occurs exactly once in the document")
   expect_identical(stale$status, "error")
   expect_match(stale$message, "no longer occurs")

   repoll <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(repoll$status, "error")
   expect_match(repoll$message, "no longer occurs")
   expect_length(fx$events$items, 1L)
   # The settled request cannot be re-approved into a second native apply.
   expect_identical(aut_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")$status, "error")

   rejected <- Filter(function(r) identical(r$event, "edit_rejected"), aut_trace_records(fx))
   expect_length(rejected, 1L)
   expect_match(rejected[[1L]]$reason, "no longer occurs")
})

test_that("a manual pending or declined edit cannot become automatic after Full Auto changes", {
   fx <- aut_fixture(autonomous = FALSE)
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)
   mode <- new.env(parent = emptyenv())
   mode$enabled <- FALSE
   aut_set(".rs.rai.autoApproveReadOnlyEnabled", function() mode$enabled)

   pending <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(pending$status, "approval_required")
   expect_false(fx$events$items[[1L]]$data$auto_approve)
   mode$enabled <- TRUE
   observed <- aut_get(".rs.rai.peekDocumentEditStatus")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(observed$status, "approval_required")
   expect_identical(observed$request_id, pending$request_id)
   retried <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(retried$status, "approval_required")
   expect_identical(retried$request_id, pending$request_id)
   expect_length(fx$events$items, 1L)

   declined <- aut_get(".rs.rai.recordGrant")(pending$request_id, "decline", "once")
   expect_identical(declined$status, "declined")
   peek <- aut_get(".rs.rai.peekDocumentEditStatus")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(peek$status, "error")
   expect_match(peek$message, "approval declined")
   refused <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(refused$status, "error")
   expect_match(refused$message, "approval declined")
   expect_length(fx$events$items, 1L)
   expect_length(Filter(function(r) identical(r$event, "edit_applied"), aut_trace_records(fx)), 0L)
})

test_that("an automatic pending edit reaches native apply rather than a manual card", {
   fx <- aut_fixture(autonomous = TRUE)
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)
   pending <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(pending$status, "applying")
   expect_true(fx$events$items[[1L]]$data$auto_approve)
   expect_null(aut_get(".rs.rai.peekDocumentEditStatus")("doc-auto", "x <- 1", "x <- 2"))
   retry <- aut_get(".rs.rai.queueDocumentEdit")("doc-auto", "x <- 1", "x <- 2")
   expect_identical(retry$status, "applying")
   expect_identical(retry$request_id, pending$request_id)
   expect_length(fx$events$items, 1L)
})

test_that("environment and profile files are refused outright, in auto and manual modes", {
   for (autonomous in c(TRUE, FALSE)) local({
      fx <- aut_fixture(autonomous = autonomous)
      for (path in c("/proj/.Rprofile", "/proj/.Renviron", "/proj/cache/model.rda", "/proj/renv.lock"))
      {
         aut_set(".rs.rai.listOpenDocuments", aut_open_documents(path, "doc-env"))
         result <- aut_get(".rs.rai.queueDocumentEdit")("doc-env", "a <- 1", "a <- 2")
         expect_identical(result$status, "error", info = path)
         expect_identical(result$policy, "refused", info = path)
         expect_match(result$message, "environment/profile", info = path)
      }
      aut_set(".rs.rai.listOpenDocuments", function() list())
      expect_length(fx$events$items, 0L)
      expect_length(ls(aut_get(".rs.rai.grantState")$requests, all.names = TRUE), 0L)
   })
})

test_that("protected environment reads are refused, lock files stay readable and writers stay refused", {
   fx <- aut_fixture()
   paths <- file.path(fx$dir, c(".Renviron", ".Rprofile", ".env", ".env.local", "renv.lock"))
   for (path in paths) writeLines("RAI_DUMMY_ENV=unchanged", path)
   before <- lapply(paths, aut_get(".rs.rai.fileFingerprint"))
   guard <- aut_get(".rs.rai.dataGuard")
   snapshot <- aut_get(".rs.rai.globalSnapshot")()
   for (path in paths)
   {
      code <- paste0("readLines(", deparse(path), ")")
      result <- guard(parse(text = code)[[1L]], snapshot)
      readable <- identical(basename(path), "renv.lock")
      expect_identical(result$ok, readable, info = code)
      if (readable && isTRUE(result$ok))
         expect_identical(result$files_read, normalizePath(path, winslash = "/"))
      if (!readable && !isTRUE(result$ok))
         expect_match(result$reason, "protected environment", info = code)

      for (writer in c(paste0("writeLines('changed', ", deparse(path), ")"),
                       paste0("file(", deparse(path), ", open = 'w')"),
                       paste0("file.copy(", deparse(paths[[5L]]), ", ", deparse(path), ")")))
      {
         refused <- guard(parse(text = writer)[[1L]], snapshot)
         expect_false(refused$ok, info = writer)
         expect_match(refused$reason, "environment/profile", info = writer)
      }
   }
   expect_identical(lapply(paths, aut_get(".rs.rai.fileFingerprint")), before)

   refused <- aut_queue(paste0("readLines(", deparse(paths[[1L]]), ")"), "environment-read-refused")
   expect_identical(refused$status, "error")
   expect_identical(refused$policy, "refused")
   queued <- aut_queue(paste0("readLines(", deparse(paths[[5L]]), ")"), "environment-read-fresh")
   expect_identical(queued$status, "queued")
   if (identical(queued$status, "queued"))
      expect_identical(aut_execute(queued$run_id)$status, "ok")
   expect_length(fx$events$items, 0L)
   expect_identical(lapply(paths, aut_get(".rs.rai.fileFingerprint")), before)
})

test_that("environment load and copy sources retain exact read evidence", {
   fx <- aut_fixture()
   source <- file.path(fx$dir, ".RData")
   writeLines("RAI_DUMMY_WORKSPACE", source)
   destination <- file.path(fx$dir, "copy.txt")
   guard <- aut_get(".rs.rai.dataGuard")
   snapshot <- aut_get(".rs.rai.globalSnapshot")()
   for (code in c(paste0("load(", deparse(source), ", envir = new.env())"),
                  paste0("file(", deparse(source), ", open = 'r')"),
                  paste0("file.copy(", deparse(source), ", ", deparse(destination), ")")))
   {
      result <- guard(parse(text = code)[[1L]], snapshot)
      expect_true(result$ok, info = code)
      if (isTRUE(result$ok))
         expect_identical(result$files_read, normalizePath(source, winslash = "/"), info = code)
   }
   expect_false(file.exists(destination)) # policy walk never executes a copy
   unsafe <- guard(parse(text = paste0("load(", deparse(source), ")"))[[1L]], snapshot)
   expect_false(unsafe$ok)
   expect_match(unsafe$reason, "new.env")
})

test_that("internal credential sources remain refused through literal and canonical paths", {
   fx <- aut_fixture()
   internal <- file.path(fx$dir, ".raistudio")
   dir.create(internal)
   source <- file.path(internal, "assistant.json")
   writeLines("RAI_DUMMY_INTERNAL_STATE", source)
   alias <- file.path(fx$dir, "ordinary.txt")
   expect_true(file.symlink(source, alias))
   before <- aut_get(".rs.rai.fileFingerprint")(source)
   guard <- aut_get(".rs.rai.dataGuard")
   snapshot <- aut_get(".rs.rai.globalSnapshot")()
   for (path in c(source, alias))
      for (code in c(paste0("readLines(", deparse(path), ")"),
                     paste0("file(", deparse(path), ", open = 'r')"),
                     paste0("load(", deparse(path), ", envir = new.env())"),
                     paste0("file.copy(", deparse(path), ", ",
                            deparse(file.path(fx$dir, "internal-copy.txt")), ")")))
      {
         result <- guard(parse(text = code)[[1L]], snapshot)
         expect_false(result$ok, info = code)
         expect_match(result$reason, "protected environment", info = code)
         expect_false(grepl("RAI_DUMMY_INTERNAL_STATE", result$reason, fixed = TRUE))
      }
   expect_false(file.exists(file.path(fx$dir, "internal-copy.txt")))
   expect_identical(aut_get(".rs.rai.fileFingerprint")(source), before)
   expect_length(fx$events$items, 0L)
})

test_that("direct edits of original data are refused, never approval-gated, and change nothing", {
   for (autonomous in c(TRUE, FALSE)) local({
      fx <- aut_fixture(autonomous = autonomous)
      assign("rai_fx_orig", data.frame(a = 1:3, b = c("x", "y", "z")), envir = globalenv())
      original <- get("rai_fx_orig", envir = globalenv())
      input <- file.path(fx$dir, "input.csv")
      utils::write.csv(original, input, row.names = FALSE)
      input_hash <- digest::digest(file = input, algo = "sha256")
      env_file <- file.path(fx$dir, ".Renviron")
      q <- function(x) deparse(x)

      prohibited <- c(
         "rai_fx_orig$a <- 0L",
         paste0("{ rai_fx_inline <- utils::read.csv(", q(input), "); rai_fx_inline$v <- 0 }"),
         "rai_fx_orig[1, 'a'] <- 99L",
         "rai_fx_orig <- head(rai_fx_orig, 1)",
         "names(rai_fx_orig) <- c('p', 'q')",
         "rm(rai_fx_orig)",
         "assign('rai_fx_orig', NULL)",
         "rai_fx_orig <<- NULL",
         "data.table::setnames(rai_fx_orig, 'a', 'z')",
         "fix(rai_fx_orig)",
         "utils::edit(rai_fx_orig)",
         ".GlobalEnv$rai_fx_orig <- NULL",
         "local(rai_fx_orig <- NULL, envir = globalenv())",
         "system('true')",
         "system2('true')",
         paste0("utils::write.csv(rai_fx_orig, ", q(input), ")"),
         paste0("writeLines('X=1', ", q(env_file), ")"),
         paste0("unlink(", q(input), ")"),
         paste0("file.rename(", q(input), ", 'moved.csv')"),
         paste0("saveRDS(rai_fx_orig, ", q(file.path(fx$dir, "ws.RData")), ")"),
         "save.image()",
         "sink('out.txt')",
         "source('script.R')",
         "rstudioapi::insertText('x')",
         "processx::run('true')",
         "list2env(list(rai_fx_orig = 1), envir = environment())",
         paste0("load(", q(input), ")"))

      for (code in prohibited)
      {
         result <- aut_queue(code)
         expect_identical(result$status, "error", info = code)
         expect_false(identical(result$status, "approval_required"), info = code)
      }

      expect_length(fx$events$items, 0L)
      expect_length(ls(aut_get(".rs.rai.runState")$records, all.names = TRUE), 0L)
      expect_identical(get("rai_fx_orig", envir = globalenv()), original)
      expect_identical(digest::digest(file = input, algo = "sha256"), input_hash)
      expect_false(file.exists(env_file))

      refused <- Filter(function(r) identical(r$event, "run_refused"), aut_trace_records(fx))
      expect_gte(length(refused), 20L)
      expect_true(all(vapply(refused, function(r) is.character(r$code) && nzchar(r$reason), logical(1L))))
   })
})

test_that("derived data is created through traced code while originals and input files are preserved", {
   fx <- aut_fixture()
   assign("rai_fx_orig", data.frame(a = 1:3), envir = globalenv())
   original <- get("rai_fx_orig", envir = globalenv())
   input <- file.path(fx$dir, "input.csv")
   utils::write.csv(data.frame(g = c(1, 1, 2), v = c(2, 4, 6)), input, row.names = FALSE)
   input_hash <- digest::digest(file = input, algo = "sha256")
   output <- file.path(fx$dir, "derived-summary.csv")

   steps <- c(
      "rai_fx_derived <- transform(rai_fx_orig, doubled = a * 2)",
      paste0("rai_fx_csv <- utils::read.csv(", deparse(input), ")"),
      "rai_fx_summary <- aggregate(v ~ g, data = rai_fx_csv, FUN = mean)",
      paste0("utils::write.csv(rai_fx_summary, ", deparse(output), ", row.names = FALSE)"),
      # rebinding an Assistant-derived object is allowed; it is not an original
      "rai_fx_derived <- rai_fx_derived[rai_fx_derived$doubled > 2, ]")

   results <- list()
   for (code in steps)
   {
      queued <- aut_queue(code)
      expect_identical(queued$status, "queued", info = code)
      expect_identical(queued$code, code)
      results[[code]] <- aut_execute(queued$run_id)
      expect_identical(results[[code]]$status, "ok", info = code)
      expect_identical(results[[code]]$approval, "autonomous", info = code)
   }
   expect_length(fx$events$items, 0L)

   # originals preserved
   expect_identical(get("rai_fx_orig", envir = globalenv()), original)
   expect_identical(digest::digest(file = input, algo = "sha256"), input_hash)
   # derived outputs exist
   expect_identical(get("rai_fx_derived", envir = globalenv())$doubled, c(4, 6))
   expect_true(file.exists(output))

   first <- results[[steps[[1L]]]]
   expect_identical(first$data_effects$bindings_created, list(I("rai_fx_derived")))
   expect_identical(first$data_effects$originals_rebound, list())
   expect_identical(first$data_effects$originals_removed, list())
   expect_identical(aut_get(".rs.rai.toJson")(first$data_effects$bindings_created), '["rai_fx_derived"]')
   expect_identical(aut_get(".rs.rai.toJson")(first$data_effects$originals_rebound), '[]')
   expect_identical(aut_get(".rs.rai.toJson")(lapply(as.list(c("a", "b")), I)), '["a","b"]')
   expect_identical(unclass(first$data_effects$original_data_changed_observed), FALSE)
   expect_true(inherits(first$data_effects$original_data_changed_observed, "AsIs"))
   expect_true("rai_fx_orig" %in% unlist(first$data_effects$referenced_inputs))
   expect_match(first$data_effects$lineage, "not a complete lineage")

   read_step <- results[[steps[[2L]]]]
   expect_identical(unclass(read_step$data_effects$input_files[[1L]]$unchanged), TRUE)
   expect_true(inherits(read_step$data_effects$input_files[[1L]]$unchanged, "AsIs"))
   expect_identical(unclass(read_step$data_effects$input_files[[1L]]$sha256), input_hash)
   expect_identical(aut_get(".rs.rai.toJson")(read_step$data_effects$input_files[[1L]]$unchanged), "true")

   write_step <- results[[steps[[4L]]]]
   expect_identical(unclass(write_step$data_effects$output_files[[1L]]$path),
                    normalizePath(output, winslash = "/", mustWork = TRUE))
   expect_identical(unclass(write_step$data_effects$output_files[[1L]]$exists), TRUE)

   rebind <- results[[steps[[5L]]]]
   expect_identical(unlist(rebind$data_effects$bindings_rebound_derived), "rai_fx_derived")
   expect_length(rebind$data_effects$originals_rebound, 0L)

   # the original can still not be changed after derived work exists
   expect_identical(aut_queue("rai_fx_orig <- rai_fx_derived")$status, "error")
})

test_that("existing plot/helper/path bindings authorize without consent before safe plain rebinding", {
   fx <- aut_fixture()
   on.exit({
      owned <- intersect(c("forest.plots", "forest.plots.significant", "sig4_dir",
                           "make_csx_spearman_hm", "rai_chunk_new_helper"),
                         ls(globalenv(), all.names = TRUE))
      if (length(owned)) rm(list = owned, envir = globalenv())
   }, add = TRUE)
   plot <- structure(list(label = "safe"), class = "ggplot")
   assign("forest.plots", list(plot), envir = globalenv())
   assign("forest.plots.significant", list(plot), envir = globalenv())
   assign("sig4_dir", file.path(fx$dir, "derived-plots"), envir = globalenv())
   assign("make_csx_spearman_hm", function(x) x, envir = globalenv())
   proposals <- list(
      list(name = "forest.plots", kind = "plots", code =
         "forest.plots <- list(structure(list(label = 'new'), class = 'ggplot'))"),
      list(name = "forest.plots.significant", kind = "plots", code =
         "forest.plots.significant <- list(structure(list(label = 'sig'), class = 'ggplot'))"),
      list(name = "sig4_dir", kind = "path", code = "sig4_dir <- 'derived-plots-new'"),
      list(name = "make_csx_spearman_hm", kind = "helper", code =
         "make_csx_spearman_hm <- function(x) { inner <- function(y) y + 1; inner(x) }"))
   for (item in proposals)
   {
      refusal <- aut_queue(item$code)
      expect_identical(refusal$status, "error", info = item$name)
      expect_match(refusal$message, "existing original data", info = item$name)
      authorization <- aut_get(".rs.rai.authorizeDerivedBinding")(item$name, item$kind)
      expect_identical(authorization$status, "authorized", info = authorization$message)
      expect_length(fx$events$items, 0L)
      snapshot <- aut_get(".rs.rai.globalSnapshot")()
      expect_true(aut_get(".rs.rai.authorizedExisting")(item$name, snapshot))
      if (!identical(authorization$status, "authorized")) next
      # New authorization does not revive an already-refused run proposal.
      expect_identical(aut_queue(item$code)$message,
                       "approval request failed; submit a fresh proposal")
      queued <- aut_queue(item$code, id = paste0("fresh-rebind-", item$name))
      expect_identical(queued$status, "queued", info = item$name)
      settled <- aut_execute(queued$run_id)
      expect_identical(settled$status, "ok", info = item$name)
      expect_true(item$name %in% unlist(settled$data_effects$bindings_rebound_authorized))
      expect_false(unclass(settled$data_effects$original_data_changed_observed),
                   info = paste(item$name, paste(unlist(settled$data_effects$originals_rebound), collapse = ","),
                                paste(unlist(settled$data_effects$originals_removed), collapse = ",")))
   }
   expect_identical(get("make_csx_spearman_hm", envir = globalenv())(2L), 3)
   expect_identical(get("forest.plots", envir = globalenv())[[1L]]$label, "new")
   expect_identical(get("sig4_dir", envir = globalenv()), "derived-plots-new")
   expect_identical(aut_queue("forest.plots[[1L]] <- NULL")$status, "error")
   expect_identical(aut_queue("forest.plots <- utils::read.csv('raw-input.csv')")$status, "error")
   expect_identical(aut_queue("rm(forest.plots)")$status, "error")
   expect_identical(aut_queue("sig4_dir <- '.Renviron'")$status, "error")
   expect_identical(aut_queue("sig4_dir <- '.env.local'")$status, "error")
   expect_identical(aut_queue("make_csx_spearman_hm <- function(x) get('system')('true')")$status, "error")
   safeNew <- aut_queue("rai_chunk_new_helper <- function(x) { inner <- function(y) y + 1; inner(x) }")
   expect_identical(safeNew$status, "queued")
   expect_identical(aut_execute(safeNew$run_id)$status, "ok")
   expect_identical(get("rai_chunk_new_helper", envir = globalenv())(2L), 3)
})

test_that("derived authorization fails closed for raw data, environment paths and stale identities", {
   fx <- aut_fixture()
   on.exit({
      names <- intersect(c("rai_chunk_raw", "rai_chunk_path", "rai_chunk_plot"),
                         ls(globalenv(), all.names = TRUE))
      if (length(names)) rm(list = names, envir = globalenv())
   }, add = TRUE)
   assign("rai_chunk_raw", data.frame(value = 1:3), envir = globalenv())
   assign("rai_chunk_path", ".Renviron", envir = globalenv())
   expect_identical(aut_get(".rs.rai.authorizeDerivedBinding")("rai_chunk_raw", "plots")$status,
                    "error")
   expect_identical(aut_get(".rs.rai.authorizeDerivedBinding")("rai_chunk_raw", "helper")$status,
                    "error")
   expect_identical(aut_get(".rs.rai.authorizeDerivedBinding")("rai_chunk_path", "path")$status,
                    "error")
   expect_length(fx$events$items, 0L)
   plot <- structure(list(label = "first"), class = "ggplot")
   assign("rai_chunk_plot", list(plot), envir = globalenv())
   # Seed a pre-migration manual request; migration must not settle it.
   target <- list(path = "rai_chunk_plot", domain = "derived-binding")
   identity <- aut_get(".rs.rai.globalSnapshot")()$identities[[
      match("rai_chunk_plot", aut_get(".rs.rai.globalSnapshot")()$names)]]
   status <- aut_get(".rs.rai.requestApproval")("authorize_derived", "legacy derived request",
      target, digestPayload = paste("rai_chunk_plot", "plots", identity, sep = "\r"),
      derivedAuthorization = list(name = "rai_chunk_plot", kind = "plots", identity = identity))
   pending <- list(status = "approval_required", message = status)
   expect_identical(pending$status, "approval_required")
   assign("rai_chunk_plot", list(structure(list(label = "changed"), class = "ggplot")),
          envir = globalenv())
   requestId <- sub("^approval_required: ", "", pending$message)
   stale <- aut_get(".rs.rai.recordGrant")(requestId, "allow", "once")
   expect_identical(stale$status, "error")
   expect_match(stale$message, "binding changed")
   expect_identical(aut_queue("rai_chunk_plot <- list()")$status, "error")
   # A fresh request after the stale refusal still works; no replay or hidden run.
   identity <- aut_get(".rs.rai.globalSnapshot")()$identities[[
      match("rai_chunk_plot", aut_get(".rs.rai.globalSnapshot")()$names)]]
   status <- aut_get(".rs.rai.requestApproval")("authorize_derived", "fresh legacy test request",
      target, digestPayload = paste("rai_chunk_plot", "plots", identity, sep = "\r"),
      derivedAuthorization = list(name = "rai_chunk_plot", kind = "plots", identity = identity))
   fresh <- list(status = "approval_required", message = status)
   expect_identical(fresh$status, "approval_required")
   expect_length(fx$events$items, 2L)
   expect_identical(aut_get(".rs.rai.recordGrant")(
      sub("^approval_required: ", "", fresh$message), "decline", "once")$status, "declined")
   expect_identical(aut_queue("rai_chunk_plot <- list()")$status, "error")
})

test_that("derived designation never forces active bindings or promises", {
   fx <- aut_fixture()
   counter <- 0L
   makeActiveBinding("rai_chunk_active", function(value) { counter <<- counter + 1L; 1L },
                     env = globalenv())
   delayedAssign("rai_chunk_promise", { counter <<- counter + 1L; 1L },
                 assign.env = globalenv())
   on.exit(rm(list = c("rai_chunk_active", "rai_chunk_promise"), envir = globalenv()), add = TRUE)
   aut_set(".rs.rai.globalSnapshot", function()
      list(names = c("rai_chunk_active", "rai_chunk_promise"),
           identities = c("active_binding:", "promise:opaque"), complete = TRUE))
   expect_identical(aut_get(".rs.rai.authorizeDerivedBinding")("rai_chunk_active", "path")$status,
                    "error")
   expect_identical(aut_get(".rs.rai.authorizeDerivedBinding")("rai_chunk_promise", "path")$status,
                    "error")
   expect_identical(counter, 0L)
   expect_length(fx$events$items, 0L)
})

test_that("nested helper bodies reject dynamic lookup and superassignment without blanket function ban", {
   fx <- aut_fixture()
   unsafe <- c(
      "rai_chunk_fn <- function(x) { inner <- function() get('system')('true'); inner() }",
      "rai_chunk_fn <- function(x) { inner <- function() .Call('hidden'); inner() }",
      "rai_chunk_fn <- function(x) { inner <- function() x <<- 0; inner() }",
      "rai_chunk_fn <- function(x = system('true')) x",
      "rai_chunk_fn <- function(x) { inner <- function(y = system('true')) y; inner() }",
      "rai_chunk_fn <- function(x) { inner <- function() base:::eval(x); inner() }")
   for (code in unsafe)
      expect_identical(aut_queue(code)$status, "error", info = code)
   expect_length(fx$events$items, 0L)
   safe <- aut_queue("rai_chunk_fn <- function(x) { inner <- function(y) y + 1; inner(x) }")
   expect_identical(safe$status, "queued")
   expect_identical(aut_execute(safe$run_id)$status, "ok")
   on.exit(if (exists("rai_chunk_fn", envir = globalenv(), inherits = FALSE))
      rm("rai_chunk_fn", envir = globalenv()), add = TRUE)
})

test_that("an existing workspace closure cannot hide mutation behind an innocent call", {
   fx <- aut_fixture()
   assign("rai_chunk_unsafe_callee", function() { .GlobalEnv$rai_chunk_raw <- 0L },
          envir = globalenv())
   assign("rai_chunk_bad_default", function(x = system("true")) x,
          envir = globalenv())
   on.exit({
      names <- intersect(c("rai_chunk_unsafe_callee", "rai_chunk_bad_default",
                           "rai_chunk_safe_callee", "rai_chunk_out"),
                         ls(globalenv(), all.names = TRUE))
      if (length(names)) rm(list = names, envir = globalenv())
   }, add = TRUE)
   snapshot <- aut_get(".rs.rai.globalSnapshot")()
   expect_true("rai_chunk_unsafe_callee" %in% snapshot$names)
   expect_true(aut_get(".rs.rai.isProtectedOriginal")("rai_chunk_unsafe_callee", snapshot))
   guard <- aut_get(".rs.rai.dataGuard")(
      parse(text = "rai_chunk_out <- rai_chunk_unsafe_callee()")[[1L]], snapshot)
   expect_false(guard$ok, info = paste(guard$reason, collapse = "; "))
   refused <- aut_queue("rai_chunk_out <- rai_chunk_unsafe_callee()")
   expect_identical(refused$status, "error")
   expect_match(refused$message, "workspace callee")
   authorization <- aut_get(".rs.rai.authorizeDerivedBinding")("rai_chunk_bad_default", "helper")
   expect_identical(authorization$status, "authorized")
   expect_identical(aut_queue("rai_chunk_out <- rai_chunk_bad_default()")$status, "error")
   safe <- aut_queue("rai_chunk_safe_callee <- function(x = 2L) x + 1")
   expect_identical(safe$status, "queued")
   expect_identical(aut_execute(safe$run_id)$status, "ok")
   call <- aut_queue("rai_chunk_out <- rai_chunk_safe_callee()")
   expect_identical(call$status, "queued")
   expect_identical(aut_execute(call$run_id)$status, "ok")
   expect_identical(get("rai_chunk_out", envir = globalenv()), 3)
   expect_length(fx$events$items, 0L) # designation never emits a consent card
})

test_that("reader provenance survives transparent wrappers and protects loaded originals", {
   fx <- aut_fixture()
   input <- file.path(fx$dir, "wrapped-original.csv")
   original <- data.frame(value = c(3L, 5L, 7L))
   utils::write.csv(original, input, row.names = FALSE)
   input_hash <- digest::digest(file = input, algo = "sha256")
   code <- paste0("rai_fx_wrapped <- identity(utils::read.csv(", deparse(input), "))")
   queued <- aut_queue(code)
   expect_identical(queued$status, "queued")
   expect_identical(aut_execute(queued$run_id)$status, "ok")
   loaded <- get("rai_fx_wrapped", envir = globalenv())
   expect_identical(loaded, original)
   refused <- aut_queue("rai_fx_wrapped$value <- 0L")
   expect_identical(refused$status, "error")
   expect_false(identical(refused$status, "approval_required"))
   expect_identical(get("rai_fx_wrapped", envir = globalenv()), original)
   expect_identical(digest::digest(file = input, algo = "sha256"), input_hash)
   expect_length(fx$events$items, 0L)
   expect_length(Filter(function(r) identical(r$event, "run_refused"),
                        aut_trace_records(fx)), 1L)
})

test_that("retry of a completed proposal reads its run without bypassing original protection", {
   fx <- aut_fixture()
   input <- file.path(fx$dir, "retry-original.csv")
   writeLines(c("value", "42"), input)
   code <- paste0("rai_fx_retry <- utils::read.csv(", deparse(input), ")")
   first <- aut_queue(code, "p-retry-once")
   expect_identical(first$status, "queued")
   done <- aut_execute(first$run_id)
   expect_identical(done$status, "ok")
   # The first run has created a binding. Its retry is readback, never a
   # second enqueue, and a different proposal may not rebind the new original.
   again <- aut_queue(code, "p-retry-once")
   expect_identical(again$status, "ok")
   expect_identical(again$run_id, first$run_id)
   expect_identical(again$enqueue, "no")
   expect_identical(aut_queue("rai_fx_retry <- 43L", "p-retry-once")$status, "error")
   expect_identical(aut_queue(code, "p-new-rebind")$status, "error")
   events <- aut_trace_records(fx)
   expect_length(Filter(function(record) identical(record$event, "run_queued"), events), 1L)
   expect_length(Filter(function(record) identical(record$event, "run_completed"), events), 1L)
})

test_that("every run has a durable exact-code trace linked to its result", {
   fx <- aut_fixture()
   code <- "rai_fx_trace <- sum(1:10)"
   queued <- aut_queue(code, "p-trace")
   result <- aut_execute(queued$run_id)

   records <- aut_trace_records(fx)
   q <- Filter(function(r) identical(r$event, "run_queued"), records)
   done <- Filter(function(r) identical(r$event, "run_completed"), records)
   expect_length(q, 1L)
   expect_length(done, 1L)
   expect_identical(q[[1L]]$code, code)
   expect_identical(q[[1L]]$run_id, queued$run_id)
   expect_identical(q[[1L]]$proposal_id, "p-trace")
   expect_identical(q[[1L]]$code_hash, digest::digest(code, algo = "sha256", serialize = FALSE))
   expect_identical(q[[1L]]$approval, "autonomous")
   expect_identical(done[[1L]]$run_id, queued$run_id)
   expect_identical(done[[1L]]$queued_seq, q[[1L]]$seq)
   expect_identical(done[[1L]]$status, "ok")
   expect_gt(done[[1L]]$seq, q[[1L]]$seq)

   expect_identical(result$trace$queued_seq, q[[1L]]$seq)
   expect_identical(result$trace$completed_seq, done[[1L]]$seq)
   expect_true(file.exists(result$trace$file))
   expect_identical(unname(file.info(result$trace$file)$mode & as.octmode("077")), as.octmode("0"))
})

test_that("a run whose trace cannot be written is refused and never queued", {
   fx <- aut_fixture()
   blocker <- file.path(fx$dir, "not-a-directory")
   writeLines("x", blocker)
   aut_get(".rs.rai.setTraceDir")(file.path(blocker, "trace"))

   expect_warning(result <- aut_queue("rai_fx_untraced <- 1"), "Not a directory")
   expect_identical(result$status, "error")
   expect_match(result$message, "trace could not be written")
   expect_length(ls(aut_get(".rs.rai.runState")$records, all.names = TRUE), 0L)
   expect_false(exists("rai_fx_untraced", envir = globalenv()))
})

test_that("without native binding identity every existing binding stays protected (fail closed)", {
   fx <- aut_fixture(identity = FALSE)
   aut_set(".rs.rai.globalSnapshot", function()
   {
      names <- sort(ls(globalenv(), all.names = TRUE))
      list(names = names, identities = rep(NA_character_, length(names)), complete = FALSE)
   })
   first <- aut_queue("rai_fx_first <- 1")
   expect_identical(first$status, "queued")
   aut_execute(first$run_id)
   # identity unknown: even the Assistant's own binding cannot be proven derived
   expect_identical(aut_queue("rai_fx_first <- 2")$status, "error")
})

test_that("the static policy is honest about what it cannot see", {
   guard <- aut_get(".rs.rai.dataGuard")
   snapshot <- list(names = character(0), identities = character(0), complete = TRUE)
   # A computed destination or computed code is refused rather than guessed at.
   expect_false(guard(quote(write.csv(x, paste0(dir, "/out.csv"))), snapshot)$ok)
   expect_false(guard(quote(eval(parse(text = code))), snapshot)$ok)
   assign("rai_fx_fn", function() NULL, envir = globalenv())
   on.exit(rm("rai_fx_fn", envir = globalenv()), add = TRUE)
   expect_false(guard(quote(do.call(rai_fx_fn, list())), snapshot)$ok)
   expect_false(guard(quote(do.call(fn_that_does_not_exist, list())), snapshot)$ok)
   # an inspectable base callee remains usable
   expect_true(guard(quote(rai_fx_bound <- do.call(rbind, list(1, 2))), snapshot)$ok)
   # Documented limit: the module states lineage is observed evidence only.
   module <- readLines(file.path(.rs.sessionModulePath(), "SessionRaiAssistant.R"))
   expect_true(any(grepl("It is not, and is never reported as, proof of immutability", module, fixed = TRUE)))
})

test_that("a binding created by reading an original file is itself protected original data (confirmed defect)", {
   # Regression for the confirmed 0.1.57 QA defect: `rai_e2e_orig <- utils::read.csv(...)`
   # loads the ORIGINAL file's content into a brand-new binding. That binding
   # must be treated as original data from that point on -- NOT as
   # Assistant-derived -- so a later run cannot rebind/mutate it directly
   # (`rai_e2e_orig$v <- 0`) and pass the original-data guard. Before the fix
   # this run was accepted (status "ok", approval "autonomous", trace
   # run_queued/run_completed, `rai_e2e_orig` recorded in
   # bindings_rebound_derived) and the original's later read-back no longer
   # matched the source file (sum 0 instead of 12).
   fx <- aut_fixture()
   input <- file.path(fx$dir, "input.csv")
   utils::write.csv(data.frame(g = c(1, 1, 2), v = c(2, 4, 6)), input, row.names = FALSE)
   input_hash <- digest::digest(file = input, algo = "sha256")

   load_step <- paste0("rai_fx_e2e_orig <- utils::read.csv(", deparse(input), ")")
   summary_step <- "rai_fx_e2e_summary <- aggregate(v ~ g, data = rai_fx_e2e_orig, FUN = mean)"
   direct_mutation_step <- "rai_fx_e2e_orig$v <- 0"
   direct_index_mutation_step <- "rai_fx_e2e_orig[1, 'v'] <- 0"
   readback_step <- "sum(rai_fx_e2e_orig$v)"

   loaded <- aut_queue(load_step)
   expect_identical(loaded$status, "queued")
   loaded_result <- aut_execute(loaded$run_id)
   expect_identical(loaded_result$status, "ok")
   expect_identical(unlist(loaded_result$data_effects$bindings_created), "rai_fx_e2e_orig")
   expect_length(loaded_result$data_effects$bindings_rebound_derived, 0L)

   summarized <- aut_queue(summary_step)
   expect_identical(summarized$status, "queued")
   aut_execute(summarized$run_id)

   # `$<-` direct mutation of the reader-loaded original: refused outright,
   # never a card, never queued, never traced as run_queued/run_completed.
   direct <- aut_queue(direct_mutation_step)
   expect_identical(direct$status, "error")
   expect_match(direct$message, "existing original data")
   expect_null(direct$run_id)

   # `[<-` indexed direct mutation of the same original: also refused.
   direct_index <- aut_queue(direct_index_mutation_step)
   expect_identical(direct_index$status, "error")
   expect_match(direct_index$message, "existing original data")
   expect_null(direct_index$run_id)

   # the original in the workspace and on disk is unchanged
   readback <- aut_queue(readback_step, "p-readback")
   expect_identical(readback$status, "queued")
   result <- aut_execute(readback$run_id)
   expect_identical(trimws(result$stdout), "[1] 12")
   expect_identical(digest::digest(file = input, algo = "sha256"), input_hash)

   # both refusals are traced as run_refused, never run_queued/run_completed
   records <- aut_trace_records(fx)
   refused <- Filter(function(r) identical(r$event, "run_refused"), records)
   expect_true(any(vapply(refused, function(r) identical(r$code, direct_mutation_step), logical(1L))))
   expect_true(any(vapply(refused, function(r) identical(r$code, direct_index_mutation_step), logical(1L))))
   queued_codes <- vapply(Filter(function(r) identical(r$event, "run_queued"), records),
                          function(r) r$code, character(1L))
   expect_false(direct_mutation_step %in% queued_codes)
   expect_false(direct_index_mutation_step %in% queued_codes)
})

test_that(".rs.rai.peekDocumentEditStatus is registered in .rs.toolsEnv() (confirmed packaged defect)", {
   # Regression for a confirmed packaged-runtime defect: the R-level tests in
   # this file call the peek function via aut_get() (which reads directly from
   # this test file's own sourcing environment), so they exercised the
   # function's LOGIC correctly but never exercised how the live app actually
   # reaches it. The C++ side (handleDocumentEditRequest in
   # SessionRaiAssistant.cpp) calls it exclusively via
   # r::exec::RFunction(".rs.rai.peekDocumentEditStatus", ...), which resolves
   # names through .rs.toolsEnv() -- exactly like its sibling
   # .rs.rai.queueDocumentEdit, which IS assign()'d there a few lines below in
   # the source. peekDocumentEditStatus's own assign() call was missing, so
   # every packaged poll-after-apply hit a real R "could not find function"
   # error instead of ever reaching this function's cache-hit logic -- this is
   # the confirmed live symptom "object '.rs.rai.peekDocumentEditStatus' not
   # found" from the packaged desktop run. A pure aut_get()-based unit test
   # cannot catch a missing toolsEnv() registration, because aut_get() doesn't
   # go through toolsEnv() at all; this test asserts the registration directly.
   toolsEnv <- .rs.toolsEnv()
   expect_true(exists(".rs.rai.peekDocumentEditStatus", envir = toolsEnv, inherits = FALSE))
   expect_true(is.function(get(".rs.rai.peekDocumentEditStatus", envir = toolsEnv, inherits = FALSE)))
   # Same check for its sibling, so a future refactor that accidentally drops
   # queueDocumentEdit's own assign() is caught the same way.
   expect_true(exists(".rs.rai.queueDocumentEdit", envir = toolsEnv, inherits = FALSE))
})

# Policy-only reproductions: never execute the protected proposal text.
test_that("direct original alias cannot enable in-place mutation", {
   snapshot <- list(names = "rai_fx_alias_original", identities = "value:fixture-original", complete = TRUE)
   guard <- aut_get(".rs.rai.dataGuard")
   expect_false(guard(quote({ rai_fx_alias <- rai_fx_alias_original; rai_fx_alias$value <- 99L }), snapshot)$ok)
   expect_true(guard(quote({ rai_fx_alias <- rai_fx_alias_original; rai_fx_alias }), snapshot)$ok)
   expect_true(guard(quote({ rai_fx_fresh <- data.frame(value = 1L); rai_fx_alias <- rai_fx_fresh; rai_fx_alias$value <- 3L }), snapshot)$ok)
   expect_true(guard(quote(mean(c(1L, 2L))), snapshot)$ok)
   expect_true(guard(quote(base::mean(c(1L, 2L))), snapshot)$ok)
})

test_that("missing completion trace reports terminal error rather than success", {
   oldTrace <- aut_get(".rs.rai.appendTrace")
   withr::defer(aut_set(".rs.rai.appendTrace", oldTrace))
   aut_set(".rs.rai.appendTrace", function(...) NULL)
   record <- list(run_id = "inert-run", proposal_id = "inert-proposal", status = "ok",
      trace_queued = list(file = "inert.jsonl", seq = 1L), elapsed_ms = 0)
   settle <- aut_get(".rs.rai.traceRunCompletion")
   failed <- settle(record, FALSE)
   expect_identical(failed$status, "error")
   expect_match(failed$error, "trace")
   expect_identical(failed$trace_completed$error, "trace write failed")
   record$status <- "error"
   record$error <- "original R error"
   expect_match(settle(record, FALSE)$error, "original R error", fixed = TRUE)
   aut_set(".rs.rai.appendTrace", function(...) list(file = "inert.jsonl", seq = 2L))
   record$status <- "ok"
   record$error <- NULL
   expect_identical(settle(record, FALSE)$status, "ok")
   aut_set(".rs.rai.appendTrace", function(...) stop("duplicate completion append"))
   expect_identical(settle(failed, FALSE), failed)
})


test_that("native policy lookup failures refuse Console proposals without cards or recovery replay", {
   lookup <- aut_get(".rs.rai.autoApproveReadOnlyEnabled")
   fx <- aut_fixture()
   native <- new.env(parent = environment(lookup))
   environment(lookup) <- native
   aut_set(".rs.rai.autoApproveReadOnlyEnabled", lookup)
   failures <- list(function(...) stop("private native failure"), function(...) FALSE,
                    function(...) NULL, function(...) "true", function(...) c(TRUE, TRUE),
                    function(...) NA)
   for (i in seq_along(failures)) {
      native$.Call <- failures[[i]]
      refused <- aut_queue("1 + 1", id = paste0("lookup-refused-", i))
      expect_identical(refused$status, "error")
      expect_match(refused$message, "automatic approval unavailable", fixed = TRUE)
      expect_length(ls(aut_get(".rs.rai.runState")$records, all.names = TRUE), 0L)
   }
   expect_length(fx$events$items, 0L)
   requests <- as.list(aut_get(".rs.rai.grantState")$requests)
   expect_true(all(vapply(requests, function(x) identical(x$decision, "failed"), logical(1L))))
   native$.Call <- function(...) TRUE
   retry <- aut_queue("1 + 1", id = "lookup-refused-1")
   expect_identical(retry$status, "error")
   expect_match(retry$message, "fresh proposal", fixed = TRUE)
   expect_identical(aut_queue("1 + 1", id = "lookup-recovered-fresh")$status, "queued")
   expect_length(fx$events$items, 0L)
})


test_that("late native policy lookup failure discards registration and spends the proposal", {
   lookup <- aut_get(".rs.rai.autoApproveReadOnlyEnabled")
   fx <- aut_fixture()
   native <- new.env(parent = environment(lookup))
   environment(lookup) <- native
   calls <- 0L
   native$.Call <- function(...) {
      calls <<- calls + 1L
      if (calls == 2L) stop("private late failure")
      TRUE
   }
   aut_set(".rs.rai.autoApproveReadOnlyEnabled", lookup)
   refused <- tryCatch(aut_queue("1 + 1", id = "late-lookup-refused"),
      error = function(error) list(status = "uncaught", message = conditionMessage(error)))
   expect_identical(refused$status, "error")
   expect_match(refused$message, "automatic approval unavailable", fixed = TRUE)
   expect_length(ls(aut_get(".rs.rai.runState")$records, all.names = TRUE), 0L)
   expect_length(fx$events$items, 0L)
   expect_identical(aut_queue("1 + 1", id = "late-lookup-refused")$status, "error")
   expect_identical(aut_queue("1 + 1", id = "late-lookup-fresh")$status, "queued")
})


test_that("native policy lookup failure refuses an editor proposal without emitting a card", {
   lookup <- aut_get(".rs.rai.autoApproveReadOnlyEnabled")
   old_documents <- aut_get(".rs.rai.listOpenDocuments")
   on.exit(aut_set(".rs.rai.listOpenDocuments", old_documents), add = TRUE)
   fx <- aut_fixture()
   aut_read_document_fixture("doc-unavailable", "x <- 1")
   native <- new.env(parent = environment(lookup))
   environment(lookup) <- native
   native$.Call <- function(...) stop("private native failure")
   aut_set(".rs.rai.autoApproveReadOnlyEnabled", lookup)
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents(id = "doc-unavailable"))
   refused <- tryCatch(aut_get(".rs.rai.queueDocumentEdit")("doc-unavailable", "x <- 1", "x <- 2"),
      error = function(error) list(status = "uncaught", message = conditionMessage(error)))
   expect_identical(refused$status, "error")
   expect_match(refused$message, "automatic approval unavailable", fixed = TRUE)
   expect_length(fx$events$items, 0L)
   native$.Call <- function(...) TRUE
   retry <- aut_get(".rs.rai.queueDocumentEdit")("doc-unavailable", "x <- 1", "x <- 2")
   expect_identical(retry$status, "error")
   expect_length(fx$events$items, 0L)
   fresh <- aut_get(".rs.rai.queueDocumentEdit")("doc-unavailable", "x <- 1", "x <- 3")
   expect_identical(fresh$status, "applying")
   expect_length(fx$events$items, 1L)
   expect_true(fx$events$items[[1L]]$data$auto_approve)
})


test_that("lookup failure leaves legacy editor decisions and in-flight requests unchanged", {
   lookup <- aut_get(".rs.rai.autoApproveReadOnlyEnabled")
   old_documents <- aut_get(".rs.rai.listOpenDocuments")
   on.exit(aut_set(".rs.rai.listOpenDocuments", old_documents), add = TRUE)
   fx <- aut_fixture()
   aut_read_document_fixture("doc-legacy-lookup", "x <- 1")
   native <- new.env(parent = environment(lookup))
   environment(lookup) <- native
   native$.Call <- function(...) stop("private native failure")
   aut_set(".rs.rai.autoApproveReadOnlyEnabled", lookup)
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents(id = "doc-legacy-lookup"))
   target <- aut_get(".rs.rai.canonicalTarget")("edit_document", "doc-legacy-lookup")
   key <- aut_get(".rs.rai.requestKey")("edit_document", target)
   state <- aut_get(".rs.rai.grantState")$requests
   digest <- aut_get(".rs.rai.proposalDigest")("edit_document", target,
      paste("x <- 1", "x <- 2", "", "", sep = "\037"))
   for (decision in list(NULL, "decline", "failed", "applying", "allow")) {
      request <- list(requestId = "legacy-lookup", tool = "edit_document", target = target,
                      digest = digest, decision = decision, auto_approve = FALSE,
                      created_at = Sys.time(), failure_reason = "prior refusal")
      assign(key, request, envir = state)
      before <- serialize(request, NULL)
      response <- aut_get(".rs.rai.queueDocumentEdit")("doc-legacy-lookup", "x <- 1", "x <- 2")
      expect_true(response$status %in% c("error", "applying", "applied"))
      expect_identical(serialize(get(key, envir = state), NULL), before)
      expect_length(fx$events$items, 0L)
   }
})


test_that("derived automatic policy preserves legacy decisions and pending request identity", {
   fx <- aut_fixture()
   name <- "rai_fx_derived_policy_legacy"
   stopifnot(!exists(name, envir = globalenv(), inherits = FALSE))
   assign(name, function(x) x, envir = globalenv())
   target <- list(path = name, domain = "derived-binding")
   snapshot <- aut_get(".rs.rai.globalSnapshot")()
   identity <- snapshot$identities[[match(name, snapshot$names)]]
   digest <- aut_get(".rs.rai.proposalDigest")("authorize_derived", target,
      paste(name, "helper", identity, sep = "\r"))
   key <- aut_get(".rs.rai.requestKey")("authorize_derived", target)
   state <- aut_get(".rs.rai.grantState")$requests
   for (decision in list(NULL, "decline", "failed", "applying", "expired", "allow")) {
      request <- list(requestId = "legacy-derived-id", tool = "authorize_derived", target = target,
         digest = digest, derived_authorization = list(name = name, kind = "helper", identity = identity),
         decision = decision, auto_approve = FALSE, created_at = Sys.time())
      assign(key, request, envir = state)
      before <- serialize(request, NULL)
      result <- aut_get(".rs.rai.authorizeDerivedBinding")(name, "helper")
      expect_identical(result$status, if (is.null(decision)) "approval_required" else "error")
      if (is.null(decision)) expect_identical(result$message, "approval_required: legacy-derived-id")
      expect_identical(serialize(get(key, envir = state), NULL), before)
      expect_false(aut_get(".rs.rai.authorizedExisting")(name, snapshot))
      expect_length(fx$events$items, 0L)
   }
})


test_that("derived lookup and trace failures stay terminal after recovery without a card", {
   fx <- aut_fixture()
   names <- c("rai_fx_derived_lookup_refusal", "rai_fx_derived_trace_refusal")
   stopifnot(!any(vapply(names, exists, logical(1L), envir = globalenv(), inherits = FALSE)))
   authorized <- aut_get(".rs.rai.dataState")$authorized
   old_trace <- aut_get(".rs.rai.appendTrace")
   on.exit({
      aut_set(".rs.rai.appendTrace", old_trace)
      owned <- intersect(names, ls(authorized, all.names = TRUE))
      if (length(owned)) rm(list = owned, envir = authorized)
   }, add = TRUE)
   for (i in seq_along(names)) {
      name <- names[[i]]
      assign(name, function(x) x, envir = globalenv())
      if (i == 1L) aut_set(".rs.rai.autoApproveReadOnlyEnabled", function() stop("lookup failed"))
      else aut_set(".rs.rai.appendTrace", function(...) NULL)
      refused <- aut_get(".rs.rai.authorizeDerivedBinding")(name, "helper")
      expect_identical(refused$status, "error")
      expect_false(aut_get(".rs.rai.authorizedExisting")(name, aut_get(".rs.rai.globalSnapshot")()))
      expect_length(fx$events$items, 0L)
      aut_set(".rs.rai.autoApproveReadOnlyEnabled", function() TRUE)
      aut_set(".rs.rai.appendTrace", old_trace)
      expect_identical(aut_get(".rs.rai.authorizeDerivedBinding")(name, "helper")$status, "error")
      assign(name, function(x) x + 2L, envir = globalenv())
      expect_identical(aut_get(".rs.rai.authorizeDerivedBinding")(name, "helper")$status, "authorized")
   }
   traces <- Filter(function(r) identical(r$event, "derived_binding_authorized"), aut_trace_records(fx))
   expect_length(traces, 2L)
   expect_true(all(vapply(traces, function(r) identical(r$approval, "autonomous"), logical(1L))))
   expect_length(fx$events$items, 0L)
})

test_that("automatic derived grant rechecks identity before authorization", {
   fx <- aut_fixture()
   name <- "rai_fx_derived_stale_at_grant"
   stopifnot(!exists(name, envir = globalenv(), inherits = FALSE))
   assign(name, function(x) x, envir = globalenv())
   snapshots <- 0L
   aut_set(".rs.rai.globalSnapshot", function() {
      snapshots <<- snapshots + 1L
      if (snapshots == 2L) assign(name, function(x) x + 1L, envir = globalenv())
      aut_snapshot_with_identity()
   })
   result <- aut_get(".rs.rai.authorizeDerivedBinding")(name, "helper")
   expect_identical(result$status, "error")
   expect_match(result$message, "binding changed", fixed = TRUE)
   expect_false(aut_get(".rs.rai.authorizedExisting")(name, aut_snapshot_with_identity()))
   expect_length(fx$events$items, 0L)
   expect_length(Filter(function(r) identical(r$event, "derived_binding_authorized"),
                        aut_trace_records(fx)), 0L)
})


test_that("S11 Full Auto native transaction writes the actual working file once", {
   fx <- aut_fixture()
   path <- file.path(fx$dir, "analysis.R")
   writeBin(charToRaw("x <- 1\n"), path)
   native <- function(action, id = "", payload = "")
      jsonlite::fromJSON(.Call("rs_raiDocumentEditFixture", action, id, payload))
   created <- native("create", payload = path)
   on.exit(native("remove", created$document_id), add = TRUE)
   aut_set(".rs.rai.listOpenDocuments", function() list(list(id = created$document_id, path = path, temp_name = NULL)))
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)
   aut_read_document_fixture(created$document_id, "x <- 1\n")
   queued <- aut_get(".rs.rai.queueDocumentEdit")(created$document_id, "x <- 1", "x <- 2")
   expect_identical(queued$status, "applying")
   prepared <- native("approve", queued$request_id)
   expect_identical(prepared$status, "applying")
   expect_identical(rawToChar(readBin(path, "raw", n = 100L)), "x <- 1\n")
   saved <- native("ack", queued$request_id, "x <- 2\n")
   expect_true(saved$saved)
   expect_identical(rawToChar(readBin(path, "raw", n = 100L)), "x <- 2\n")
   again <- native("ack", queued$request_id, "x <- 2\n")
   expect_identical(again, saved)
   peek <- aut_get(".rs.rai.peekDocumentEditStatus")(created$document_id, "x <- 1", "x <- 2")
   expect_true(peek$saved)
   expect_identical(peek$status, "applied")
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
   fix4_connection_cases(aut_get(".rs.rai.dataGuard"), list(names=character(), identities=list()), project)
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
 guard <- aut_get(".rs.rai.dataGuard")
 snapshot <- list(names=character(),identities=list())
 fix5_cases(guard,snapshot,p)
 inventory <- Sys.getenv("RAI_NAMESPACE_INVENTORY_TSV", unset = test_path("fixtures", "NAMESPACE-INVENTORY.tsv"))
 if (!nzchar(inventory)) inventory <- test_path("fixtures", "NAMESPACE-INVENTORY.tsv")
 expect_true(file.exists(inventory), info = inventory)
 fix5_inventory_cases(guard,snapshot,p,inventory)
})

test_that("S12 fix5 admits message, warning, try, unname and coef as in-memory calls", {
 p <- tempfile("fix5-named-");dir.create(p);on.exit(unlink(p,recursive=TRUE))
 guard <- aut_get(".rs.rai.dataGuard")
 snapshot <- list(names=character(),identities=list())
 for (key in c("base::message","base::warning","base::try","base::unname","stats::coef")) {
  parts <- strsplit(key,"::",fixed=TRUE)[[1L]]
  call <- as.call(list(as.call(list(as.name("::"),as.name(parts[1L]),as.name(parts[2L])))))
  expect_true(guard(call,snapshot,p)$ok,info=key)
 }
})
