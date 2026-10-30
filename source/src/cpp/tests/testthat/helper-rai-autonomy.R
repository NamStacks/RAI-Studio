aut_env <- new.env(parent = as.environment("tools:rstudio"))
source(file.path(.rs.sessionModulePath(), "SessionRaiAssistant.R"), local = aut_env)

aut_get <- function(name) get(name, envir = aut_env, inherits = FALSE)
aut_set <- function(name, value) assign(name, value, envir = aut_env)

# Pre-fix1 RED modules have no digest wrapper and never call this shim
if (!exists(".rs.rai.documentReadDigest", envir = aut_env, inherits = FALSE))
   aut_set(".rs.rai.documentReadDigest", function(documentId) "")

# The native owner token is unavailable outside a bridge session; the fixtures model it with a test-only variable.
aut_set(".rs.rai.ownerToken", function() Sys.getenv("RAI_OWNER_TOKEN"))

# Stand-in for the native rs_raiGlobalBindingSnapshot (not available outside
# an rsession). Native identity is the bound object's address, so a reference
# object (environment) keeps its identity while its contents change; mirror
# that here -- environments by address, other fixture values by content.
# Fixtures hold no promises or active bindings, so reading them forces nothing.
aut_snapshot_with_identity <- function()
{
   names <- sort(ls(globalenv(), all.names = TRUE))
   identities <- vapply(names, function(name)
   {
      value <- get(name, envir = globalenv())
      if (is.environment(value)) paste0("value:", format(value))
      else if (is.function(value)) paste0("value:function:",
         digest::digest(list(formals(value), body(value))), ":", format(environment(value)))
      # Serializing a closure in the R test harness can warn that attached
      # package namespaces (e.g. stats) are unavailable on reload. Native
      # identity is an address and never serializes; discard only this fixture
      # identity probe's warning, not warnings from the RAI code under test.
      else paste0("value:", suppressWarnings(digest::digest(value)))
   }, character(1L))
   list(names = names, identities = unname(identities), complete = TRUE)
}

aut_fixture <- function(env = parent.frame(), autonomous = TRUE, identity = TRUE)
{
   old_owner <- Sys.getenv("RAI_OWNER_TOKEN", unset = NA_character_)
   Sys.setenv(RAI_OWNER_TOKEN = "rai-autonomy-owner")
   dir <- tempfile("rai-autonomy-")
   dir.create(dir)
   trace <- file.path(dir, "trace")
   aut_get(".rs.rai.setTraceDir")(trace)

   # Every fixture owns temporary snapshot replacement, including a test that
   # deliberately disables native identity. Restore even when identity=FALSE.
   saved <- list(".rs.rai.globalSnapshot" = aut_get(".rs.rai.globalSnapshot"))
   stub <- function(name, value)
   {
      saved[[name]] <<- aut_get(name)
      aut_set(name, value)
   }
   events <- new.env(parent = emptyenv())
   events$items <- list()
   stub(".rs.rai.autoApproveReadOnlyEnabled", function() autonomous)
   if (identity)
      stub(".rs.rai.globalSnapshot", aut_snapshot_with_identity)
   had_enqueue <- exists(".rs.enqueClientEvent", envir = aut_env, inherits = FALSE)
   aut_set(".rs.enqueClientEvent", function(type, data)
      events$items[[length(events$items) + 1L]] <- list(type = type, data = data))

   before_globals <- ls(globalenv(), all.names = TRUE)
   withr_defer <- function()
   {
      for (name in names(saved)) aut_set(name, saved[[name]])
      if (!had_enqueue) rm(".rs.enqueClientEvent", envir = aut_env)
      aut_get(".rs.rai.setTraceDir")(NULL)
      grants <- aut_get(".rs.rai.grantState")
      for (store in list(grants$requests, grants$once, grants$session))
         rm(list = ls(store, all.names = TRUE), envir = store)
      runs <- aut_get(".rs.rai.runState")
      rm(list = ls(runs$records, all.names = TRUE), envir = runs$records)
      derived <- aut_get(".rs.rai.dataState")$derived
      rm(list = ls(derived, all.names = TRUE), envir = derived)
      created <- setdiff(ls(globalenv(), all.names = TRUE), before_globals)
      rm(list = grep("^rai_fx_", created, value = TRUE), envir = globalenv())
      unlink(dir, recursive = TRUE)
      if (is.na(old_owner)) Sys.unsetenv("RAI_OWNER_TOKEN")
      else Sys.setenv(RAI_OWNER_TOKEN = old_owner)
   }
   withr::defer(withr_defer(), envir = env)
   list(dir = dir, trace = trace, events = events)
}

aut_trace_records <- function(fx)
{
   files <- list.files(fx$trace, "\\.jsonl$", full.names = TRUE)
   lines <- unlist(lapply(files, readLines, warn = FALSE))
   lapply(lines, jsonlite::fromJSON, simplifyVector = FALSE)
}

aut_open_documents <- function(path = "R/analysis.R", id = "doc-auto")
{
   force(path); force(id)
   function() list(list(id = id, path = path, temp_name = NULL))
}

# Simulates the native Console: evaluates the exact registered code at top
# level and records the capture exactly as the native module would.
aut_execute <- function(run_id)
{
   record <- get(run_id, envir = aut_get(".rs.rai.runState")$records, inherits = FALSE)
   output <- utils::capture.output(eval(parse(text = record$code)[[1L]], envir = globalenv()))
   aut_get(".rs.rai.recordConsoleCapture")(run_id, stdout = paste(output, collapse = "\n"),
                                           conditionState = "non_error")
   aut_get(".rs.rai.getRunResult")(run_id)
}

aut_queue <- function(code, id = paste0("p-", digest::digest(code)))
   aut_get(".rs.rai.queueConsoleRun")(id, code, 200L)


# Model completed native reads for the in-memory editor fixtures
# Real endpoint, registry, and remint checks live in S10fixSnippetNativeQueue/Apply
aut_read_document_fixture <- function(id, text, env = parent.frame())
{
   connection <- rawConnection(charToRaw(text))
   on.exit(close(connection))
   contents <- rawToChar(readBin(connection, "raw", n = nchar(text, type = "bytes") + 1L))
   stopifnot(identical(contents, text))
   previous <- aut_get(".rs.rai.documentReadDigest")
   aut_set(".rs.rai.documentReadDigest", function(documentId)
      if (identical(documentId, id)) digest::digest(contents, algo = "sha256", serialize = FALSE) else "")
   withr::defer(aut_set(".rs.rai.documentReadDigest", previous), envir = env)
   invisible(contents)
}
