#
# test-rai-hardening-0164.R
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

# Every fixture holds dummy values in a temporary directory, and no proposal is run outside it.

context("RAI Assistant hardening")

hd_snapshot <- function(...)
{
   names <- c(character(0), ...)
   list(names = names, identities = unname(vapply(names, function(name) paste0("value:", name), character(1L))),
        complete = TRUE)
}

hd_guard <- function(code, workingDir = tempdir(), snapshot = hd_snapshot())
   aut_get(".rs.rai.dataGuard")(parse(text = code)[[1L]], snapshot, workingDir)

hd_expect_refused <- function(code, reason, workingDir = tempdir(), snapshot = hd_snapshot())
{
   result <- hd_guard(code, workingDir, snapshot)
   expect_false(result$ok, info = code)
   if (!isTRUE(result$ok))
      expect_match(result$reason, reason, info = code)
}

hd_project <- function(env = parent.frame())
{
   root <- tempfile("rai-hardening-")
   dir.create(file.path(root, "raw"), recursive = TRUE)
   dir.create(file.path(root, "plots"))
   file.create(file.path(root, "plots", "old.png"))
   withr::defer(unlink(root, recursive = TRUE), envir = env)
   root
}

test_that("a named sep is a separator for paste only", {
   fold <- aut_get(".rs.rai.foldPath")
   expect_null(fold(quote(paste0("a", sep = "x", "b"))))
   expect_null(fold(quote(file.path("a", sep = "x", "b"))))
   expect_identical(fold(quote(paste("a", "b", sep = "-")))$path, "a-b")
   expect_identical(fold(quote(paste0("a", "b")))$path, "ab")
   expect_identical(fold(quote(file.path("a", "b")))$path, "a/b")
   hd_expect_refused("readLines(paste0('~/.a', 'ws/', sep = 'credentials'))", "not a literal inspectable path")
   hd_expect_refused("readLines(file.path('~', '.aws', sep = 'credentials'))", "not a literal inspectable path")
})

test_that("ggsave checks the path argument together with the filename", {
   skip_if_not_installed("ggplot2")
   loadNamespace("ggplot2")
   root <- hd_project()
   hd_expect_refused("ggplot2::ggsave('new.png', path = 'raw')", "protected data directory", root)
   hd_expect_refused("ggplot2::ggsave('old.png', path = 'plots')", "overwrite existing file", root)
   hd_expect_refused("ggplot2::ggsave('new.png', path = 'fresh', create.dir = TRUE)", "create.dir", root)
   expect_true(hd_guard("ggplot2::ggsave('new.png', path = 'plots')", root)$ok)
   expect_true(hd_guard("ggplot2::ggsave('new.png', path = 'plots', create.dir = TRUE)", root)$ok)
   expect_true(hd_guard("ggplot2::ggsave('new.png')", root)$ok)
})

test_that("third-party callees that run or load a file as code are refused", {
   for (code in c("rlang::eval_tidy(quote(1))", "rlang::exec('f')", "knitr::knit_child('a.Rmd')",
                  "rmarkdown::render_site()", "knitr::knit2pdf('a.Rnw')", "shiny::runApp('app')",
                  "shiny::runExample('01_hello')"))
      hd_expect_refused(code, "runs or loads a file as code")
   for (code in c("testthat::source_file('x.R')", "testthat::test_dir('tests')", "devtools::install_deps()",
                  "pkgload::load_code('.')", "testthat::test_file('t.R')", "testthat::test_local('.')",
                  "pkgload::run_script('x.R')"))
      hd_expect_refused(code, "R Console scope")
})

test_that("test runners and package build helpers are refused by qualified name", {
   for (code in c("testthat::test_check('pkg')", "devtools::test()", "devtools::check()",
                  "devtools::document()", "devtools::install()", "pkgload::load_all('.')",
                  "devtools::load_all('.')"))
      hd_expect_refused(code, "R Console scope")
})

test_that("compute functions whose names only start with a refused word are not refused", {
   for (package in c("TTR", "htmltools"))
      skip_if_not_installed(package)
   for (code in c("TTR::runMean(c(1, 2, 3, 4), 2)", "TTR::runSD(c(1, 2, 3, 4), 2)",
                  "htmltools::renderTags('a')"))
      expect_true(hd_guard(code)$ok, info = code)
})

test_that("documented third-party examples stay accepted", {
   for (package in c("limma", "DESeq2", "ggplot2"))
      skip_if_not_installed(package)
   for (code in c("limma::eBayes(fit)", "DESeq2::DESeq(dds)", "ggplot2::ggplot()"))
      expect_true(hd_guard(code)$ok, info = code)
})

test_that("writers that pass arguments to a shell are refused", {
   for (code in c("utils::zip('new.zip', 'a.txt', flags = '-r')", "utils::zip('new.zip', 'a.txt', extras = '-x')",
                  "utils::tar('new.tar', 'a.txt', extra_flags = '-v')",
                  "download.file('http://x/y', 'new.csv', method = 'curl')",
                  "download.file('http://x/y', 'new.csv', extra = '-o')"))
      hd_expect_refused(code, "command-line arguments reach the system shell")
   for (code in c("utils::zip('new.zip', 'a.txt')", "download.file('http://x/y', 'new.csv')",
                  "download.file('http://x/y', 'new.csv', method = 'libcurl')"))
      expect_true(hd_guard(code)$ok, info = code)
})

test_that("special files are neither read nor hashed", {
   for (code in c("utils::read.csv('/dev/zero')", "readLines('/dev/stdin')", "readRDS('/dev/null')"))
      hd_expect_refused(code, "protected environment, credential or system file")
   expect_true(aut_get(".rs.rai.isEnvironmentFile")("/proc/self/status", forRead = TRUE))
   fingerprint <- aut_get(".rs.rai.fileFingerprint")
   device <- fingerprint("/dev/null")
   expect_true(device$exists)
   expect_null(device$sha256)
   empty <- tempfile("rai-empty-")
   file.create(empty)
   on.exit(unlink(empty), add = TRUE)
   expect_null(fingerprint(empty)$sha256)
   writeLines("a", empty)
   expect_match(fingerprint(empty)$sha256, "^[a-f0-9]{64}$")
})

test_that("effects of a run keep the run record and use serializable file fingerprints", {
   fx <- aut_fixture()
   on.exit({
      owned <- intersect("rai_fx_dir", ls(globalenv(), all.names = TRUE))
      if (length(owned)) rm(list = owned, envir = globalenv())
   }, add = TRUE)
   assign("rai_fx_dir", file.path(fx$dir, "start"), envir = globalenv())
   authorization <- aut_get(".rs.rai.authorizeDerivedBinding")("rai_fx_dir", "path")
   expect_identical(authorization$status, "authorized", info = authorization$message)
   output <- file.path(fx$dir, "out.csv")
   queued <- aut_queue(sprintf("{ rai_fx_dir <- 'next'; utils::write.csv(data.frame(a = 1), '%s') }", output))
   expect_identical(queued$status, "queued", info = queued$message)
   settled <- aut_execute(queued$run_id)
   expect_identical(settled$status, "ok")
   expect_true("rai_fx_dir" %in% unlist(settled$data_effects$bindings_rebound_authorized))
   expect_length(settled$data_effects$output_files, 1L)

   never <- file.path(fx$dir, "never.csv")
   skipped <- aut_queue(sprintf("{ if (FALSE) utils::write.csv(data.frame(a = 1), '%s'); 1 }", never))
   expect_identical(skipped$status, "queued", info = skipped$message)
   outcome <- aut_execute(skipped$run_id)$data_effects$output_files[[1L]]
   expect_false(anyNA(names(outcome)))
   expect_identical(sort(names(outcome)), c("exists", "path"))
})

test_that("a file the run writes and reads back is not an unchanged-input violation", {
   fx <- aut_fixture()
   path <- file.path(fx$dir, "roundtrip.csv")
   queued <- aut_queue(sprintf("{ utils::write.csv(data.frame(a = 1), '%s'); utils::read.csv('%s') }", path, path))
   expect_identical(queued$status, "queued", info = queued$message)
   settled <- aut_execute(queued$run_id)
   expect_false(unclass(settled$data_effects$original_data_changed_observed))
})

test_that("a derived binding rebound from a reader becomes a protected original", {
   fx <- aut_fixture()
   input <- file.path(fx$dir, "in.csv")
   writeLines(c("a", "1", "2"), input)
   first <- aut_queue("rai_fx_tbl <- data.frame(a = 1)")
   expect_identical(first$status, "queued", info = first$message)
   aut_execute(first$run_id)
   second <- aut_queue(sprintf("rai_fx_tbl <- utils::read.csv('%s')", input))
   expect_identical(second$status, "queued", info = second$message)
   aut_execute(second$run_id)
   expect_true(aut_get(".rs.rai.isProtectedOriginal")("rai_fx_tbl", aut_get(".rs.rai.globalSnapshot")()))
   expect_identical(aut_queue("rai_fx_tbl$a <- 0")$status, "error")
})

test_that("a tainted run registers no derived binding", {
   fx <- aut_fixture()
   queued <- aut_queue("rai_fx_taint <- data.frame(a = 1)")
   expect_identical(queued$status, "queued", info = queued$message)
   record <- get(queued$run_id, envir = aut_get(".rs.rai.runState")$records, inherits = FALSE)
   eval(parse(text = record$code)[[1L]], envir = globalenv())
   aut_get(".rs.rai.recordConsoleCapture")(queued$run_id, stdout = "", conditionState = "non_error",
                                           tainted = TRUE, taintReason = "foreign console input")
   expect_false(exists("rai_fx_taint", envir = aut_get(".rs.rai.dataState")$derived, inherits = FALSE))
   expect_true(aut_get(".rs.rai.isProtectedOriginal")("rai_fx_taint", aut_get(".rs.rai.globalSnapshot")()))
})

test_that("the queued console text ends with the statement and keeps short lines", {
   fx <- aut_fixture()
   trimmed <- aut_queue("rai_fx_trim <- 1  # keep\n# trailing comment\n\n\n")
   expect_identical(trimmed$status, "queued", info = trimmed$message)
   expect_identical(trimmed$code, "rai_fx_trim <- 1  # keep")
   expect_identical(aut_queue("rai_fx_blank <- 2\n\n")$code, "rai_fx_blank <- 2")
   expect_identical(aut_queue("rai_fx_plain <- 3\n")$code, "rai_fx_plain <- 3\n")
   inner <- "{\n  # inside\n  rai_fx_inner <- 4\n}\n# after"
   expect_identical(aut_queue(inner)$code, "{\n  # inside\n  rai_fx_inner <- 4\n}")
   long <- aut_queue(paste0("rai_fx_long <- '", strrep("a", 4100L), "'"))
   expect_identical(long$status, "error")
   expect_match(long$message, "4000 bytes")
})

test_that("error and warning detail split at the first call separator", {
   detail <- aut_get(".rs.rai.parseErrorDetail")("Error in f(x) : bad value: 3\nsecond line")
   expect_identical(detail$call, "f(x)")
   expect_identical(detail$message, "bad value: 3\nsecond line")
   wrapped <- aut_get(".rs.rai.parseErrorDetail")("Error in f(x) : \n  long message: here")
   expect_identical(wrapped$call, "f(x)")
   expect_identical(wrapped$message, "long message: here")
   bare <- aut_get(".rs.rai.parseErrorDetail")("Error in f(x) :\n  other: text")
   expect_identical(bare$call, "f(x)")
   expect_identical(bare$message, "other: text")

   warnings <- aut_get(".rs.rai.parseWarnings")(
      "Warning message:\nIn mean.default(\"a\") : argument is not numeric: returning NA")
   expect_length(warnings, 1L)
   expect_identical(warnings[[1L]]$call, "mean.default(\"a\")")
   expect_identical(warnings[[1L]]$message, "argument is not numeric: returning NA")
   several <- aut_get(".rs.rai.parseWarnings")(
      "Warning messages:\n1: In f() :\n  first: one\n2: In g() : second: two")
   expect_length(several, 2L)
   expect_identical(several[[1L]]$call, "f()")
   expect_identical(several[[1L]]$message, "first: one")
   expect_identical(several[[2L]]$call, "g()")
   expect_identical(several[[2L]]$message, "second: two")
})

test_that("a failed or settled edit_document request is replayed only briefly", {
   fx <- aut_fixture()
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)
   edit <- aut_get(".rs.rai.queueDocumentEdit")
   peek <- aut_get(".rs.rai.peekDocumentEditStatus")
   age <- function(seconds)
   {
      requests <- aut_get(".rs.rai.grantState")$requests
      for (key in ls(requests, all.names = TRUE))
      {
         request <- get(key, envir = requests, inherits = FALSE)
         request$settled_at <- Sys.time() - seconds
         assign(key, request, envir = requests)
      }
   }

   queued <- edit("doc-auto", "x <- 1", "x <- 2")
   expect_identical(queued$status, "applying")
   expect_identical(edit("doc-auto", "x <- 1", "x <- 2")$request_id, queued$request_id)
   aut_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")
   failed <- aut_get(".rs.rai.completeDocumentEdit")(queued$request_id, FALSE, "buffer has unsaved edits")
   expect_identical(failed$status, "error")

   again <- edit("doc-auto", "x <- 1", "x <- 2")
   expect_identical(again$status, "error")
   expect_match(again$message, "unsaved edits")
   expect_identical(peek("doc-auto", "x <- 1", "x <- 2")$status, "error")

   age(60)
   expect_null(peek("doc-auto", "x <- 1", "x <- 2"))
   retry <- edit("doc-auto", "x <- 1", "x <- 2")
   expect_identical(retry$status, "applying")
   expect_false(identical(retry$request_id, queued$request_id))

   aut_get(".rs.rai.recordGrant")(retry$request_id, "allow", "once")
   expect_identical(aut_get(".rs.rai.completeDocumentEdit")(retry$request_id, TRUE)$status, "applied")
   expect_identical(edit("doc-auto", "x <- 1", "x <- 2")$status, "applied")
   age(60)
   expect_null(peek("doc-auto", "x <- 1", "x <- 2"))
   expect_identical(edit("doc-auto", "x <- 1", "x <- 2")$status, "applying")
})

test_that("a cached edit failure is ignored once the document read digest changed", {
   fx <- aut_fixture()
   aut_read_document_fixture("doc-auto", "x <- 1")
   aut_set(".rs.rai.listOpenDocuments", aut_open_documents())
   on.exit(aut_set(".rs.rai.listOpenDocuments", function() list()), add = TRUE)
   edit <- aut_get(".rs.rai.queueDocumentEdit")
   queued <- edit("doc-auto", "x <- 1", "x <- 2")
   aut_get(".rs.rai.recordGrant")(queued$request_id, "allow", "once")
   aut_get(".rs.rai.completeDocumentEdit")(queued$request_id, FALSE, "stale read")
   expect_identical(edit("doc-auto", "x <- 1", "x <- 2")$status, "error")

   aut_set(".rs.rai.documentReadDigest", function(documentId)
      digest::digest("changed", algo = "sha256", serialize = FALSE))
   expect_null(aut_get(".rs.rai.peekDocumentEditStatus")("doc-auto", "x <- 1", "x <- 2"))
   expect_identical(edit("doc-auto", "x <- 1", "x <- 2")$status, "applying")
})

test_that("method dispatch refusal considers only workspace functions", {
   fx <- aut_fixture()
   on.exit({
      owned <- intersect(c("mean.rai_fx_age", "mean.rai_fx_method"), ls(globalenv(), all.names = TRUE))
      if (length(owned)) rm(list = owned, envir = globalenv())
   }, add = TRUE)
   assign("mean.rai_fx_age", 30, envir = globalenv())
   expect_true(aut_get(".rs.rai.dataGuard")(quote(mean(c(1, 2))), aut_snapshot_with_identity())$ok)
   assign("mean.rai_fx_method", function(x, ...) 1, envir = globalenv())
   result <- aut_get(".rs.rai.dataGuard")(quote(mean(c(1, 2))), aut_snapshot_with_identity())
   expect_false(result$ok)
   expect_match(result$reason, "method dispatch")
})

test_that("assign family refuses environments given by partial or shifted argument names", {
   snapshot <- hd_snapshot("rai_fx_env")
   for (code in c("assign('a', 1, en = rai_fx_env)", "assign(x = 'a', 1, rai_fx_env)",
                  "delayedAssign('a', 1, assign.e = rai_fx_env)", "assign('a', 1, p = rai_fx_env)"))
      hd_expect_refused(code, "explicit environment", snapshot = snapshot)
   expect_true(hd_guard("assign('rai_fx_new', 1)", snapshot = snapshot)$ok)
})

test_that("session-safety flags calls and qualified names but not member names or targets", {
   unsafe <- aut_get(".rs.rai.consoleSessionUnsafe")
   for (code in c("df$q", "df$get", "q <- 0.05", "y ~ q", "lm(q ~ x)", "df@eval"))
      expect_false(unsafe(parse(text = code)[[1L]]), info = code)
   for (code in c("options(error = q)", "base::\"q\"()", "utils::head(base::\"quit\")", "sum(q < 0.05)",
                  "y ~ eval(parse(text = 'q()'))"))
      expect_true(unsafe(parse(text = code)[[1L]]), info = code)
})

test_that("trace numbers use a dot decimal mark whatever OutDec is", {
   old <- options(OutDec = ",")
   on.exit(options(old), add = TRUE)
   toJson <- aut_get(".rs.rai.toJson")
   expect_identical(toJson(list(elapsed_ms = 1.5)), "{\"elapsed_ms\":1.5}")
   expect_identical(toJson(list(elapsed_ms = Inf)), "{\"elapsed_ms\":null}")
})

test_that("captured output with invalid UTF-8 is repaired, and a failed capture settles the run", {
   fx <- aut_fixture()
   id <- aut_get(".rs.rai.registerRun")("1", 200L)
   aut_get(".rs.rai.recordConsoleCapture")(id, stdout = rawToChar(as.raw(c(0x68, 0xe9, 0x0a, 0x6f, 0x6b))),
                                           conditionState = "non_error")
   result <- aut_get(".rs.rai.getRunResult")(id)
   expect_identical(result$status, "ok")
   expect_identical(result$stdout, "h<e9>\nok")

   second <- aut_get(".rs.rai.registerRun")("2", 200L)
   original <- aut_get(".rs.rai.recordConsoleCaptureText")
   aut_set(".rs.rai.recordConsoleCaptureText", function(...) stop("capture failed"))
   on.exit(aut_set(".rs.rai.recordConsoleCaptureText", original), add = TRUE)
   aut_get(".rs.rai.recordConsoleCapture")(second, stdout = "2")
   settled <- aut_get(".rs.rai.getRunResult")(second)
   expect_identical(settled$status, "error")
   expect_match(settled$error, "could not be recorded")
})
