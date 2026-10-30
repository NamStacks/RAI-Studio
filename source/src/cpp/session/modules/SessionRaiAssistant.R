#
# SessionRaiAssistant.R
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
#

.rs.rai.ownerToken <- function()
{
   token <- tryCatch(.Call("rs_raiOwnerToken", PACKAGE = "(embedding)"), error = function(error) "")
   if (is.character(token) && length(token) == 1L && !is.na(token)) token else ""
}

.rs.rai.stampOwner <- function()
{
   if (!nzchar(.rs.rai.ownerToken()))
      return(invisible(NULL))

   # This is a session-local native ownership marker only. It deliberately
   # does not register mcptools or any process-global R MCP session.
   options(rstudio.rai.ownerStamped = TRUE)
   invisible(NULL)
}

.rs.rai.grantState <- local({
   state <- new.env(parent = emptyenv())
   state$requests <- new.env(parent = emptyenv())
   state$once <- new.env(parent = emptyenv())
   state$session <- new.env(parent = emptyenv())
   state
})

# SessionRaiAssistant.R is sourced inside a throwaway local() scope
# (SourceManager::source), so this state must be re-homed into the shared
# tools:rstudio environment -- the same place .rs.addFunction below puts the
# functions that reference it -- or it becomes unreachable once that scope is
# garbage collected.
assign(".rs.rai.grantState", .rs.rai.grantState, envir = .rs.toolsEnv())

.rs.rai.targetForGrant <- function(target)
{
   if (is.character(target) && length(target) == 1L && !is.na(target))
      return(list(path = target, domain = "r"))

   if (!is.list(target))
      return(NULL)

   path <- target$path
   domain <- target$domain
   if (!is.character(path) || length(path) != 1L || is.na(path) ||
       !is.character(domain) || length(domain) != 1L || is.na(domain))
      return(NULL)

   list(path = path, domain = domain)
}

.rs.rai.canonicalTarget <- function(tool, target)
{
   if (identical(tool, "run_r") && is.null(target))
      return(list(path = "", domain = "r"))

   canonical <- .rs.rai.targetForGrant(target)
   if (is.null(canonical))
      return(NULL)

   # edit_document targets are an opaque document id supplied by the tool
   # caller -- untrusted input, not something the broker generated. Normalize
   # identity at this native-broker boundary by requiring the id to match a
   # currently open document (via the safe, in-memory source_database listing
   # -- no filesystem access) before it is ever used as authority for stored
   # request/grant matching. An id that isn't open right now is rejected
   # outright rather than falling back to the raw value, so a fabricated or
   # stale id can never acquire or match a grant.
   if (identical(tool, "edit_document") && !.rs.rai.isOpenDocumentId(canonical$path))
      return(NULL)

   canonical
}

.rs.rai.isOpenDocumentId <- function(id)
{
   if (!is.character(id) || length(id) != 1L || is.na(id) || !nzchar(id))
      return(FALSE)

   documents <- .rs.rai.listOpenDocuments()
   any(vapply(documents, function(document) identical(document$id, id), logical(1L)))
}

.rs.rai.targetDisplay <- function(tool, target)
{
   if (identical(target$domain, "r") && !nzchar(target$path))
      return("R Console")

   # target$path is often an opaque document id (e.g. edit_document's id),
   # not something meaningful to show a human. Resolve it against the safe,
   # already-open-document listing (no direct disk read) for a friendly
   # label; this is display-only and is never fed back into authorization.
   if (identical(tool, "edit_document") && nzchar(target$path))
   {
      documents <- .rs.rai.listOpenDocuments()
      matches <- Filter(function(document) identical(document$id, target$path), documents)
      if (length(matches))
      {
         label <- matches[[1L]]$path
         if (is.null(label) || !nzchar(label))
            label <- matches[[1L]]$temp_name
         if (!is.null(label) && nzchar(label))
            return(label)
      }
   }

   target$path
}

.rs.rai.grantMatches <- function(tool, target, grant)
{
   target <- .rs.rai.targetForGrant(target)
   if (!is.character(tool) || length(tool) != 1L || is.na(tool) ||
       is.null(target) || !is.list(grant))
      return(FALSE)

   grantTool <- grant$tool
   grantPath <- grant$path
   grantDomain <- grant$domain
   if (!is.character(grantTool) || length(grantTool) != 1L || is.na(grantTool) ||
       !is.character(grantPath) || length(grantPath) != 1L || is.na(grantPath) ||
       !is.character(grantDomain) || length(grantDomain) != 1L || is.na(grantDomain) ||
       !identical(tool, grantTool) || !identical(target$domain, grantDomain))
      return(FALSE)

   identical(tool, grantTool) && identical(target$domain, grantDomain) &&
      identical(target$path, grantPath)
}

.rs.rai.requestKey <- function(tool, target)
{
   paste(tool, target$domain, target$path, sep = "\r")
}

# Stable identity of one exact proposal. The proposal object that crosses the
# boundary is (language, target, code); language is always "R" and target is the
# canonical (domain, path) pair, so hashing tool + domain + path + code pins
# every field that can reach the Console.
#
# This exists because the request key above is deliberately coarse: every run_r
# proposal canonicalizes to the single {domain:"r", path:""} Console target, so
# tool/target alone cannot tell "20 + 22" apart from any other code string. An
# approval is granted for a proposal, not for a tool, and this digest is what
# makes that distinction representable.
.rs.rai.proposalDigest <- function(tool, target, code, maxLines = NULL)
{
   if (is.null(code))
      code <- ""
   if (!is.character(code) || length(code) != 1L || is.na(code) ||
       !is.list(target) || !is.character(tool) || length(tool) != 1L)
      return(NULL)

   payload <- paste("R", tool, target$domain, target$path, code,
                    if (is.null(maxLines)) "" else as.character(maxLines), sep = "\r")
   if (requireNamespace("digest", quietly = TRUE))
   {
      hashed <- tryCatch(
         digest::digest(payload, algo = "sha256", serialize = FALSE),
         error = function(error) NULL)
      if (is.character(hashed) && length(hashed) == 1L && !is.na(hashed))
         return(hashed)
   }

   # digest is not a hard dependency of the session. Without it the payload is
   # its own identity: it is only ever compared with identical() and never
   # displayed or persisted for run_r, so this is a bulkier binding, not a
   # weaker one.
   payload
}

# Exact source hash for read-only run correlation. Unlike proposalDigest this
# covers code alone; when digest is unavailable it is omitted rather than
# exposing source text as a monitor identifier.
.rs.rai.codeHash <- function(code)
{
   if (!is.character(code) || length(code) != 1L || is.na(code) ||
       !requireNamespace("digest", quietly = TRUE))
      return(NULL)
   hashed <- tryCatch(digest::digest(code, algo = "sha256", serialize = FALSE),
                      error = function(error) NULL)
   if (is.character(hashed) && length(hashed) == 1L && !is.na(hashed)) hashed else NULL
}

# A grant authorizes a proposal only if it matches the tool/target AND is either
# unbound (a standing "session"/"project" permission for that target) or bound to
# this exact proposal's digest (see .rs.rai.recordGrant).
.rs.rai.grantAuthorizes <- function(tool, target, grant, digest)
{
   if (!.rs.rai.grantMatches(tool, target, grant))
      return(FALSE)
   if (is.null(grant$digest))
      return(TRUE)
   is.character(digest) && length(digest) == 1L && !is.na(digest) &&
      identical(grant$digest, digest)
}

.rs.rai.chmodOwnerOnly <- function(path, mode)
{
   result <- Sys.chmod(path, mode = mode)
   isTRUE(result) || identical(result, 0L)
}

.rs.rai.userStateDir <- function(create = FALSE)
{
   home <- path.expand("~")
   if (!dir.exists(home))
      return(NULL)
   home <- normalizePath(home, winslash = "/", mustWork = TRUE)
   stateDir <- file.path(home, ".raistudio")
   if (!dir.exists(stateDir))
   {
      if (!isTRUE(create) || !dir.create(stateDir, recursive = FALSE, mode = "0700"))
         return(NULL)
   }
   if (nzchar(Sys.readlink(stateDir)))
      return(NULL)
   stateDir <- normalizePath(stateDir, winslash = "/", mustWork = TRUE)
   if (!startsWith(stateDir, paste0(home, "/")) ||
       !.rs.rai.chmodOwnerOnly(stateDir, "0700"))
      return(NULL)
   stateDir
}

.rs.rai.policySecret <- function()
{
   stateDir <- .rs.rai.userStateDir(create = TRUE)
   if (is.null(stateDir))
      return(NULL)

   path <- file.path(stateDir, "approval-policy.key")
   link <- Sys.readlink(path)
   if (length(link) == 1L && !is.na(link) && nzchar(link))
      return(NULL)
   if (file.exists(path))
   {
      if (!.rs.rai.chmodOwnerOnly(path, "0600"))
         return(NULL)
      secret <- tryCatch(readLines(path, warn = FALSE), error = function(error) NULL)
      if (length(secret) != 1L || !grepl("^[[:xdigit:]]{64}$", secret))
         return(NULL)
      return(secret)
   }

   secret <- tryCatch(system2("openssl", c("rand", "-hex", "32"), stdout = TRUE,
                              stderr = FALSE), error = function(error) NULL)
   if (length(secret) != 1L || !grepl("^[[:xdigit:]]{64}$", secret))
      return(NULL)

   temp <- tempfile(".approval-policy-", tmpdir = stateDir)
   on.exit(unlink(temp), add = TRUE)
   if (!isTRUE(file.create(temp)) || !.rs.rai.chmodOwnerOnly(temp, "0600") ||
       inherits(try(writeLines(secret, temp, useBytes = TRUE), silent = TRUE), "try-error") ||
       !isTRUE(file.rename(temp, path)) || !.rs.rai.chmodOwnerOnly(path, "0600"))
      return(NULL)
   secret
}

.rs.rai.policyPayload <- function(grants, projectRoot)
{
   tryCatch(jsonlite::toJSON(list(version = 1L, project_root = projectRoot,
                                  grants = grants), auto_unbox = TRUE),
            error = function(error) NULL)
}

.rs.rai.policyMac <- function(grants, projectRoot)
{
   if (!requireNamespace("digest", quietly = TRUE))
      return(NULL)
   secret <- .rs.rai.policySecret()
   contents <- .rs.rai.policyPayload(grants, projectRoot)
   if (is.null(secret) || is.null(contents))
      return(NULL)
   tryCatch(digest::hmac(secret, charToRaw(contents), algo = "sha256", serialize = FALSE),
            error = function(error) NULL)
}

.rs.rai.projectPolicyPath <- function(create = FALSE)
{
   if (!exists(".rs.getProjectDirectory", mode = "function"))
      return(NULL)

   project <- .rs.getProjectDirectory()
   if (!is.character(project) || length(project) != 1L || is.na(project) ||
       !nzchar(project) || !dir.exists(project))
      return(NULL)

   root <- normalizePath(project, winslash = "/", mustWork = TRUE)
   policyDir <- file.path(root, ".raistudio")
   if (!dir.exists(policyDir))
   {
      if (!isTRUE(create) || !dir.create(policyDir, recursive = FALSE,
                                          mode = "0700"))
         return(NULL)
   }
   if (nzchar(Sys.readlink(policyDir)))
      return(NULL)

   policyDir <- normalizePath(policyDir, winslash = "/", mustWork = TRUE)
   if (!startsWith(policyDir, paste0(root, "/")))
      return(NULL)

   if (!.rs.rai.chmodOwnerOnly(policyDir, "0700"))
      return(NULL)
   structure(file.path(policyDir, "policy.json"), projectRoot = root)
}

.rs.rai.readProjectGrants <- function()
{
   path <- .rs.rai.projectPolicyPath()
   projectRoot <- attr(path, "projectRoot")
   if (is.null(path) || !file.exists(path) ||
       (file.exists(path) && nzchar(Sys.readlink(path))) ||
       !requireNamespace("jsonlite", quietly = TRUE))
      return(list())

   policy <- tryCatch(jsonlite::fromJSON(path, simplifyVector = FALSE),
                      error = function(error) NULL)
   if (!is.list(policy) || !is.numeric(policy$version) || length(policy$version) != 1L ||
       policy$version != 1 || !is.list(policy$grants) ||
       !is.character(policy$mac) || length(policy$mac) != 1L || is.na(policy$mac) ||
       !identical(.rs.rai.policyMac(policy$grants, projectRoot), policy$mac))
      return(list())
   policy$grants
}

.rs.rai.writeProjectGrants <- function(grants)
{
   path <- .rs.rai.projectPolicyPath(create = TRUE)
   projectRoot <- attr(path, "projectRoot")
   if (is.null(path) || (file.exists(path) && nzchar(Sys.readlink(path))) ||
       !requireNamespace("jsonlite", quietly = TRUE))
      return(FALSE)

   mac <- .rs.rai.policyMac(grants, projectRoot)
   contents <- tryCatch(jsonlite::toJSON(list(version = 1L, grants = grants, mac = mac),
                                         auto_unbox = TRUE, pretty = TRUE),
                        error = function(error) NULL)
   if (is.null(mac) || is.null(contents))
      return(FALSE)

   temp <- tempfile(".policy-", tmpdir = dirname(path))
   on.exit(unlink(temp), add = TRUE)
   if (!isTRUE(file.create(temp)) || !.rs.rai.chmodOwnerOnly(temp, "0600"))
      return(FALSE)
   if (inherits(try(writeLines(contents, temp, useBytes = TRUE), silent = TRUE),
                "try-error"))
      return(FALSE)
   if (!isTRUE(file.rename(temp, path)))
      return(FALSE)
   .rs.rai.chmodOwnerOnly(path, "0600")
}

.rs.rai.requestApproval <- function(tool, reason, target, preview = NULL, diff = NULL,
                                    proposalId = NULL, maxLines = NULL, digestPayload = preview,
                                    documentEdit = NULL, autoApprove = FALSE,
                                    derivedAuthorization = NULL)
{
   target <- .rs.rai.canonicalTarget(tool, target)
   if (is.null(target))
      return("blocked: invalid approval target")

   digest <- .rs.rai.proposalDigest(tool, target, digestPayload, maxLines)
   state <- .rs.rai.grantState
   key <- if (identical(tool, "run_r")) paste0("proposal\r", proposalId) else
      .rs.rai.requestKey(tool, target)
   if (exists(key, envir = state$requests, inherits = FALSE))
   {
      request <- get(key, envir = state$requests, inherits = FALSE)

      # The provider may propose a different replacement while the first card
      # is still visible. Never revoke that card by overwriting its ID.
      if (identical(tool, "edit_document") && is.null(request$decision) &&
          .rs.rai.editorApprovalExpired(request))
      {
         request$decision <- "expired"
         assign(key, request, envir = state$requests)
      }
      if (identical(tool, "edit_document") && identical(request$decision, "applying"))
         return("blocked: document edit is already applying")
      if (identical(tool, "edit_document") && is.null(request$decision) &&
          !identical(request$digest, digest))
         return("blocked: another document edit is awaiting its exact approval")

      # A stored decision governs only the proposal it was actually made about.
      # Every run_r proposal shares one request key, so without this digest
      # check a decision about one code string would silently speak for every
      # later one: a decline would block the tool for the rest of the session,
      # and a still-pending request would hand its id to different code. An
      # identical re-proposal (the CLI retries the same call while it waits for
      # the user) must keep returning the same pending id rather than raise a
      # second approval card, which is why this compares rather than replaces.
      if (identical(request$digest, digest))
      {
         if (identical(request$decision, "decline"))
            return("blocked: approval declined")
         if (is.null(request$decision))
            return(paste0("approval_required: ", request$requestId))
      }
      rm(list = key, envir = state$requests)
   }

   requestId <- paste0("rai-", basename(tempfile()))
   request <- list(
      requestId = requestId,
      tool = tool,
      reason = reason,
      target = target,
      preview = preview,
      diff = diff,
      digest = digest,
      proposal_id = proposalId,
      max_lines = maxLines,
      document_edit = documentEdit,
      derived_authorization = derivedAuthorization,
      auto_approve = isTRUE(autoApprove),
      created_at = Sys.time(),
      decision = NULL
   )
   assign(key, request, envir = state$requests)

   if (exists(".rs.enqueClientEvent", mode = "function"))
   {
      # "rai_approval_request" maps to kRaiApprovalRequest=210 in SessionClientEvent.cpp.
      .rs.enqueClientEvent("rai_approval_request", list(
         request_id = requestId,
         tool = tool,
         reason = reason,
         target = .rs.rai.targetDisplay(tool, target),
         # The opaque id is only used by the native client to flush the already-open
         # editor's pending in-memory update before its own approval RPC.
         document_id = if (identical(tool, "edit_document")) target$path else "",
         preview = preview,
         diff = diff,
         auto_approve = isTRUE(autoApprove)
      ))
   }

   paste0("approval_required: ", requestId)
}


# Pending editor cards cannot confer authority indefinitely. Console approval
# and its independent auto-approval policy are deliberately unaffected.
.rs.rai.editorApprovalExpired <- function(request)
{
   identical(request$tool, "edit_document") &&
      (is.null(request$created_at) ||
       !inherits(request$created_at, "POSIXt") ||
       !isTRUE(as.numeric(difftime(Sys.time(), request$created_at, units = "secs")) < 600))
}

# Replay an existing approved console proposal from the persisted run record.
# The approval record only proves registration; it does not prove that native
# enqueue succeeded. A duplicate must therefore report the record's current
# state rather than claiming it is queued again.
.rs.rai.existingRunResponse <- function(request)
{
   result <- .rs.rai.getRunResult(request$run_id)
   if (identical(result$status, "pending"))
      return(list(status = "queued", run_id = request$run_id, code = request$preview,
                  digest = request$digest, proposal_id = request$proposal_id,
                  enqueue = "no"))

   status <- result$status
   if (status %in% c("error", "expired", "unknown"))
      status <- "error"

   message <- if (identical(result$status, "error")) result$error else result$message
   list(status = status, run_id = request$run_id, message = message, enqueue = "no")
}

.rs.rai.recordGrant <- function(requestId, decision, scope)
{
   if (!is.character(requestId) || length(requestId) != 1L || is.na(requestId) ||
       !is.character(decision) || length(decision) != 1L || is.na(decision) ||
       !is.character(scope) || length(scope) != 1L || is.na(scope))
      return(list(status = "error", message = "invalid approval decision"))

   state <- .rs.rai.grantState
   keys <- ls(state$requests, all.names = TRUE)
   requestKey <- keys[vapply(keys, function(key)
      identical(get(key, envir = state$requests, inherits = FALSE)$requestId, requestId),
      logical(1L))]
   if (length(requestKey) != 1L)
      return(list(status = "error", message = "unknown approval request"))

   request <- get(requestKey, envir = state$requests, inherits = FALSE)
   if (is.null(request$decision) && .rs.rai.editorApprovalExpired(request))
   {
      request$decision <- "expired"
      assign(requestKey, request, envir = state$requests)
      return(list(status = "error", message = "document approval expired; request a fresh edit"))
   }
   if (!is.null(request$decision))
   {
      if (identical(request$decision, "allow") && !is.null(request$run_id))
         return(.rs.rai.existingRunResponse(request))
      return(list(status = "error", message = "approval request already decided"))
   }

   if (identical(decision, "decline"))
   {
      request$decision <- "decline"
      assign(requestKey, request, envir = state$requests)
      return(list(status = "declined"))
   }

   if (!identical(decision, "allow") || !scope %in% c("once", "session", "project"))
      return(list(status = "error", message = "invalid approval grant"))

   isConsoleProposal <- identical(request$tool, "run_r") &&
      is.character(request$proposal_id) && length(request$proposal_id) == 1L &&
      !is.na(request$proposal_id) && nzchar(request$proposal_id)

   # A console proposal has exactly one canonical target (domain "r", empty
   # path -- see .rs.rai.canonicalTarget), so a standing "session"/"project"
   # grant for run_r is not a scoped permission at all: it authorizes every
   # future proposal, unattended, for the rest of the session or forever. That
   # directly breaches the product's approval-gated-execution guarantee. Only
   # "once", bound to this exact proposal's digest below, is available for
   # run_r; the UI must not offer the other two buttons for it either (see
   # RaiApprovalCard.java).
   if (isConsoleProposal && !identical(scope, "once"))
      return(list(status = "error", message = "run_r only supports a one-time approval"))

   if (identical(request$tool, "authorize_derived"))
   {
      if (!identical(scope, "once") || !is.list(request$derived_authorization))
         return(list(status = "error", message = "derived authorization requires an exact one-time approval"))
      pinned <- request$derived_authorization
      snapshot <- .rs.rai.globalSnapshot()
      index <- match(pinned$name, snapshot$names)
      if (!isTRUE(snapshot$complete) || is.na(index) ||
          !identical(snapshot$identities[[index]], pinned$identity) ||
          !startsWith(pinned$identity, "value:") ||
          !.rs.rai.allowedDerivedKind(get(pinned$name, envir = globalenv(), inherits = FALSE), pinned$kind))
      {
         request$decision <- "expired"
         assign(requestKey, request, envir = state$requests)
         return(list(status = "error", message = "derived binding changed or lost its verified type; submit a fresh binding proposal"))
      }
      link <- .rs.rai.appendTrace("derived_binding_authorized", list(
         name = pinned$name, kind = pinned$kind, identity = pinned$identity,
         request_id = requestId, approval = if (isTRUE(request$auto_approve))
            "autonomous" else "approved_once"))
      if (is.null(link))
         return(list(status = "error", message = "derived authorization trace unavailable"))
      assign(pinned$name, list(kind = pinned$kind, identity = pinned$identity),
             envir = .rs.rai.dataState$authorized)
      request$decision <- "allow"
      assign(requestKey, request, envir = state$requests)
      return(list(status = "granted", message = "derived binding authorized for safe plain rebinding"))
   }

   isDocumentEdit <- identical(request$tool, "edit_document") && is.list(request$document_edit) &&
      is.character(request$document_edit$expected) && length(request$document_edit$expected) == 1L &&
      is.character(request$document_edit$replacement) && length(request$document_edit$replacement) == 1L
   if (isDocumentEdit)
   {
      if (!identical(scope, "once"))
         return(list(status = "error", message = "edit_document only supports a one-time approval"))

      # The native layer, not arbitrary R code, owns the actual mutation. Mark
      # this request in-progress before returning its already-pinned payload to
      # rai_submit_approval; a duplicate click cannot obtain a second apply.
      # Refuse before native mutation if durable trace storage cannot accept
      # this exact request. Completion still writes its outcome separately;
      # the native caller rolls back if that final write later fails.
      intent <- .rs.rai.appendTrace("edit_apply_requested", list(
         request_id = requestId, document_id = request$target$path,
         digest = request$digest, approval = if (isTRUE(request$auto_approve))
            "autonomous" else "approved_once"))
      if (is.null(intent))
      {
         request$decision <- "failed"
         request$settled_at <- Sys.time()
         request$failure_reason <- "edit trace unavailable; native apply refused"
         assign(requestKey, request, envir = state$requests)
         return(list(status = "error", message = request$failure_reason))
      }
      request$decision <- "applying"
      assign(requestKey, request, envir = state$requests)
      return(list(status = "apply_document", document_id = request$target$path,
                  expected_text = request$document_edit$expected,
                  replacement = request$document_edit$replacement,
                  context_before = request$document_edit$context_before,
                  context_after = request$document_edit$context_after,
                  whole_file = if (isTRUE(request$document_edit$whole_file)) "true" else "false",
                  expected_digest = .rs.rai.orElse(request$document_edit$expected_digest, "")))
   }

   # The pinned pattern comes entirely from the pre-stored request -- the UI
   # cannot see or influence tool/target here. This is what makes the broker
   # authoritative: a client can only say "allow this exact pending request at
   # this scope" or "decline it", never which tool/path/domain gets granted.
   pinnedPattern <- c(list(tool = request$tool), request$target)
   if (any(grepl("[*?]", unlist(pinnedPattern, use.names = FALSE))))
      return(list(status = "error", message = "invalid approval grant"))

   # "Allow once" authorizes the one proposal the user actually read on the
   # card, so the grant carries that proposal's digest and .rs.rai.findGrant
   # will only ever spend it on code that still hashes to the same value.
   # Without this, every run_r proposal shares the single Console target, so a
   # once grant for "20 + 22" would be spendable on any code that asked next.
   #
   # "session" and "project" are deliberately NOT bound: the user chose a
   # standing permission for this tool+target ("stop asking me this session"),
   # which is a different thing from approving one code string. Binding them
   # would quietly turn those buttons into a repeatable "once".
   #
   # The digest is attached after the wildcard check above on purpose -- that
   # check guards the tool/path/domain pattern, and a code digest legitimately
   # contains any character the code did.
   if (identical(scope, "once") && !isConsoleProposal)
   {
      pinnedPattern$digest <- request$digest
      assign(requestId, pinnedPattern, envir = state$once)
   }
   else if (identical(scope, "session"))
      assign(requestId, pinnedPattern, envir = state$session)
   else if (identical(scope, "project"))
   {
      grants <- .rs.rai.readProjectGrants()
      if (!.rs.rai.writeProjectGrants(c(grants, list(pinnedPattern))))
         return(list(status = "error", message = "could not write project policy"))
   }

   if (isConsoleProposal)
   {
      runId <- .rs.rai.registerRun(request$preview, request$max_lines,
                                   request$proposal_id, request$digest)
      if (is.null(runId))
         return(list(status = "error", message = "could not register console run"))
      attached <- .rs.rai.attachRunEvidence(runId, "approved_once")
      if (!isTRUE(attached$ok))
      {
         request$decision <- "failed"
         assign(requestKey, request, envir = state$requests)
         return(list(status = "error", message = attached$reason))
      }
      request$run_id <- runId
   }

   request$decision <- "allow"
   assign(requestKey, request, envir = state$requests)
   if (isConsoleProposal)
      list(status = "queued", scope = scope, run_id = request$run_id, code = request$preview,
           max_lines = get(request$run_id, envir = .rs.rai.runState$records, inherits = FALSE)$max_lines,
           digest = request$digest, proposal_id = request$proposal_id, enqueue = "yes")
   else
      list(status = "granted", scope = scope)
}

# Complete a document edit only after the trusted native approval RPC has
# attempted the pinned mutation. This never accepts document text or a target;
# it merely settles the request that recordGrant() already marked "applying".
# failureReason and the audit arguments are optional for back-compat with the
# original two-argument signature; native always supplies them on the current
# apply path, and audit fields are only ever meaningful (and only ever
# returned) when applied is TRUE -- a failed apply must never assert what the
# buffer's shape was, because the mutation it would describe never landed.
.rs.rai.completeDocumentEdit <- function(requestId, applied, failureReason = NULL,
                                         beforeTotalLines = NULL, beforeBlankLines = NULL,
                                         beforeFenceCount = NULL, beforeChunkParseCount = NULL,
                                         afterTotalLines = NULL, afterBlankLines = NULL,
                                         afterFenceCount = NULL, afterChunkParseCount = NULL, awaitingClient = FALSE)
{
   if (!is.character(requestId) || length(requestId) != 1L || is.na(requestId) ||
       !is.logical(applied) || length(applied) != 1L || is.na(applied))
      return(list(status = "error", message = "invalid document completion"))

   state <- .rs.rai.grantState
   keys <- ls(state$requests, all.names = TRUE)
   requestKey <- keys[vapply(keys, function(key)
      identical(get(key, envir = state$requests, inherits = FALSE)$requestId, requestId),
      logical(1L))]
   if (length(requestKey) != 1L)
      return(list(status = "error", message = "unknown approval request"))

   request <- get(requestKey, envir = state$requests, inherits = FALSE)
   if (!identical(request$tool, "edit_document") || !identical(request$decision, "applying"))
      return(list(status = "error", message = "document approval is not pending native application"))

   request$decision <- if (isTRUE(applied)) { if (isTRUE(awaitingClient)) "applying" else "allow" } else "failed"
   if (!identical(request$decision, "applying"))
      request$settled_at <- Sys.time()
   message <- if (is.character(failureReason) && length(failureReason) == 1L &&
                  !is.na(failureReason) && nzchar(failureReason))
      failureReason
   else
      "document changed, is read-only, or could not be updated"
   edit <- request$document_edit
   link <- .rs.rai.appendTrace(if (isTRUE(applied)) "edit_applied" else "edit_rejected", list(
      request_id = requestId, document_id = request$target$path, path = edit$path,
      approval = if (isTRUE(request$auto_approve)) "autonomous" else "approved_once",
      expected_text = edit$expected, replacement = edit$replacement,
      context_before = edit$context_before, context_after = edit$context_after,
      digest = request$digest, reason = if (isTRUE(applied)) NULL else message,
      undo = if (isTRUE(applied)) "editor Undo changes the buffer only; it does not restore a saved disk file" else NULL))
   request$trace <- link
   if (isTRUE(applied) && is.null(link))
   {
      # The native caller must undo its just-applied buffer mutation before
      # returning this error. Never cache or report an untraced edit as applied.
      request$decision <- "failed"
      request$settled_at <- Sys.time()
      request$failure_reason <- "edit trace unavailable; native rollback required"
      assign(requestKey, request, envir = state$requests)
      return(list(status = "error", message = request$failure_reason))
   }
   if (!isTRUE(applied))
      request$failure_reason <- message
   assign(requestKey, request, envir = state$requests)
   if (!isTRUE(applied))
      return(list(status = "error", message = message))

   asAuditInt <- function(value) if (is.null(value)) NULL else as.integer(value)
   before <- list(total_lines = asAuditInt(beforeTotalLines), blank_lines = asAuditInt(beforeBlankLines),
                  fence_count = asAuditInt(beforeFenceCount), chunk_parse_count = asAuditInt(beforeChunkParseCount))
   after <- list(total_lines = asAuditInt(afterTotalLines), blank_lines = asAuditInt(afterBlankLines),
                 fence_count = asAuditInt(afterFenceCount), chunk_parse_count = asAuditInt(afterChunkParseCount))
   # Audit is only meaningful when a live apply actually reported it; the
   # back-compat two-argument call path leaves every one of these NULL, so
   # omit the fields entirely rather than reporting a fabricated zero.
   hasAudit <- !is.null(beforeTotalLines) && !is.null(afterTotalLines)

   result <- list(status = "applied", document_id = request$target$path)
   if (!is.null(link))
      result$trace <- link
   if (hasAudit)
   {
      result$before <- before
      result$after <- after
   }
   result
}
assign(".rs.rai.completeDocumentEdit", .rs.rai.completeDocumentEdit, envir = .rs.toolsEnv())

.rs.rai.documentSaveAuthorized <- function(requestId, documentId)
{
   requests <- .rs.rai.grantState$requests
   for (key in ls(requests, all.names = TRUE))
   {
      request <- get(key, envir = requests, inherits = FALSE)
      if (identical(request$requestId, requestId))
         return(identical(request$tool, "edit_document") &&
                identical(request$decision, "applying") &&
                identical(request$target$path, documentId))
   }
   FALSE
}
assign(".rs.rai.documentSaveAuthorized", .rs.rai.documentSaveAuthorized, envir = .rs.toolsEnv())

.rs.rai.setDocumentEditOutcome <- function(requestId, status, saved, message)
{
   requests <- .rs.rai.grantState$requests
   for (key in ls(requests, all.names = TRUE))
   {
      request <- get(key, envir = requests, inherits = FALSE)
      if (!identical(request$requestId, requestId)) next
      request$native_outcome <- list(status = status, saved = isTRUE(saved), message = message, trace = request$trace,
                                     request_id = requestId, document_id = request$target$path)
      request$decision <- if (identical(status, "applying")) "applying" else
         if (identical(status, "applied")) "allow" else "failed"
      if (!identical(status, "applying"))
         request$settled_at <- Sys.time()
      request$failure_reason <- message
      assign(key, request, envir = requests)
      return(invisible(TRUE))
   }
   stop("unknown native document operation")
}
assign(".rs.rai.setDocumentEditOutcome", .rs.rai.setDocumentEditOutcome, envir = .rs.toolsEnv())

.rs.rai.findGrant <- function(tool, target, digest = NULL)
{
   state <- .rs.rai.grantState
   for (requestId in ls(state$once, all.names = TRUE))
   {
      grant <- get(requestId, envir = state$once, inherits = FALSE)
      # A digest-bound grant is checked before it is spent: a mismatch leaves
      # the grant in place for the proposal it was actually granted for, rather
      # than consuming it on code the user never approved.
      if (.rs.rai.grantAuthorizes(tool, target, grant, digest))
      {
         rm(list = requestId, envir = state$once)
         return(TRUE)
      }
   }

   for (requestId in ls(state$session, all.names = TRUE))
   {
      if (.rs.rai.grantAuthorizes(tool, target,
                                  get(requestId, envir = state$session, inherits = FALSE),
                                  digest))
         return(TRUE)
   }

   any(vapply(.rs.rai.readProjectGrants(), function(grant)
      .rs.rai.grantAuthorizes(tool, target, grant, digest), logical(1L)))
}

.rs.rai.checkGate <- function(token, tool, target, preview = NULL, diff = NULL,
                              proposalId = NULL, maxLines = NULL)
{
   owner <- .rs.rai.ownerToken()
   if (!is.character(token) || length(token) != 1L || is.na(token) ||
       !nzchar(token) || !nzchar(owner) || !identical(token, owner))
      return("blocked: owner token mismatch")

   if (!tool %in% c("run_r", "edit_document"))
      return("ok")

   target <- .rs.rai.canonicalTarget(tool, target)
   if (is.null(target))
      return("blocked: invalid approval target")

   # preview is the exact proposal payload (for run_r, the code that would be
   # queued), so this digest is the identity of what is being asked for right
   # now -- not of whatever was approved earlier under the same tool/target.
   digest <- .rs.rai.proposalDigest(tool, target, preview, maxLines)
   if (.rs.rai.findGrant(tool, target, digest))
      return("ok")

   # A decision the user already made about THIS exact proposal outranks
   # automation, so it is read here rather than only inside
   # .rs.rai.requestApproval -- which the auto-approval branch below would skip
   # straight past. A decline stays declined however many times the CLI retries
   # the same call, and a card still on screen keeps its own pending id instead
   # of being settled behind the user's back.
   stored <- .rs.rai.storedDecision(tool, target, digest, proposalId)
   if (!is.null(stored))
   {
      if (identical(stored$decision, "decline"))
         return("blocked: approval declined")
      if (is.null(stored$decision))
         return(paste0("approval_required: ", stored$requestId))
   }

   # Effective approval applies to every otherwise-valid run_r proposal, not
   # only the retired read-only classifier. A failed native lookup refuses;
   # legacy pending/declined decisions above are never migrated or replayed.
   if (identical(tool, "run_r"))
   {
      autonomous <- tryCatch(.rs.rai.autoApproveReadOnlyEnabled(), error = function(error) NA)
      if (is.na(autonomous))
         return("blocked: automatic approval unavailable")
      if (isTRUE(autonomous))
         return("ok")
   }

   .rs.rai.requestApproval(tool, paste("Approval required for", tool), target,
                            preview, diff, proposalId, maxLines)
}

# Effective native policy is fixed true. An unavailable or mismatched native
# binding is a refusal, never a manual-card fallback or an implicit grant.
.rs.rai.autoApproveReadOnlyEnabled <- function()
{
   enabled <- tryCatch(.Call("rs_raiAutoApproveReadOnlyEnabled", PACKAGE = "(embedding)"),
                       error = function(error) NULL)
   if (!identical(enabled, TRUE))
      stop("automatic approval unavailable", call. = FALSE)
   TRUE
}

# Read-only peek at the request this exact proposal would map to: its stored
# decision, or NULL when there is no matching request. It uses the same key and
# the same digest comparison .rs.rai.requestApproval uses, so the two always
# agree on which stored record a proposal belongs to. It deliberately never
# creates, mutates, or clears a request -- checkGate calls it before deciding
# anything, and a lookup must not itself change the approval state.
.rs.rai.storedDecision <- function(tool, target, digest, proposalId = NULL)
{
   state <- .rs.rai.grantState
   key <- if (identical(tool, "run_r")) paste0("proposal\r", proposalId) else
      .rs.rai.requestKey(tool, target)
   if (!exists(key, envir = state$requests, inherits = FALSE))
      return(NULL)

   request <- get(key, envir = state$requests, inherits = FALSE)
   # A stored decision governs only the proposal it was actually made about.
   # A different code string under the same key is a different question.
   if (!identical(request$digest, digest))
      return(NULL)

   list(requestId = request$requestId, decision = request$decision)
}

# Side-effecting functions that must never auto-execute even when the call
# itself parses as a single expression. This is a deny-list, not an
# allow-list: isSafeReadOnlyR() rejects on any match found anywhere in the
# expression tree (not just top-level calls), and separately rejects any
# assignment anywhere in the tree. Reject-first (rather than only allowing a
# fixed shape of known-safe calls) is deliberate: a deny-list still correctly
# rejects code this list doesn't yet know about IF it also rejects unknown
# top-level shapes it cannot classify -- see the final fallback below, which
# only allows call/if/for/while/braces/literals/symbols and denies everything
# else (e.g. a language feature this list didn't anticipate).
.rs.rai.readOnlyDenylist <- c(
   "system", "system2", "shell", "shell.exec", "pipe",
   "write", "write.csv", "write.csv2", "write.table", "writeLines", "writeChar", "writeBin",
   "cat",
   "save", "save.image", "saveRDS", "dput", "dump",
   "file.create", "file.remove", "file.rename", "file.copy", "file.append",
   "file.symlink", "file.link", "file.access", "file.show", "file.edit",
   "unlink", "dir.create", "setwd", "Sys.setenv", "Sys.unsetenv",
   "Sys.setlocale", "Sys.sleep", "Sys.chmod", "Sys.umask",
   "install.packages", "remove.packages", "update.packages",
   "install_github", "devtools::install", "renv::install", "renv::restore",
   "source", "sys.source", "library", "require", "requireNamespace",
   "loadNamespace", "attachNamespace", "detach",
   "download.file", "url", "curl", "httr::GET", "httr::POST",
   "eval", "evalq", "parse", "do.call", "Recall", "sys.call", "sys.function",
   "assign", "delayedAssign", "makeActiveBinding", "environment<-",
   "options", "Sys.setResourceLimit", "quit", "q", "shutdown",
   ".Internal", ".Primitive", ".Call", ".External", "dyn.load", "dyn.unload",
   "trace", "untrace", "tracingState", "sink", "capture.output",
   "rm", "remove", "unloadNamespace"
)
# .rs.rai.readOnlyReject (like .rs.rai.grantState) is sourced inside a
# throwaway local() scope and later re-homed by .rs.addFunction, but that
# mechanism only rebinds *function* closures -- a plain data vector referenced
# by lexical scoping (not a function argument) becomes unreachable once the
# sourcing scope is garbage collected, exactly as the block comment below
# warns for helpers in general. Re-home this value explicitly, the same way
# .rs.rai.grantState is re-homed above.
assign(".rs.rai.readOnlyDenylist", .rs.rai.readOnlyDenylist, envir = .rs.toolsEnv())

# Recursively rejects assignment and denylisted calls anywhere in the parsed
# expression, and rejects any language construct this classifier does not
# explicitly recognize (fail closed on the unknown, not fail open).
.rs.rai.readOnlyReject <- function(node)
{
   if (is.symbol(node) || is.null(node) || !is.language(node))
      return(FALSE)

   if (is.pairlist(node))
      return(any(vapply(as.list(node), .rs.rai.readOnlyReject, logical(1L))))

   if (!is.call(node))
      return(FALSE)

   head <- node[[1]]
   headName <- if (is.symbol(head)) as.character(head) else NULL

   assignmentOps <- c("<-", "<<-", "=", "->", "->>", "assign")
   if (!is.null(headName) && headName %in% assignmentOps)
      return(TRUE)

   if (!is.null(headName) && headName %in% .rs.rai.readOnlyDenylist)
      return(TRUE)

   # `::`/`:::` on a denylisted RHS (e.g. base::system) must reject too, since
   # headName above only matches a bare symbol call.
   if (!is.null(headName) && headName %in% c("::", ":::") && length(node) >= 3L)
   {
      rhs <- node[[3]]
      rhsName <- if (is.symbol(rhs)) as.character(rhs) else NULL
      if (!is.null(rhsName) && rhsName %in% .rs.rai.readOnlyDenylist)
         return(TRUE)
   }

   allowedHeads <- c(
      "(", "{", "if", "for", "while", "repeat", "next", "break",
      "::", ":::", "$", "@", "[", "[[", "~",
      "+", "-", "*", "/", "^", "%%", "%/%", "%in%", "%o%",
      "==", "!=", "<", ">", "<=", ">=", "!", "&", "&&", "|", "||",
      ":", "function"
   )
   if (is.null(headName))
      return(TRUE) # anonymous/complex call head (e.g. `(function(x) x)(1)`); fail closed

   if (!headName %in% allowedHeads &&
       !any(vapply(search(), function(pkg) exists(headName, where = pkg, inherits = FALSE),
                   logical(1L))))
   {
      # An unresolvable call head is not classifiable as safe (it may be a
      # not-yet-loaded package function, a redefined symbol shadowing a safe
      # base function, or something this list has never seen). Fail closed
      # rather than assume it is side-effect free.
      return(TRUE)
   }

   any(vapply(as.list(node)[-1], .rs.rai.readOnlyReject, logical(1L)))
}

# Classifies one already-approved-shape run_r proposal (single parseable R
# expression) as safe to auto-execute without a human approval card: no
# assignment, no denylisted side-effecting call, anywhere in the tree.
# Returns FALSE (never auto-approve) on any parse failure or ambiguity.
.rs.rai.isSafeReadOnlyR <- function(code)
{
   if (!is.character(code) || length(code) != 1L || is.na(code) || !nzchar(code))
      return(FALSE)

   parsed <- tryCatch(parse(text = code), error = function(error) NULL)
   if (is.null(parsed) || length(parsed) != 1L)
      return(FALSE)

   expr <- parsed[[1]]
   # Any classifier error must fail closed to "not safe" (require approval),
   # never propagate and break the approval flow itself.
   rejected <- tryCatch(.rs.rai.readOnlyReject(expr), error = function(error) TRUE)
   !isTRUE(rejected)
}

.rs.rai.listOpenDocuments <- function()
{
   documents <- .Call("rs_raiListDocuments", PACKAGE = "(embedding)")
   if (is.null(documents))
      return(list())

   lapply(documents, function(document)
   {
      if (!is.list(document))
         document <- list()

      properties <- document$properties
      tempName <- if (is.list(properties)) properties$tempName else NULL
      list(
         id = document$id,
         path = document$path,
         temp_name = tempName,
         type = document$type,
         dirty = document$dirty,
         read_only = document$read_only,
         source_window = document$source_window
      )
   })
}

# A settled edit_document request answers an identical re-proposal only for a short window, and a failure only while the document read digest is unchanged.
.rs.rai.documentEditReplayable <- function(request, readDigest = NULL)
{
   outcome <- request$native_outcome
   settled <- if (!is.null(outcome)) !identical(outcome$status, "applying") else
      any(request$decision %in% c("allow", "failed"))
   if (!settled)
      return(TRUE)
   settledAt <- .rs.rai.orElse(request$settled_at, request$created_at)
   if (!inherits(settledAt, "POSIXt") ||
       !isTRUE(as.numeric(difftime(Sys.time(), settledAt, units = "secs")) < 30))
      return(FALSE)
   failed <- if (!is.null(outcome)) !identical(outcome$status, "applied") else
      identical(request$decision, "failed")
   stored <- request$document_edit$expected_digest
   !(failed && is.character(readDigest) && length(readDigest) == 1L && nzchar(readDigest) &&
        is.character(stored) && length(stored) == 1L && nzchar(stored) && !identical(readDigest, stored))
}

# Queue a single exact replacement against an already-open source document.
# Native independently proves the exact target before mutation. Supported
# edits auto-apply when Full Auto is enabled; a deliberate opt-out remains
# approval-gated. In both modes the pinned digest and native revalidation
# prevent a stale or different proposal from acquiring edit authority.
#
# contextBefore/contextAfter are optional and must be supplied together (or
# not at all) -- native's own wire boundary enforces this same pairing before
# this function is ever called, but this broker re-checks it independently
# rather than trusting the caller. When supplied, both strings are pinned
# into the digest (so a different context on an otherwise-identical edit is a
# genuinely different proposal) and carried into the stored request's
# document_edit payload so a later apply can pass them straight through to
# native's own anchor revalidation.
# Peek-only: report a previously queued edit_document request's cached
# status for this exact (document, expected/replacement/context) proposal
# without doing any native anchor validation or state mutation. This exists
# so the native HTTP handler can consult it BEFORE re-validating the anchor
# against the *current* buffer -- Full Auto's documented poll contract
# ("poll edit_document with identical arguments until applied/error") is
# only satisfiable if a poll made *after* the mutation already landed can
# still be recognized as the same request, even though the buffer no longer
# contains expected_text (the replacement is there instead). Running the
# anchor check unconditionally on every poll made that recognition
# impossible: the second and later polls saw a buffer that no longer
# anchored, and fell through to a raw 400 instead of the cached terminal
# result/trace -- the trace was written correctly (see appendTrace call
# sites) but the poll response could never reach it after the first apply.
#
# Returns NULL when there is no cached request for this exact proposal (a
# genuinely new edit, which must go through full native anchor validation),
# or the same result shape .rs.rai.queueDocumentEdit would return for an
# "allow"/"applying"/"failed" cached decision until 30 seconds after it settled.
.rs.rai.peekDocumentEditStatus <- function(documentId, expectedText, replacement,
                                           contextBefore = NULL, contextAfter = NULL,
                                      wholeFile = FALSE, expectedDigest = "")
{
   if (!is.character(documentId) || length(documentId) != 1L ||
       !is.character(expectedText) || length(expectedText) != 1L ||
       !is.character(replacement) || length(replacement) != 1L)
      return(NULL)

   contextPairPresent <- !is.null(contextBefore) && !is.null(contextAfter)
   contextBeforeText <- if (contextPairPresent) contextBefore else ""
   contextAfterText <- if (contextPairPresent) contextAfter else ""

   target <- .rs.rai.canonicalTarget("edit_document", documentId)
   if (is.null(target))
      return(NULL)

   digestPayload <- if (isTRUE(wholeFile)) paste("whole", expectedDigest, replacement, sep = "\037") else
      paste(expectedText, replacement, contextBeforeText, contextAfterText, sep = "\037")
   key <- .rs.rai.requestKey("edit_document", target)
   state <- .rs.rai.grantState
   if (!exists(key, envir = state$requests, inherits = FALSE))
      return(NULL)

   request <- get(key, envir = state$requests, inherits = FALSE)
   digest <- .rs.rai.proposalDigest("edit_document", target, digestPayload)
   if (!identical(request$digest, digest))
      return(NULL)
   if (!.rs.rai.documentEditReplayable(request, if (isTRUE(wholeFile)) NULL else .rs.rai.documentReadDigest(documentId)))
      return(NULL)

   if (!is.null(request$native_outcome)) return(request$native_outcome)
   if (identical(request$decision, "allow"))
      return(list(status = "applied", document_id = documentId, trace = request$trace))
   if (identical(request$decision, "applying"))
      return(list(status = "applying", request_id = request$requestId))
   if (identical(request$decision, "failed"))
      return(list(status = "error", request_id = request$requestId,
                  message = .rs.rai.orElse(request$failure_reason,
                                           "document changed, is read-only, or could not be updated")))
   if (identical(request$decision, "decline"))
      return(list(status = "error", request_id = request$requestId,
                  message = "approval declined"))
   # An automatic request still needs its first native apply. Returning a
   # manual-card status here would strand it before the native edit runs.
   if (is.null(request$decision) && !isTRUE(request$auto_approve))
      return(list(status = "approval_required", request_id = request$requestId))
   NULL
}
assign(".rs.rai.peekDocumentEditStatus", .rs.rai.peekDocumentEditStatus, envir = .rs.toolsEnv())

.rs.rai.writePathClass <- function(path, documentId = NULL)
{
   type <- ""
   if (identical(path, "") && !is.null(documentId))
      for (document in .rs.rai.listOpenDocuments())
         if (identical(document$id, documentId) &&
             is.character(document$type) && length(document$type) == 1L)
            type <- document$type
   tryCatch(.Call("rs_raiWritePathClass", path, type, PACKAGE = "(embedding)"),
            error = function(error) "unknown")
}

.rs.rai.wholeFileReadValid <- function(documentId, expectedDigest, expectedText)
{
   isTRUE(tryCatch(.Call("rs_raiWholeFileReadValid", documentId, expectedDigest, expectedText, PACKAGE = "(embedding)"),
                   error = function(error) FALSE))
}

.rs.rai.documentReadDigest <- function(documentId)
{
   tryCatch(.Call("rs_raiDocumentReadDigest", documentId, PACKAGE = "(embedding)"),
            error = function(error) "")
}

.rs.rai.queueDocumentEdit <- function(documentId, expectedText, replacement,
                                      contextBefore = NULL, contextAfter = NULL,
                                      wholeFile = FALSE, expectedDigest = "")
{
   if (!is.character(documentId) || length(documentId) != 1L ||
       !is.character(expectedText) || length(expectedText) != 1L || is.na(expectedText) || (!isTRUE(wholeFile) && !nzchar(expectedText)) ||
       !is.character(replacement) || length(replacement) != 1L || is.na(replacement) || (!isTRUE(wholeFile) && !nzchar(replacement)))
      return(list(status = "error", message = "invalid document edit"))

   contextPairPresent <- !is.null(contextBefore) && !is.null(contextAfter)
   contextPairAbsent <- is.null(contextBefore) && is.null(contextAfter)
   if (!contextPairPresent && !contextPairAbsent)
      return(list(status = "error", message = "context_before and context_after must be supplied together or not at all"))
   if (contextPairPresent &&
       (!is.character(contextBefore) || length(contextBefore) != 1L || is.na(contextBefore) ||
        !is.character(contextAfter) || length(contextAfter) != 1L || is.na(contextAfter)))
      return(list(status = "error", message = "invalid document edit context"))

   # Normalize to always-character storage/digest fields; the absent case is
   # represented as empty strings rather than NULL so downstream code (digest
   # payload, stored request, native apply_document response) never has to
   # special-case NULL.
   contextBeforeText <- if (contextPairPresent) contextBefore else ""
   contextAfterText <- if (contextPairPresent) contextAfter else ""

   target <- .rs.rai.canonicalTarget("edit_document", documentId)
   if (is.null(target))
      return(list(status = "error", message = "document is not open"))

   # Native policy owns the code allowlist and checks every resolved spelling.
   # Environment, data and unknown paths are refused before any card or event.
   documentPath <- .rs.rai.openDocumentPath(documentId)
   kind <- .rs.rai.writePathClass(documentPath, documentId)
   if (!identical(kind, "code") || .rs.rai.isEnvironmentFile(documentPath))
      return(list(status = "error", policy = "refused",
                  message = "refused: only code files are editable; data, environment/profile and unknown files are read-only"))

   if (isTRUE(wholeFile) &&
       (!is.character(expectedDigest) || length(expectedDigest) != 1L || is.na(expectedDigest) ||
        !grepl("^[a-f0-9]{64}$", expectedDigest) ||
        nchar(expectedText, type = "bytes") > 10L*1024L*1024L ||
        nchar(replacement, type = "bytes") > 10L*1024L*1024L ||
        !.rs.rai.wholeFileReadValid(documentId, expectedDigest, expectedText)))
      return(list(status = "error", policy = "refused", message = "read whole file first / file changed since read"))

   if (!isTRUE(wholeFile))
   {
      expectedDigest <- .rs.rai.documentReadDigest(documentId)
      if (!is.character(expectedDigest) || length(expectedDigest) != 1L ||
          is.na(expectedDigest) || !grepl("^[a-f0-9]{64}$", expectedDigest))
         return(list(status = "error", policy = "refused",
                     message = "read whole file first / file changed since read"))
   }

   digestPayload <- if (isTRUE(wholeFile)) paste("whole", expectedDigest, replacement, sep = "\037") else
      paste(expectedText, replacement, contextBeforeText, contextAfterText, sep = "\037")
   key <- .rs.rai.requestKey("edit_document", target)
   state <- .rs.rai.grantState
   if (exists(key, envir = state$requests, inherits = FALSE))
   {
      request <- get(key, envir = state$requests, inherits = FALSE)
      digest <- .rs.rai.proposalDigest("edit_document", target, digestPayload)
      replayable <- identical(request$digest, digest) &&
         .rs.rai.documentEditReplayable(request, if (isTRUE(wholeFile)) NULL else expectedDigest)
      if (replayable && !is.null(request$native_outcome)) return(request$native_outcome)
      if (replayable && identical(request$decision, "allow"))
         return(list(status = "applied", document_id = documentId, trace = request$trace))
      # The first automatic grant has already handed this exact, digest-pinned
      # edit to native code. A retry must never hand over a second mutation.
      if (identical(request$digest, digest) && identical(request$decision, "applying"))
         return(list(status = "applying", request_id = request$requestId))
      # A native rejection (stale anchor/context, read-only, audit mismatch) is
      # terminal for this exact proposal. Re-polling must report it rather than
      # re-arm an automatic apply of text the buffer no longer contains.
      if (replayable && identical(request$decision, "failed"))
         return(list(status = "error", request_id = request$requestId,
                     message = .rs.rai.orElse(request$failure_reason,
                                              "document changed, is read-only, or could not be updated")))
   }

   autonomous <- tryCatch(.rs.rai.autoApproveReadOnlyEnabled(), error = function(error) NA)
   if (is.na(autonomous))
   {
      # Do not replace any prior decision or in-flight edit on this target.
      if (!exists(key, envir = state$requests, inherits = FALSE))
         assign(key, list(requestId = paste0("rai-", basename(tempfile())),
            tool = "edit_document", target = target,
            digest = .rs.rai.proposalDigest("edit_document", target, digestPayload),
            decision = "failed", failure_reason = "automatic approval unavailable",
            created_at = Sys.time()), envir = state$requests)
      return(list(status = "error", message = "automatic approval unavailable"))
   }
   autonomous <- isTRUE(autonomous)
   diff <- paste0("--- current text\n", expectedText, "\n+++ replacement\n", replacement)
   gate <- .rs.rai.requestApproval("edit_document",
                                   if (autonomous) "Full Auto edit_document"
                                   else "Approval required for edit_document",
                                   target, "Replace the exact highlighted text in the open editor.",
                                   diff, digestPayload = digestPayload,
                                   documentEdit = list(expected = expectedText, replacement = replacement,
                                                       context_before = contextBeforeText,
                                                       context_after = contextAfterText,
                                                       path = documentPath, whole_file = isTRUE(wholeFile),
                                                       expected_digest = expectedDigest),
                                   autoApprove = autonomous)
   if (startsWith(gate, "approval_required: "))
   {
      requestId <- sub("^approval_required: ", "", gate)
      # A retry of a pre-existing manual card remains manual even when Full Auto
      # was enabled after the card appeared. Only the stored request can grant
      # authority to apply; the current setting cannot replay that request.
      stored <- get(key, envir = state$requests, inherits = FALSE)
      if (isTRUE(stored$auto_approve))
         return(list(status = "applying", request_id = requestId, approval = "autonomous"))
      return(list(status = "approval_required", request_id = requestId))
   }
   list(status = "error", message = sub("^blocked: ", "", gate))
}

.rs.rai.openDocumentPath <- function(documentId)
{
   for (document in .rs.rai.listOpenDocuments())
      if (identical(document$id, documentId))
      {
         path <- document$path
         if (is.character(path) && length(path) == 1L && !is.na(path))
            return(path)
         return("")
      }
   ""
}
assign(".rs.rai.queueDocumentEdit", .rs.rai.queueDocumentEdit, envir = .rs.toolsEnv())

# Count of extracted chunks that parse without evaluating them -- parse()
# only, never source(), eval(), knitr, or any file I/O. This is the R side of
# raiCountParseableRChunks in SessionRaiAssistant.cpp: it only ever receives
# already fenced-chunk-extracted strings and reports how many are
# syntactically valid single-or-multi-expression R.
.rs.rai.countParseableChunks <- function(chunks)
{
   if (is.null(chunks))
      return(0L)
   if (!is.character(chunks) && !is.list(chunks))
      return(0L)

   texts <- if (is.list(chunks)) chunks else as.list(chunks)
   count <- 0L
   for (text in texts)
   {
      if (!is.character(text) || length(text) != 1L || is.na(text))
         next
      parsed <- tryCatch(parse(text = text), error = function(error) NULL)
      if (!is.null(parsed))
         count <- count + 1L
   }
   as.integer(count)
}
assign(".rs.rai.countParseableChunks", .rs.rai.countParseableChunks, envir = .rs.toolsEnv())

# Console run-result protocol. run_r(where="console") registers a pending run,
# and the native session module enters the approved source as real Console input
# and captures its output from the console event stream (onConsoleInput /
# onConsoleOutput / onConsolePrompt). The captured text is recorded here via
# .rs.rai.recordConsoleCapture, and the CLI polls .rs.rai.getRunResult(run_id).
# The raw source is never evaluated by this broker; it only registers the run,
# records the native capture, and serves the polling representation.
.rs.rai.runState <- local({
   state <- new.env(parent = emptyenv())
   state$records <- new.env(parent = emptyenv())
   state$maxRuns <- 20L
   state$runTtlSecs <- 600
   state$resultTtlSecs <- 1800
   state
})
assign(".rs.rai.runState", .rs.rai.runState, envir = .rs.toolsEnv())

# test-only override for the bounds above
.rs.rai.setRunLimits <- function(maxRuns = NULL, runTtlSecs = NULL, resultTtlSecs = NULL)
{
   state <- .rs.rai.runState
   if (!is.null(maxRuns))
      state$maxRuns <- as.integer(maxRuns)
   if (!is.null(runTtlSecs))
      state$runTtlSecs <- runTtlSecs
   if (!is.null(resultTtlSecs))
      state$resultTtlSecs <- resultTtlSecs
   invisible(NULL)
}

.rs.rai.boundText <- function(lines, maxLines)
{
   if (is.null(lines) || !length(lines))
      return(NULL)

   if (length(lines) > maxLines)
   {
      hidden <- length(lines) - maxLines
      lines <- c(lines[seq_len(maxLines)], sprintf("... [%d more line(s) hidden]", hidden))
   }

   text <- paste(lines, collapse = "\n")
   if (nchar(text) > 8000L)
      text <- paste0(substr(text, 1L, 8000L), "\n... [output truncated at 8000 chars]")
   text
}

# Expire settled cached results only. An active run can still execute or
# complete after a polling deadline, so its authority must remain intact.
.rs.rai.pruneRuns <- function()
{
   state <- .rs.rai.runState
   now <- Sys.time()

   for (id in ls(state$records, all.names = TRUE))
   {
      record <- get(id, envir = state$records, inherits = FALSE)
      staleResult <- record$status %in% c("ok", "error", "indeterminate") && !is.null(record$finished_at) &&
         as.numeric(difftime(now, record$finished_at, units = "secs")) > state$resultTtlSecs

      if (staleResult)
      {
         record$status <- "expired"
         record$stdout <- NULL
         record$stderr <- NULL
         record$error <- NULL
         record$value_summary <- NULL
         assign(id, record, envir = state$records)
      }
   }
   invisible(NULL)
}

# Reclaim settled cache records only. Registration reserves space before
# publication; if all records are active it must refuse, never evict authority.
.rs.rai.evictRuns <- function(protectId = NULL, reserveSlot = FALSE)
{
   state <- .rs.rai.runState
   ids <- ls(state$records, all.names = TRUE)
   capacity <- max(0L, state$maxRuns - as.integer(isTRUE(reserveSlot)))
   if (length(ids) <= capacity)
      return(invisible(NULL))

   records <- stats::setNames(
      lapply(ids, function(id) get(id, envir = state$records, inherits = FALSE)), ids)
   ordered <- ids[order(vapply(records, function(record)
      as.numeric(record$registered_at), numeric(1L)))]
   ordered <- setdiff(ordered, protectId)
   settled <- Filter(function(id)
      !records[[id]]$status %in% c("pending", "running"), ordered)
   toEvict <- utils::head(settled, length(ids) - capacity)
   if (length(toEvict))
      rm(list = toEvict, envir = state$records)
   invisible(NULL)
}

.rs.rai.conditionObserverReady <- function()
{
   handlers <- base::globalCallingHandlers()
   expected <- list(error = .rs.globalCallingHandlers.onError,
                    warning = .rs.globalCallingHandlers.onWarning,
                    message = .rs.globalCallingHandlers.onMessage)
   length(handlers) == 3L && all(vapply(names(expected), function(kind)
      any(vapply(handlers[names(handlers) == kind], identical, logical(1L), expected[[kind]])), logical(1L)))
}

.rs.rai.registerRun <- function(code, maxLines = 200L, proposalId = NULL, digest = NULL)
{
   if (!is.character(code) || length(code) != 1L || is.na(code) || !nzchar(code))
      return(NULL)

   # Console accepts executable R expressions, not chat prompts or tool prose.
   # Parse before registering so invalid text can never be queued into Console.
   # Exactly one top-level expression, for the reasons in .rs.rai.queueConsoleRun.
   parsed <- tryCatch(parse(text = code), error = function(error) NULL)
   if (is.null(parsed) || length(parsed) != 1L)
      return(NULL)

   maxLines <- suppressWarnings(as.integer(maxLines))
   if (is.na(maxLines) || maxLines < 1L)
      maxLines <- 200L

   .rs.rai.pruneRuns()

   if (!is.null(proposalId))
   {
      ids <- ls(.rs.rai.runState$records, all.names = TRUE)
      matches <- ids[vapply(ids, function(id) {
         record <- get(id, envir = .rs.rai.runState$records, inherits = FALSE)
         identical(record$proposal_id, proposalId)
      }, logical(1L))]
      if (length(matches) == 1L)
      {
         record <- get(matches, envir = .rs.rai.runState$records, inherits = FALSE)

         # A settled record (ok/error/expired) already answered its own
         # in-flight duplicate; it must never be handed back as *this* call's
         # result. Without this check, a duplicate approval RPC (double-click,
         # client retry) for the SAME already-approved-and-run proposal would
         # silently replay a finished (possibly long-stale) result instead of
         # registering the fresh run the caller is actually asking for.
         if (record$status %in% c("pending", "running"))
         {
            # The in-flight run is still live: an exact-duplicate resubmission
            # (retry while awaiting a decision, or a retried enqueue RPC)
            # dedupes onto it rather than spawning a second live run for one
            # proposal id. A DIFFERENT code/digest reusing this id while the
            # original is still in flight is a genuine conflict, not a retry
            # -- refuse it outright rather than guessing which one is right.
            if (identical(record$code, code) && identical(record$max_lines, maxLines) &&
                identical(record$digest, digest))
               return(matches)
            return(NULL)
         }
         # A settled/expired proposal is spent. A new run needs a new proposal id.
         return(NULL)
      }
   }

   .rs.rai.evictRuns(reserveSlot = TRUE)
   if (length(ls(.rs.rai.runState$records, all.names = TRUE)) >= .rs.rai.runState$maxRuns)
      return(NULL)

   runId <- paste0("run-", basename(tempfile()))
   record <- list(
      run_id = runId,
      code = code,
      max_lines = maxLines,
      proposal_id = proposalId,
      digest = digest,
      code_hash = .rs.rai.codeHash(code),
      condition_observer_ready = .rs.rai.conditionObserverReady(),
      status = "pending",
      registered_at = Sys.time()
   )
   assign(runId, record, envir = .rs.rai.runState$records)
   runId
}

.rs.rai.terminalizeRun <- function(runId, message, executed = FALSE)
{
   state <- .rs.rai.runState
   if (!exists(runId, envir = state$records, inherits = FALSE))
      return(invisible(FALSE))
   record <- get(runId, envir = state$records, inherits = FALSE)
   if (!record$status %in% c("pending", "running"))
      return(invisible(FALSE))
   .rs.rai.storeRunResult(runId, list(status = "error", stdout = NULL, stderr = NULL,
      error = message, value_summary = NULL, visible = FALSE, elapsed_ms = 0,
      tainted = FALSE, taint_reason = NULL), executed = isTRUE(executed))
   invisible(TRUE)
}

.rs.rai.storeRunResult <- function(runId, result, executed = TRUE)
{
   state <- .rs.rai.runState
   if (!exists(runId, envir = state$records, inherits = FALSE))
      return(invisible(NULL))

   record <- get(runId, envir = state$records, inherits = FALSE)
   record$status <- result$status
   record$stdout <- result$stdout
   record$stderr <- result$stderr
   record$error <- result$error
   record$value_summary <- result$value_summary
   record$visible <- result$visible
   record$elapsed_ms <- result$elapsed_ms
   record$completion <- result$completion
   record$console_epoch <- result$console_epoch
   record$output_bytes <- result$output_bytes
   record$condition_state <- result$condition_state
   record$native_error_text <- result$native_error_text
   record$tainted <- isTRUE(result$tainted)
   record$taint_reason <- result$taint_reason
   record$finished_at <- Sys.time()
   record <- .rs.rai.traceRunCompletion(record, executed)
   assign(runId, record, envir = state$records)
   invisible(NULL)
}

.rs.rai.getRunResult <- function(runId)
{
   if (!is.character(runId) || length(runId) != 1L || is.na(runId) || !nzchar(runId))
      return(list(
         status = "unknown",
         run_id = NULL,
         message = "unknown run id: (missing); ids come from run_r(where=\"console\")"
      ))

   .rs.rai.pruneRuns()

   state <- .rs.rai.runState
   if (!exists(runId, envir = state$records, inherits = FALSE))
      return(list(
         status = "unknown",
         run_id = runId,
         message = paste0("unknown run id: ", runId, "; ids come from run_r(where=\"console\")")
      ))

   record <- get(runId, envir = state$records, inherits = FALSE)
   if (identical(record$status, "expired"))
      return(list(
         status = "expired",
         run_id = runId,
         message = "result no longer available; re-run if needed"
      ))
   if (record$status %in% c("pending", "running"))
      return(list(status = "pending", run_id = runId))

   # tainted is always present on a settled result so the caller never has to
   # tell "clean" apart from "this build doesn't report taint". taint_reason is
   # only carried when there is one to give.
   result <- list(
      status = record$status,
      run_id = runId,
      stdout = record$stdout,
      stderr = record$stderr,
      error = record$error,
      value_summary = record$value_summary,
      visible = record$visible,
      elapsed_ms = record$elapsed_ms,
      completion = record$completion,
      console_epoch = record$console_epoch,
      output_bytes = record$output_bytes,
      condition_state = record$condition_state,
      native_error_text = record$native_error_text,
      code_hash = record$code_hash,
      outcome_verification = "explicit_checks_required",
      tainted = isTRUE(record$tainted)
   )
   if (!is.null(record$trace_queued))
   {
      result$approval <- record$approval
      result$trace <- list(file = record$trace_queued$file, queued_seq = record$trace_queued$seq,
                           completed_seq = record$trace_completed$seq)
      result$data_effects <- record$data_effects
   }
   if (isTRUE(record$tainted) && is.character(record$taint_reason) &&
       length(record$taint_reason) == 1L && !is.na(record$taint_reason) &&
       nzchar(record$taint_reason))
      result$taint_reason <- record$taint_reason
   result
}

# --- Stage 1 debugging support ---------------------------------------------
#
# get_debug_info is a strictly read-only reflection tool: it never evaluates
# code and never queues a Console run. It only re-derives richer, structured
# diagnostics from data the run loop already captured (the stored stderr text
# of a settled run) and, optionally, a bounded str()-like description of
# objects that already exist in the global environment. Nothing here can
# reach the Console or execute caller-supplied code.

.rs.rai.splitCallMessage <- function(line, prefix)
{
   if (!startsWith(line, prefix))
      return(NULL)
   at <- regexpr(" : ", line, fixed = TRUE)[[1L]]
   if (at > 0L)
      return(list(call = substr(line, nchar(prefix) + 1L, at - 1L), message = substring(line, at + 3L)))
   if (endsWith(line, " :"))
      return(list(call = substr(line, nchar(prefix) + 1L, nchar(line) - 2L), message = ""))
   NULL
}

# Console's default error handler prints either "Error: <message>" or
# "Error in <call> : <message>", and a message may itself contain newlines.
# The existing run registry keeps the full stderr text (see boundText above),
# but the "error" scalar surfaced by getRunResult is only ever the first
# stderr line, so a caller reading get_run_result loses continuation lines
# and cannot tell the call apart from the message. This reconstructs both
# from the same captured text -- it is textual reconstruction of what the
# Console already printed, not a live introspection of the R condition
# object, so "class" here is the class the default handler's own message
# format implies (a base stop()-created error), not necessarily whatever
# custom condition class the code actually raised.
.rs.rai.parseErrorDetail <- function(stderrText)
{
   if (!is.character(stderrText) || length(stderrText) != 1L || is.na(stderrText) ||
       !nzchar(stderrText))
      return(NULL)

   lines <- strsplit(stderrText, "\n", fixed = TRUE)[[1L]]
   errorAt <- which(grepl("^Error(:| in )", lines))
   if (!length(errorAt))
      return(NULL)
   errorAt <- errorAt[[1L]]

   # Warnings printed after an error (via options(warn = 1), for example) are
   # parsed separately by parseWarnings; stop collecting the error body at the
   # first such block, or a trailing warning would be folded into the message.
   stopAt <- length(lines)
   warningHeader <- "^(In addition: )?Warning message(s)?:"
   warningAt <- which(grepl(warningHeader, lines[seq(errorAt, length(lines))]))
   if (length(warningAt))
      stopAt <- errorAt + warningAt[[1L]] - 2L
   if (stopAt < errorAt)
      stopAt <- errorAt

   body <- lines[seq(errorAt, stopAt)]
   first <- body[[1L]]
   rest <- if (length(body) > 1L) body[-1L] else character(0)

   split <- .rs.rai.splitCallMessage(first, "Error in ")
   if (!is.null(split))
   {
      call <- split$call
      parts <- c(split$message, rest)
      if (!nzchar(parts[[1L]]) && length(parts) > 1L)
         parts <- c(sub("^ +", "", parts[[2L]]), parts[-(1:2)])
      message <- paste(parts, collapse = "\n")
   }
   else
   {
      call <- NULL
      message <- paste(c(sub("^Error: ?", "", first), rest), collapse = "\n")
   }

   list(
      # Always simpleError/error/condition: this is inferred from Console's
      # own default-handler message format, not read from the live condition
      # object, so a custom condition class raised by the code is not
      # distinguishable here. Documented limitation, not a bug.
      class = c("simpleError", "error", "condition"),
      message = message,
      call = call
   )
}

# Console prints one unnumbered "Warning message:" block for a single warning,
# and a numbered "Warning messages:\n1: In <call> : <message>\n2: ..." block
# for more than one -- this is exactly the "only first warning" limitation
# get_run_result has today. This recovers every entry in the block. Each
# warning message is assumed single-line (matching the common case); a
# warning whose own message contains embedded newlines is not split further,
# since Console's block format offers no unambiguous delimiter for that case.
.rs.rai.parseWarnings <- function(stderrText)
{
   if (!is.character(stderrText) || length(stderrText) != 1L || is.na(stderrText) ||
       !nzchar(stderrText))
      return(list())

   lines <- strsplit(stderrText, "\n", fixed = TRUE)[[1L]]
   warningHeader <- "^(In addition: )?Warning message(s)?:"
   headerAt <- which(grepl(warningHeader, lines))
   if (!length(headerAt))
      return(list())
   headerAt <- headerAt[[1L]]

   body <- lines[seq(headerAt + 1L, length(lines))]
   if (!length(body))
      return(list())

   # Each non-empty line is one entry, except that an "In <call> :" line with no message takes the next indented line as its message.
   lines <- Filter(function(line) nzchar(trimws(line)), body)
   entries <- list()
   i <- 1L
   while (i <= length(lines))
   {
      line <- sub("^[0-9]+: ", "", lines[[i]])
      split <- .rs.rai.splitCallMessage(line, "In ")
      if (is.null(split))
         entries[[length(entries) + 1L]] <- list(call = NULL, message = sub("^: ?", "", line))
      else
      {
         if (!nzchar(split$message) && i < length(lines) && grepl("^[ \t]", lines[[i + 1L]]))
         {
            i <- i + 1L
            split$message <- sub("^[ \t]+", "", lines[[i]])
         }
         entries[[length(entries) + 1L]] <- split
      }
      i <- i + 1L
   }
   entries
}

# Bounded, read-only description of one object that already exists in the
# global environment. Binding inspection and value retrieval are native so the
# binding type can be checked before a value is read: R-level get() would force
# delayedAssign promises. The native helper accepts only this validated bare
# identifier and never evaluates a caller-provided expression or path.
.rs.rai.safeObjectSummary <- function(name, maxLines = 40L)
{
   if (!is.character(name) || length(name) != 1L || is.na(name) ||
       nchar(name, type = "bytes") > 128L ||
       !grepl("^[a-zA-Z.][a-zA-Z0-9._]*$", name))
      return(list(name = name, found = FALSE, summary = NULL))

   result <- .Call("rs_raiSafeObjectSummary", name, PACKAGE = "(embedding)")
   list(name = name, found = isTRUE(result$found), summary = result$summary)
}

# Data-Viewer-shaped detail for one existing global object: class, dimensions,
# row/column counts, and column names with their classes. Like safeObjectSummary
# this reads only metadata R already holds -- it never dispatches str/print/head,
# never forces a promise or active binding, and never returns a cell value. The
# native helper re-validates the identifier, so a non-identifier is rejected here
# without ever being parsed or evaluated.
#
# summaryMode is forwarded as-is to the native helper, which re-validates it and
# falls back to "full" on anything else; only "nrow" changes this function's
# output shape, dropping every column field below so a caller that only asked
# "how many rows" never receives a column enumeration.
#
# requestedColumns is an optional, independently bounded (<=20, already
# enforced at the wire boundary) character vector of bare column names. It is
# metadata-only, just like the rest of this function: found/class per name,
# looked up without ever forcing a value beyond what this function already
# reads, and available whether or not summaryMode enumerates the full column
# list -- so a caller can resolve a column past the 40-column listing cap
# without asking for the whole (possibly truncated) list.
.rs.rai.dataObjectDetail <- function(name, summaryMode = "full", requestedColumns = NULL)
{
   if (!is.character(name) || length(name) != 1L || is.na(name) ||
       nchar(name, type = "bytes") > 128L ||
       !grepl("^[a-zA-Z.][a-zA-Z0-9._]*$", name))
      return(list(name = name, found = FALSE))

   if (!is.character(summaryMode) || length(summaryMode) != 1L || is.na(summaryMode) ||
       !summaryMode %in% c("full", "nrow"))
      summaryMode <- "full"

   if (!is.character(requestedColumns))
      requestedColumns <- character(0)
   requestedColumns <- requestedColumns[!is.na(requestedColumns) &
      grepl("^[a-zA-Z.][a-zA-Z0-9._]*$", requestedColumns)]
   requestedColumns <- utils::head(requestedColumns, 20L)

   detail <- .Call("rs_raiDataObjectDetail", name, summaryMode, requestedColumns,
                   PACKAGE = "(embedding)")
   if (!isTRUE(detail$found))
      return(list(name = name, found = FALSE))

   # nrow is deliberately identity/class/row-count only. Do not forward the
   # generic metadata summary: for data frames that summary can contain column
   # names, defeating nrow mode's no-column-enumeration contract.
   result <- list(name = name, found = TRUE, binding = detail$binding)
   if (!identical(summaryMode, "nrow"))
      result$summary <- detail$summary

   # A promise or active binding stops here by construction: it was classified,
   # never forced, so there is no class, shape, column list, or requested-column
   # lookup to report.
   if (!identical(detail$binding, "value"))
      return(result)

   if (length(detail$metadata_unavailable))
      result$metadata_unavailable <- detail$metadata_unavailable
   result$class <- detail$classes
   if (length(detail$dims))
      result$dims <- detail$dims
   if (length(detail$row_count))
      result$row_count <- detail$row_count

   if (identical(summaryMode, "full"))
   {
      if (length(detail$column_count))
         result$column_count <- detail$column_count

      columns <- Map(function(columnName, columnClass, available, sampleRows, missing)
         c(list(name = columnName, class = columnClass),
           if (isTRUE(available)) list(missingness = list(scope = "first_rows",
              inspected_rows = sampleRows, missing_count = missing))
           else list(missingness = list(scope = "unavailable_unrealized_or_unsupported"))),
         detail$column_names, detail$column_classes, detail$column_missing_available,
         detail$column_missing_sample_rows, detail$column_missing_sample_counts)
      names(columns) <- NULL
      result$columns <- columns
      result$columns_truncated <- isTRUE(detail$columns_truncated)
   }

   if (length(detail$requested_column_names))
   {
      requested <- Map(function(columnName, found, columnClass, available, sampleRows, missing, availability)
         if (identical(availability, "unavailable"))
            list(name = columnName, availability = "unavailable")
         else c(list(name = columnName, found = isTRUE(found), class = columnClass),
           if (isTRUE(available)) list(missingness = list(scope = "first_rows",
              inspected_rows = sampleRows, missing_count = missing))
           else list(missingness = list(scope = "unavailable_unrealized_or_unsupported"))),
         detail$requested_column_names, detail$requested_column_found,
         detail$requested_column_classes, detail$requested_column_missing_available,
         detail$requested_column_missing_sample_rows,
         detail$requested_column_missing_sample_counts,
         detail$requested_column_availability)
      names(requested) <- NULL
      result$requested_columns <- requested
   }

   result
}

# The single read-only entry point for get_environment_summary. With no names it
# lists bounded .GlobalEnv binding metadata; with names it returns per-object
# detail. Neither shape evaluates code, forces a promise or active binding,
# reads a value, or reaches outside .GlobalEnv -- to see actual data the
# assistant must go through the approved run_r Console boundary instead.
#
# summaryMode and requestedColumns are passed through unchanged to every
# per-object detail call below; they have no effect on the no-names listing
# shape, which was never a column-bearing response to begin with.
.rs.rai.environmentSummary <- function(objectNames = NULL, summaryMode = "full",
                                       requestedColumns = NULL)
{
   if (identical(objectNames, ""))
      objectNames <- NULL
   if (is.character(objectNames) && length(objectNames) == 1L && !is.na(objectNames) &&
       grepl(",", objectNames, fixed = TRUE))
      objectNames <- strsplit(objectNames, ",", fixed = TRUE)[[1L]]

   if (!is.character(summaryMode) || length(summaryMode) != 1L || is.na(summaryMode) ||
       !summaryMode %in% c("full", "nrow"))
      summaryMode <- "full"

   if (identical(requestedColumns, ""))
      requestedColumns <- NULL
   if (is.character(requestedColumns) && length(requestedColumns) == 1L &&
       !is.na(requestedColumns) && grepl(",", requestedColumns, fixed = TRUE))
      requestedColumns <- strsplit(requestedColumns, ",", fixed = TRUE)[[1L]]

   if (is.null(objectNames))
   {
      listing <- .Call("rs_raiEnvironmentBindings", PACKAGE = "(embedding)")
      bindings <- Map(function(name, binding, class)
         list(name = name, binding = binding, class = class),
         listing$names, listing$bindings, listing$classes)
      names(bindings) <- NULL
      return(list(
         bindings = bindings,
         binding_count = length(bindings),
         total_count = listing$total_count,
         truncated = isTRUE(listing$truncated),
         max_bindings = 100L
      ))
   }

   if (!is.character(objectNames))
      objectNames <- character(0)
   # Bounded input surface, matching get_debug_info: at most 20 names per call,
   # so this can never be used to bulk-dump the workspace one request at a time.
   objectNames <- utils::head(unique(objectNames), 20L)
   list(objects = lapply(objectNames, .rs.rai.dataObjectDetail,
                         summaryMode = summaryMode, requestedColumns = requestedColumns))
}

# The single read-only entry point for Stage 1 debugging support. It composes
# the existing (unmodified) getRunResult with the richer error/warning
# parsing above, and optional bounded object summaries -- nothing here queues
# a run, evaluates code, or otherwise reaches the Console.
.rs.rai.getDebugInfo <- function(runId, objectNames = NULL)
{
   result <- .rs.rai.getRunResult(runId)

   if (result$status %in% c("error", "ok", "indeterminate"))
   {
      result$error_detail <- if (identical(result$status, "error"))
         .rs.rai.parseErrorDetail(result$native_error_text) else NULL
      nativeText <- result$native_error_text
      if (identical(result$status, "error") && is.null(result$error_detail) &&
          is.character(nativeText) && length(nativeText) == 1L &&
          !is.na(nativeText) && nzchar(nativeText))
      {
         # Native lifecycle proves the error independently of display language.
         # Preserve unknown/localized formats verbatim; do not invent a call or subclass.
         result$error_detail <- list(class = c("error", "condition"),
                                     message = nativeText, call = NULL)
      }
      result$warnings <- .rs.rai.parseWarnings(result$stderr)
      # Raw Console output reports an error after unwinding; it does not expose
      # the live condition/call stack at the approved run boundary. Calling
      # traceback() later would inspect unrelated session state, and wrapping
      # the source would violate the strict raw-Console contract, so advertise
      # the limitation instead of inventing frames.
      result$traceback_available <- FALSE
      result$traceback_unavailable_reason <-
         "raw Console error lifecycle does not expose faithful call frames for this approved run"
   }

   if (identical(objectNames, ""))
      objectNames <- NULL
   if (is.character(objectNames) && length(objectNames) == 1L && !is.na(objectNames) &&
       grepl(",", objectNames, fixed = TRUE))
      objectNames <- strsplit(objectNames, ",", fixed = TRUE)[[1L]]
   if (!is.null(objectNames))
   {
      if (!is.character(objectNames))
         objectNames <- character(0)
      # Bounded input surface: at most 20 names may be requested per call, so
      # this can never be used to enumerate or bulk-dump the whole session.
      objectNames <- utils::head(unique(objectNames), 20L)
      result$object_summaries <- lapply(objectNames, .rs.rai.safeObjectSummary)
   }

   result
}

# Record a natively-captured Console result into the run registry. The native
# session module owns raw Console input and output capture (via module_context
# console events); this only stores the bounded text and derived status for
# polling. Raw code is never evaluated here. Single-shot: an already-settled run
# is left untouched, so a replayed history line cannot overwrite its result. The
# printed value (e.g. "[1] 42") is part of the captured stdout stream.
#
# tainted/taintReason come from the native capture: it sets them when something
# other than the approved input was seen on the Console between the correlated
# input and the finalizing prompt, so the stored text may not be attributable to
# this run alone. The result is still stored (it is evidence, not garbage) but is
# labelled so the caller does not read it as a clean measurement.
.rs.rai.warningOutputMatches <- function(text, messages)
{
   if (!is.character(text) || length(text) != 1L || is.na(text) ||
       !length(messages) || length(messages) > 64L || anyNA(messages)) return(FALSE)
   text <- trimws(text)
   headers <- unique(c(gettext(c("Warning message:", "Warning messages:", "Warning:"), domain = "R"),
      "Warning message:", "Warning messages:", "Warning:", "Message d'avis :", "Messages d'avis :", "Avis :"))
   found <- which(startsWith(text, headers))
   if (length(found)) text <- substring(text, nchar(headers[[found[[1L]]]]) + 1L)
   else if (length(messages) == 1L && grepl("^Warning in [^\n]* :", text))
      text <- sub("^Warning in [^\n]* :[ \t]*", "", text)
   else return(FALSE)
   for (i in seq_along(messages))
   {
      text <- trimws(text, which = "left")
      if (length(messages) > 1L)
      {
         prefix <- paste0(i, ": ")
         if (!startsWith(text, prefix)) return(FALSE)
         text <- substring(text, nchar(prefix) + 1L)
      }
      message <- trimws(messages[[i]])
      if (!nzchar(message)) return(FALSE)
      if (!startsWith(text, message)) text <- sub("^(In|Dans) [^\n]* :[ \t\n]*", "", text)
      if (!startsWith(text, message)) return(FALSE)
      text <- substring(text, nchar(message) + 1L)
   }
   !nzchar(trimws(text))
}

.rs.rai.utf8Safe <- function(x)
   if (is.character(x) && length(x)) iconv(enc2utf8(x), "UTF-8", "UTF-8", sub = "byte") else x

.rs.rai.recordConsoleCapture <- function(runId, ...)
   tryCatch(.rs.rai.recordConsoleCaptureText(runId, ...), error = function(error)
      .rs.rai.terminalizeRun(runId, paste0("console capture could not be recorded: ", conditionMessage(error)), executed = TRUE))

.rs.rai.recordConsoleCaptureText <- function(runId, stdout = "", stderr = "", elapsedMs = 0,
                                             tainted = FALSE, taintReason = "", consoleEpoch = NULL,
                                             outputBytes = NULL, conditionState = "none", nativeErrorText = "",
                                             expectedWarnings = character(0), unattributedStderr = "", expectedError = "")
{
   state <- .rs.rai.runState
   if (!is.character(runId) || length(runId) != 1L || is.na(runId) || !nzchar(runId) ||
       !exists(runId, envir = state$records, inherits = FALSE))
      return(invisible(NULL))

   record <- get(runId, envir = state$records, inherits = FALSE)
   if (!record$status %in% c("pending", "running"))
      return(invisible(NULL))

   if (!is.character(stdout) || length(stdout) != 1L || is.na(stdout))
      stdout <- ""
   if (!is.character(stderr) || length(stderr) != 1L || is.na(stderr))
      stderr <- ""
   stdout <- .rs.rai.utf8Safe(stdout)
   stderr <- .rs.rai.utf8Safe(stderr)
   nativeErrorText <- .rs.rai.utf8Safe(nativeErrorText)
   unattributedStderr <- .rs.rai.utf8Safe(unattributedStderr)
   expectedError <- .rs.rai.utf8Safe(expectedError)
   expectedWarnings <- .rs.rai.utf8Safe(expectedWarnings)
   taintReason <- .rs.rai.utf8Safe(taintReason)

   stdoutLines <- if (nzchar(stdout)) strsplit(stdout, "\n", fixed = TRUE)[[1L]] else character(0)
   stderrLines <- if (nzchar(stderr)) strsplit(stderr, "\n", fixed = TRUE)[[1L]] else character(0)

   # An R error surfaces on the error stream as a line beginning with "Error".
   # geterrmessage() was tried as a locale-independent alternative/supplement
   # to this English-only marker, but live E2E evidence rejected it:
   # geterrmessage() is R's GLOBAL interpreter error register, and inside a
   # live RStudio session with diagnostics/autocompletion/environment-pane
   # refresh running, unrelated internal code can raise-and-catch an error
   # (advancing the register) with no connection to the run it happened to
   # land next to -- producing false "error" classifications for genuinely
   # successful runs (observed for a function-definition-and-call proposal
   # and a multiline braced-expression proposal). The stderr text Console
   # actually printed for THIS run remains the only signal that is provably
   # scoped to it.
   if (identical(conditionState, "unknown") &&
       .rs.rai.warningOutputMatches(unattributedStderr, expectedWarnings))
      conditionState <- "non_error"
   knownNonError <- identical(conditionState, "non_error") &&
      isTRUE(record$condition_observer_ready) && .rs.rai.conditionObserverReady()
   # Remove a default warning epilogue only when BOTH the complete observed
   # error message remains before it and the entire tail matches native warnings.
   # Raw stderr is never changed. A warning-looking line inside the error itself
   # cannot qualify merely by matching a translated header.
   if (identical(conditionState, "error") && nzchar(expectedError) && length(expectedWarnings))
   {
      lines <- strsplit(nativeErrorText, "\n", fixed = TRUE)[[1L]]
      prefixes <- unique(c(gettext("In addition: ", domain = "R", trim = FALSE), "In addition: ", "De plus : "))
      if (length(lines) > 1L)
      for (i in rev(seq.int(2L, length(lines))))
      {
         prefix <- prefixes[startsWith(lines[[i]], prefixes)]
         if (!length(prefix)) next
         before <- paste(lines[seq_len(i - 1L)], collapse = "\n")
         after <- paste(lines[seq.int(i, length(lines))], collapse = "\n")
         after <- substring(after, nchar(prefix[[1L]]) + 1L)
         if (grepl(expectedError, before, fixed = TRUE) &&
             .rs.rai.warningOutputMatches(after, expectedWarnings))
         {
            nativeErrorText <- before
            break
         }
      }
   }
   errorLines <- if (identical(conditionState, "error")) grep("^Error", stderrLines, value = TRUE) else character(0)
   errorMessage <- if (identical(conditionState, "error") && nzchar(nativeErrorText))
                      strsplit(nativeErrorText, "\n", fixed = TRUE)[[1L]][[1L]]
                   else if (length(errorLines)) errorLines[[1L]]
                   else if (identical(conditionState, "error") && length(stderrLines)) stderrLines[[1L]]
                   else NULL

   if (!is.character(taintReason) || length(taintReason) != 1L || is.na(taintReason))
      taintReason <- ""

   .rs.rai.storeRunResult(runId, list(
      status = if (identical(conditionState, "error")) "error"
               else if (!nzchar(stderr) || knownNonError) "ok"
               else "indeterminate",
      stdout = .rs.rai.boundText(stdoutLines, record$max_lines),
      stderr = .rs.rai.boundText(stderrLines, record$max_lines),
      error = errorMessage,
      value_summary = NULL,
      visible = FALSE,
      elapsed_ms = elapsedMs,
      completion = "top_level_prompt",
      console_epoch = consoleEpoch,
      output_bytes = outputBytes,
      condition_state = conditionState,
      native_error_text = nativeErrorText,
      tainted = isTRUE(tainted),
      taint_reason = if (isTRUE(tainted) && nzchar(taintReason)) taintReason else NULL
   ))
   invisible(NULL)
}

# Reject parsed R forms that can end the rsession, install a fatal error hook, or
# construct an uninspectable indirect call. This is deliberately narrower than
# an effect-policy: ordinary workspace assignments, package use, file/data work,
# and normal R errors remain valid Console work. An R error returns to the real
# Console prompt and is captured by the existing run-result loop; these forms do
# not, so they must never be sent there automatically.
.rs.rai.consoleSessionUnsafe <- function(node)
{
   unsafeNames <- c("q", "quit", "shutdown", ".Internal", ".Primitive", ".Call",
                    ".External", "eval", "evalq", "parse", "do.call", "get",
                    "mget", "match.fun")

   if (is.symbol(node))
      return(as.character(node) %in% unsafeNames)
   if (is.null(node) || !is.language(node))
      return(FALSE)
   if (is.pairlist(node))
      return(any(vapply(as.list(node), .rs.rai.consoleSessionUnsafe, logical(1L))))
   if (!is.call(node))
      return(FALSE)

   head <- node[[1L]]
   # `pkg::fn(...)` / `pkg:::fn(...)` parse with the call `pkg::fn` as their
   # head. That is a static, fully inspectable name, not a computed call:
   # accept it when both parts are plain names and the function is not a
   # session-control primitive, then keep walking the arguments.
   if (is.call(head) && is.symbol(head[[1L]]) &&
       as.character(head[[1L]]) %in% c("::", ":::") && length(head) == 3L &&
       (is.symbol(head[[2L]]) || is.character(head[[2L]])) &&
       (is.symbol(head[[3L]]) || is.character(head[[3L]])))
   {
      if (as.character(head[[3L]]) %in% unsafeNames)
         return(TRUE)
      return(any(vapply(as.list(node)[-1L], .rs.rai.consoleSessionUnsafe, logical(1L))))
   }
   # `(get("q"))()` and similar computed heads evade a plain name comparison.
   if (!is.symbol(head))
      return(TRUE)
   headName <- as.character(head)
   if (headName %in% unsafeNames)
      return(TRUE)

   # Qualifying a known session-control primitive does not make it safe.
   if (headName %in% c("::", ":::") && length(node) >= 3L &&
       (is.symbol(node[[3L]]) || is.character(node[[3L]])) &&
       as.character(node[[3L]]) %in% unsafeNames)
      return(TRUE)

   # A member name, an assignment target or a formula term is data, never a call.
   if (headName %in% c("$", "@") && length(node) == 3L)
      return(.rs.rai.consoleSessionUnsafe(node[[2L]]))
   operands <- as.list(node)[-1L]
   if (headName %in% c("<-", "=", "<<-") && length(node) == 3L && is.symbol(node[[2L]]))
      operands <- operands[-1L]
   if (identical(headName, "~"))
      operands <- operands[!vapply(operands, is.symbol, logical(1L))]
   any(vapply(operands, .rs.rai.consoleSessionUnsafe, logical(1L)))
}

# --- Autonomous derived-data boundary and durable trace ---------------------
#
# Autonomy scope:
# Assistant code authoring, IDE code edits and strict R Console execution run
# without per-action prompts; data may be read and transformed THROUGH CODE into
# NEW derived objects/files, but original data is never edited directly, and
# every Assistant-initiated execution leaves a durable, exact code trace.
#
# Enforcement boundary, stated honestly: arbitrary R can always reach state this
# static check cannot see (reference objects, environments, compiled code, files
# named by computed paths, package functions that write internally). This guard
# is therefore a fail-closed policy over the parsed proposal for the KNOWN
# direct-mutation forms listed below, plus observed before/after evidence at the
# run boundary. It is not, and is never reported as, proof of immutability or
# complete lineage. A refusal is a policy refusal, never an approval request.

.rs.rai.dataState <- local({
   state <- new.env(parent = emptyenv())
   # name -> binding identity of a .GlobalEnv binding an Assistant run created;
   # only these may be rebound by later Assistant runs.
   state$derived <- new.env(parent = emptyenv())
   # Existing user bindings are never inferred from their names. A distinct
   # one-time native approval may designate a proven plot/helper/path binding
   # by its current normal-binding identity and bounded kind.
   state$authorized <- new.env(parent = emptyenv())
   state$traceSeq <- 0L
   state$traceDirOverride <- NULL
   state$lastRefusal <- NULL
   state
})
assign(".rs.rai.dataState", .rs.rai.dataState, envir = .rs.toolsEnv())

# Session bookkeeping bindings that ordinary computation rebinds (RNG state).
# Their change is reported separately and never treated as an edited original.
.rs.rai.sessionBookkeeping <- c(".Random.seed")
assign(".rs.rai.sessionBookkeeping", .rs.rai.sessionBookkeeping, envir = .rs.toolsEnv())

# Environment/profile/workspace files the Assistant never edits or overwrites.
.rs.rai.environmentFileNames <- c(".Renviron", ".Rprofile", ".RData", ".Rhistory",
                                  ".Rapp.history", "Renviron.site", "Rprofile.site",
                                  "renv.lock", ".Renviron.site")
assign(".rs.rai.environmentFileNames", .rs.rai.environmentFileNames, envir = .rs.toolsEnv())

.rs.rai.orElse <- function(x, y) if (is.null(x)) y else x

# Credential, profile and system locations an Assistant run never reads or writes, matched case-insensitively against every spelling of a path.
.rs.rai.protectedLocationPatterns <- list(
   dotDirectories = "(^|/)\\.(ssh|aws|gnupg|kube|docker|azure|oci|kaggle|huggingface|raistudio|claude|codex|gemini|cursor|mozilla|password-store|terraform\\.d|cloudflared|ngrok2|heroku|grok|openai|oh-my-zsh|zsh_sessions|bash_sessions|vim|emacs\\.d)(/|$)",
   configDirectories = "(^|/)\\.config/(gcloud|gh|op|rclone|opencode|github-copilot|google-chrome|chromium|BraveSoftware|anthropic|fish|autostart|git|nvim|helix|zed)(/|$)",
   shareDirectories = "(^|/)\\.local/share/(opencode|keyrings)(/|$)",
   cacheDirectories = "(^|/)\\.cache/huggingface(/|$)",
   libraryDirectories = "(^|/)Library/(Keychains|Cookies|Safari|Mail|Messages|Accounts|LaunchAgents|LaunchDaemons)(/|$)",
   browserData = "(^|/)Library/Application Support/(Google/Chrome|Chromium|BraveSoftware|Microsoft Edge|Firefox|Arc|Vivaldi|Opera Software|AddressBook|Claude)(/|$)",
   windowsData = "(^|/)AppData/(Local|Roaming)/(Google/Chrome|Mozilla|Microsoft/(Credentials|Protect|Vault))(/|$)",
   deployAccounts = "(^|/)rsconnect/accounts(/|$)",
   gitConfig = "(^|/)\\.git/(modules/.+/)?config$",
   gitHooks = "(^|/)\\.git/(modules/.+/)?hooks(/|$)",
   secretDirectories = "(^|/)secrets?(/|$)",
   userMakevars = "(^|/)\\.R/Makevars[^/]*$",
   environmentFiles = "(^|/)\\.(Renviron|Rprofile|env)(\\.[^/]*)?$",
   siteFiles = "(^|/)(Renviron|Rprofile)\\.site$",
   shellStartup = "(^|/)\\.(zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|login|logout|inputrc|cshrc|tcshrc)(\\.[^/]*)?$",
   shellDropIns = "(^|/)\\.(zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|profile|login)\\.d(/|$)",
   interactiveStartup = "(^|/)\\.(vimrc|gvimrc|exrc|tmux\\.conf|emacs|screenrc|bash_aliases|zsh_aliases)$",
   credentialDotfiles = "(^|/)(\\.envrc|\\.netrc|_netrc|\\.npmrc|\\.pypirc|\\.pgpass|\\.my\\.cnf|\\.mylogin\\.cnf|\\.git-credentials|\\.databrickscfg|\\.vault-token|\\.s3cfg|\\.boto|\\.claude\\.json|\\.gitconfig)$",
   historyFiles = "(^|/)\\.[A-Za-z0-9_.]*history$",
   credentialLeaves = "(^|/)(credentials|secrets?)(\\.[^/]*)?$",
   privateKeys = "(^|/)id_(rsa|dsa|ecdsa|ed25519)[^/]*(?<!\\.pub)$",
   keyStores = "\\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$",
   systemSecrets = "^(/private)?/etc/(passwd|master\\.passwd|shadow|sudoers(\\.d/.*)?)$",
   processEnvironment = "^/proc/[^/]+/environ$")
assign(".rs.rai.protectedLocationPatterns", .rs.rai.protectedLocationPatterns, envir = .rs.toolsEnv())

# Environment variable names an Assistant run never reads: the owner tokens and anything that looks like a secret.
.rs.rai.secretEnvironmentPattern <- paste0("^RAI_|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|",
   "SESSION_?(ID|TOKEN|KEY|COOKIE|SECRET)|(^|_)PAT($|_)|_(PASS|PWD|PW)($|_)|DSN|CONNECTION_STRING|PRIVATE|",
   "(DATABASE|REDIS|MONGO|POSTGRES|MYSQL|AMQP|BROKER)[A-Z0-9_]*_(URL|URI)")
assign(".rs.rai.secretEnvironmentPattern", .rs.rai.secretEnvironmentPattern, envir = .rs.toolsEnv())

.rs.rai.isProtectedLocation <- function(path)
{
   if (!is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path))
      return(FALSE)
   tryCatch({
      plain <- sub("^file://(localhost)?(?=/)", "", path, ignore.case = TRUE, perl = TRUE)
      expanded <- path.expand(gsub("\\", "/", plain, fixed = TRUE))
      resolved <- normalizePath(expanded, winslash = "/", mustWork = FALSE)
      ancestor <- expanded
      remainder <- character(0)
      while (!file.exists(ancestor) && !identical(dirname(ancestor), ancestor))
      {
         remainder <- c(basename(ancestor), remainder)
         ancestor <- dirname(ancestor)
      }
      real <- normalizePath(ancestor, winslash = "/", mustWork = FALSE)
      beyond <- gsub("/+", "/", paste(c(real, remainder), collapse = "/"))
      spellings <- unique(c(path, plain, expanded, resolved, beyond))
      any(grepl(paste(unlist(.rs.rai.protectedLocationPatterns), collapse = "|"), spellings,
                ignore.case = TRUE, perl = TRUE))
   }, error = function(error) TRUE)
}

.rs.rai.literalStrings <- function(node)
{
   if (is.character(node) && length(node) > 0L && !anyNA(node))
      return(as.character(node))
   if (is.call(node) && identical(node[[1L]], as.name("c")) && length(node) > 1L)
   {
      values <- lapply(as.list(node)[-1L], .rs.rai.literalStrings)
      if (any(vapply(values, is.null, logical(1L))))
         return(NULL)
      return(unlist(values))
   }
   folded <- .rs.rai.foldPath(node)
   if (is.null(folded) || isTRUE(folded$fresh)) NULL else folded$path
}

.rs.rai.isEnvironmentFile <- function(path, forRead = FALSE)
{
   if (!is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path))
      return(FALSE)
   internal <- grepl("(^|/)\\.raistudio(/|$)", path)
   if (isTRUE(forRead))
      return(internal || grepl("^/(dev|proc)/", path) || .rs.rai.isProtectedLocation(path))
   base <- basename(path)
   base %in% .rs.rai.environmentFileNames ||
      grepl("^\\.env($|\\.)|^\\.envrc$", base, ignore.case = TRUE) ||
      grepl("\\.(RData|rda|Rhistory)$", base, ignore.case = TRUE) ||
      internal
}

# test-only override so suites never write into the user's ~/.raistudio
.rs.rai.setTraceDir <- function(path = NULL)
{
   .rs.rai.dataState$traceDirOverride <- path
   invisible(NULL)
}

.rs.rai.traceDir <- function()
{
   override <- .rs.rai.dataState$traceDirOverride
   if (is.character(override) && length(override) == 1L && nzchar(override))
   {
      if (!dir.exists(override) && !dir.create(override, recursive = TRUE, mode = "0700"))
         return(NULL)
      return(normalizePath(override, winslash = "/", mustWork = TRUE))
   }
   stateDir <- .rs.rai.userStateDir(create = TRUE)
   if (is.null(stateDir))
      return(NULL)
   traceDir <- file.path(stateDir, "trace")
   if (!dir.exists(traceDir) && !dir.create(traceDir, recursive = FALSE, mode = "0700"))
      return(NULL)
   if (nzchar(Sys.readlink(traceDir)) || !.rs.rai.chmodOwnerOnly(traceDir, "0700"))
      return(NULL)
   traceDir
}

.rs.rai.jsonString <- function(x)
{
   x <- enc2utf8(as.character(x))
   x <- gsub("\\", "\\\\", x, fixed = TRUE)
   x <- gsub("\"", "\\\"", x, fixed = TRUE)
   x <- gsub("\n", "\\n", x, fixed = TRUE)
   x <- gsub("\r", "\\r", x, fixed = TRUE)
   x <- gsub("\t", "\\t", x, fixed = TRUE)
   if (grepl("[\001-\037]", x, useBytes = TRUE))
   {
      codes <- utf8ToInt(x)
      pieces <- vapply(codes, function(code)
         if (code < 32L) sprintf("\\u%04x", code) else intToUtf8(code), character(1L))
      x <- paste(pieces, collapse = "")
   }
   paste0("\"", x, "\"")
}

# Minimal dependency-free JSON writer: length-1 atomics are scalars, unnamed
# lists are arrays, named lists are objects. Only ever encodes trace records.
.rs.rai.toJson <- function(value)
{
   if (is.null(value))
      return("null")
   if (is.list(value))
   {
      if (!length(value))
         return(if (is.null(names(value))) "[]" else "{}")
      parts <- vapply(value, .rs.rai.toJson, character(1L))
      if (is.null(names(value)) || all(!nzchar(names(value))))
         return(paste0("[", paste(parts, collapse = ","), "]"))
      return(paste0("{", paste0(vapply(names(value), .rs.rai.jsonString, character(1L)),
                                ":", parts, collapse = ","), "}"))
   }
   if (inherits(value, "POSIXt"))
      value <- format(value, "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC")
   if (length(value) != 1L)
      return(.rs.rai.toJson(as.list(value)))
   if (is.na(value))
      return("null")
   if (is.logical(value))
      return(if (value) "true" else "false")
   if (is.numeric(value))
      return(if (is.finite(value)) format(value, digits = 15, scientific = FALSE, trim = TRUE, decimal.mark = ".")
             else "null")
   .rs.rai.jsonString(value)
}

.rs.rai.nowUtc <- function()
{
   format(Sys.time(), "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC")
}

# Append one record to today's owner-only JSONL trace. Returns the stored
# (file, seq) link, or NULL when the durable write could not be completed.
.rs.rai.appendTrace <- function(event, fields = list())
{
   traceDir <- tryCatch(.rs.rai.traceDir(), error = function(error) NULL)
   if (is.null(traceDir))
      return(NULL)
   state <- .rs.rai.dataState
   seq <- state$traceSeq + 1L
   path <- file.path(traceDir, paste0("rai-trace-", format(Sys.time(), "%Y%m%d", tz = "UTC"), ".jsonl"))
   if (file.exists(path) && nzchar(Sys.readlink(path)))
      return(NULL)
   record <- c(list(schema = "rai-trace/1", seq = seq, time = .rs.rai.nowUtc(),
                    pid = Sys.getpid(), event = event), fields)
   line <- tryCatch(.rs.rai.toJson(record), error = function(error) NULL)
   if (is.null(line))
      return(NULL)
   existed <- file.exists(path)
   ok <- tryCatch({
      con <- file(path, open = "ab")
      on.exit(close(con), add = TRUE)
      writeBin(charToRaw(paste0(line, "\n")), con)
      TRUE
   }, error = function(error) FALSE)
   if (!isTRUE(ok))
      return(NULL)
   if (!existed)
      .rs.rai.chmodOwnerOnly(path, "0600")
   state$traceSeq <- seq
   list(file = path, seq = seq)
}

# Snapshot of every .GlobalEnv binding (hidden names included) by name and
# identity, taken natively WITHOUT forcing promises or active bindings. Without
# the native helper only names are known; identities are then NA and every
# existing name is treated as an original (fail closed).
.rs.rai.globalSnapshot <- function()
{
   native <- tryCatch(.Call("rs_raiGlobalBindingSnapshot", PACKAGE = "(embedding)"),
                      error = function(error) NULL)
   if (is.list(native) && is.character(native$names) && is.character(native$identities) &&
       length(native$names) == length(native$identities))
      return(list(names = native$names, identities = native$identities, complete = TRUE))
   names <- ls(globalenv(), all.names = TRUE, sorted = TRUE)
   list(names = names, identities = rep(NA_character_, length(names)), complete = FALSE)
}

# An existing binding is an original unless an Assistant run created it and its
# identity is still the one that run recorded (a user rebinding makes it the
# user's again). Unknown identity fails closed.
.rs.rai.isProtectedOriginal <- function(name, snapshot)
{
   index <- match(name, snapshot$names)
   if (is.na(index))
      return(FALSE)
   if (name %in% .rs.rai.sessionBookkeeping)
      return(FALSE)
   identity <- snapshot$identities[[index]]
   authorized <- .rs.rai.dataState$authorized
   if (exists(name, envir = authorized, inherits = FALSE))
   {
      record <- get(name, envir = authorized, inherits = FALSE)
      if (!is.na(identity) && identical(record$identity, identity))
         return(FALSE)
   }
   derived <- .rs.rai.dataState$derived
   if (!exists(name, envir = derived, inherits = FALSE))
      return(TRUE)
   is.na(identity) || !identical(get(name, envir = derived, inherits = FALSE), identity)
}

.rs.rai.authorizedExisting <- function(name, snapshot)
{
   index <- match(name, snapshot$names)
   if (is.na(index) || is.na(snapshot$identities[[index]]))
      return(FALSE)
   authorized <- .rs.rai.dataState$authorized
   exists(name, envir = authorized, inherits = FALSE) &&
      identical(get(name, envir = authorized, inherits = FALSE)$identity,
                snapshot$identities[[index]])
}

.rs.rai.allowedDerivedKind <- function(value, kind)
{
   if (identical(kind, "helper"))
      return(identical(typeof(value), "closure"))
   if (identical(kind, "path"))
      return(is.character(value) && length(value) == 1L && !is.na(value) &&
                nzchar(value) && !.rs.rai.isEnvironmentFile(value))
   if (identical(kind, "plots"))
      return(is.list(value) && !is.data.frame(value) && length(value) >= 1L &&
                length(value) <= 256L &&
                all(vapply(value, function(plot)
                   any(class(plot) %in% c("ggplot", "grob", "trellis", "recordedplot")),
                   logical(1L))))
   FALSE
}

# A fresh, valid binding is authorized without a consent card. Type/identity
# are native evidence, not proof of historical derivation. The existing grant
# path rechecks the pinned binding; old decisions are not migrated or replayed.
.rs.rai.authorizeDerivedBinding <- function(name, kind)
{
   if (!is.character(name) || length(name) != 1L || is.na(name) ||
       !grepl("^[A-Za-z.][A-Za-z0-9._]{0,127}$", name) || startsWith(name, ".rs.") ||
       !is.character(kind) || length(kind) != 1L || is.na(kind) ||
       !kind %in% c("plots", "helper", "path"))
      return(list(status = "error", message = "invalid derived binding name or kind"))
   snapshot <- .rs.rai.globalSnapshot()
   index <- match(name, snapshot$names)
   if (is.na(index) || !isTRUE(snapshot$complete))
      return(list(status = "error", message = "binding provenance is unavailable"))
   identity <- snapshot$identities[[index]]
   if (is.na(identity) || !startsWith(identity, "value:"))
      return(list(status = "error", message = "binding is not a normal realized value"))
   value <- get(name, envir = globalenv(), inherits = FALSE)
   if (!.rs.rai.allowedDerivedKind(value, kind))
      return(list(status = "error", message = "binding type is not a verified derived plot/helper/path"))
   target <- list(path = name, domain = "derived-binding")
   digest <- .rs.rai.proposalDigest("authorize_derived", target,
                                  paste(name, kind, identity, sep = "\r"))
   state <- .rs.rai.grantState
   key <- .rs.rai.requestKey("authorize_derived", target)
   if (exists(key, envir = state$requests, inherits = FALSE))
   {
      prior <- get(key, envir = state$requests, inherits = FALSE)
      if (is.null(prior$decision) || identical(prior$decision, "applying"))
         return(list(status = if (is.null(prior$decision) && identical(prior$digest, digest))
            "approval_required" else "error",
            message = if (is.null(prior$decision) && identical(prior$digest, digest))
               paste0("approval_required: ", prior$requestId) else
               "existing derived request remains pending or applying"))
      if (identical(prior$digest, digest) &&
          (!identical(prior$decision, "allow") || !.rs.rai.authorizedExisting(name, snapshot)))
         return(list(status = "error", message = "derived request already decided; submit a fresh binding proposal"))
   }
   if (.rs.rai.authorizedExisting(name, snapshot))
      return(list(status = "authorized", name = name, kind = kind))

   # Use the existing pinned one-time grant machinery, without emitting a UI
   # request. No native mutation is delegated to a new client callback.
   requestId <- paste0("rai-", basename(tempfile()))
   request <- list(requestId = requestId, tool = "authorize_derived", target = target,
      digest = digest, derived_authorization = list(name = name, kind = kind, identity = identity),
      auto_approve = TRUE, created_at = Sys.time(), decision = NULL)
   assign(key, request, envir = state$requests)
   result <- tryCatch({
      if (!isTRUE(.rs.rai.autoApproveReadOnlyEnabled()))
         stop("automatic approval unavailable", call. = FALSE)
      .rs.rai.recordGrant(requestId, "allow", "once")
   }, error = function(error) list(status = "error", message = "derived authorization unavailable"))
   if (!identical(result$status, "granted"))
   {
      request <- get(key, envir = state$requests, inherits = FALSE)
      if (is.null(request$decision))
      {
         request$decision <- "failed"
         assign(key, request, envir = state$requests)
      }
      return(result)
   }
   list(status = "authorized", name = name, kind = kind)
}

# Calls refused outright: shell/process escapes, file destruction or in-place
# changes, uninspectable code loading, interactive data editors, and IDE/session
# internals that could mutate buffers or state outside the run boundary.
.rs.rai.dataGuardRefusedCalls <- c(
   "system", "system2", "shell", "shell.exec", "pipe",
   # Install hooks and library mutation are not derived-data creation.
   "install.packages", "update.packages", "remove.packages", "install",
   "pkg_install", "pkg_update", "pkg_remove", "pkg_upgrade",
   "install_github", "install_gitlab", "install_bitbucket", "install_local",
   "install_url", "install_version", "install_bioc",
   "file.remove", "unlink", "file.rename", "file.append", "file.symlink", "file.link",
   "Sys.chmod", "Sys.umask", "Sys.setFileTime", "Sys.junction",
   "sink", "capture.output", "save.image", "source", "sys.source",
   "setwd", "with_dir", "local_dir", "Sys.setenv", "Sys.unsetenv", "Sys.setlocale",
   "options", "trace", "untrace", "serialize", "write.dcf", "write_yaml",
   "data",
   "fix", "edit", "de", "data.entry", "dataentry", "edit.data.frame", "edit.matrix",
   "file.edit", "vi", "emacs", "pico", "xedit", "xemacs",
   "lockBinding", "unlockBinding", "lockEnvironment", "attach",
   "insertText", "modifyRange", "setDocumentContents", "documentSave", "documentSaveAll",
   "sendToConsole", "executeCommand",
   "globalenv", "as.environment", "pos.to.env", "sys.frame", "sys.frames",
   "parent.frame", "topenv", "environment", "list2env", "parent.env<-", "environment<-",
   # code built from strings is not inspectable by this static policy
   "eval", "evalq", "eval.parent", "parse", "str2lang", "str2expression", "reg.finalizer",
   # Dynamic lookup / compiled code can hide mutating calls in nested closures.
   "get", "get0", "mget", "match.fun", "getExportedValue", "as.call",
   ".Call", ".External", ".C", ".Fortran", "dyn.load", "loadNamespace")
assign(".rs.rai.dataGuardRefusedCalls", .rs.rai.dataGuardRefusedCalls, envir = .rs.toolsEnv())

# Namespaces whose every function is refused (process spawning, IDE control,
# file destruction, rendering that executes other files' code).
.rs.rai.dataGuardRefusedNamespaces <- c("processx", "sys", "callr", "rstudioapi", "fs", "withr",
   "reticulate", "ps", "parallel", "keyring", "gitcreds", "askpass", "dotenv",
   "Rcpp", "RcppArmadillo", "RcppEigen", "cpp11", "inline", "V8", "httpuv", "rJava", "plumber", "servr",
   "testthat", "devtools", "pkgload", "pkgbuild", "roxygen2", "usethis", "remotes", "pak")
assign(".rs.rai.dataGuardRefusedNamespaces", .rs.rai.dataGuardRefusedNamespaces, envir = .rs.toolsEnv())

.rs.rai.dataGuardRefusedQualified <- c(
   "rmarkdown::render", "knitr::knit", "knitr::purl", "knitr::spin", "knitr::knit2html",
   "quarto::quarto_render", "devtools::source_url", "devtools::load_all", "pkgload::load_all", "tools::Rcmd",
   "testthat::test_check", "devtools::test", "devtools::check", "devtools::document", "devtools::install",
   "renv::install", "renv::update", "renv::restore", "renv::hydrate",
   "renv::repair", "renv::snapshot", "pak::pkg_install", "pak::pkg_update",
   "pak::pkg_remove", "BiocManager::install", "BiocManager::update",
   "utils::unzip", "utils::untar", "unzip", "untar")
assign(".rs.rai.dataGuardRefusedQualified", .rs.rai.dataGuardRefusedQualified, envir = .rs.toolsEnv())

# Functions that write a file: argument name, position, and the destination R
# uses when the argument is omitted ("" = stdout, NA = argument is required).
.rs.rai.dataGuardWriters <- list(
   write.csv = list("file", 2L, ""), write.csv2 = list("file", 2L, ""),
   write.table = list("file", 2L, ""), write = list("file", 2L, "data"),
   writeLines = list("con", 2L, ""), writeBin = list("con", 2L, NA),
   writeChar = list("con", 2L, NA), cat = list("file", NA_integer_, ""),
   saveRDS = list("file", 2L, NA), save = list("file", NA_integer_, NA),
   dput = list("file", 2L, ""), dump = list("file", 2L, "dumpdata.R"),
   download.file = list("destfile", 2L, NA), file.copy = list("to", 2L, NA),
   file.create = list("...", 1L, NA), dir.create = list("path", 1L, NA),
   png = list("filename", 1L, "Rplot%03d.png"), jpeg = list("filename", 1L, "Rplot%03d.jpeg"),
   bmp = list("filename", 1L, "Rplot%03d.bmp"), tiff = list("filename", 1L, "Rplot%03d.tiff"),
   pdf = list("file", 1L, "Rplots.pdf"), svg = list("filename", 1L, "Rplot%03d.svg"),
   cairo_pdf = list("filename", 1L, "Rplot%03d.pdf"), postscript = list("file", 1L, "Rplots.ps"),
   ggsave = list("filename", 1L, NA),
   write_csv = list("file", 2L, NA), write_tsv = list("file", 2L, NA),
   write_delim = list("file", 2L, NA), write_rds = list("file", 2L, NA),
   write_lines = list("file", 2L, NA), write_file = list("file", 2L, NA),
   fwrite = list("file", 2L, ""), write_parquet = list("sink", 2L, NA),
   write_feather = list("sink", 2L, NA), write_xlsx = list("path", 2L, NA),
   write.xlsx = list("file", 2L, NA), saveWorkbook = list("file", 2L, NA),
   write_sav = list("path", 2L, NA), write_dta = list("path", 2L, NA),
   write_xpt = list("path", 2L, NA), write_json = list("path", 2L, NA),
   vroom_write = list("file", 2L, NA), qsave = list("file", 2L, NA),
   write_fst = list("path", 2L, NA), zip = list("zipfile", 1L, NA), tar = list("tarfile", 1L, NA))
assign(".rs.rai.dataGuardWriters", .rs.rai.dataGuardWriters, envir = .rs.toolsEnv())

# Standard namespaces require explicit operation contracts. Third-party qualified
# calls also pass the name/body and destination checks in dataGuard().
.rs.rai.dataGuardNeutralCalls <- c(
   "{", "(", "if", "for", "while", "repeat", "break", "next", "return", "function",
   "<-", "=", "<<-", "[", "[[", "$", "@", "[<-", "[[<-", "$<-", "@<-", "~",
   "+", "-", "*", "/", "^", "%%", "%/%", ":", "!", "&", "&&", "|", "||",
   "==", "!=", "<", ">", "<=", ">=", "%in%",
   "c", "list", "pairlist", "structure", "data.frame", "matrix", "array", "numeric",
   "integer", "logical", "character", "complex", "raw", "vector", "seq", "seq_len",
   "seq_along", "rep", "length", "lengths", "names", "dim", "dimnames", "nrow", "ncol",
   "rownames", "colnames", "class", "typeof", "attributes", "attr", "unclass",
   "is.null", "is.na", "is.finite", "is.numeric", "is.integer", "is.character",
   "is.logical", "is.list", "is.data.frame", "is.matrix", "is.function", "is.environment",
   "as.numeric", "as.integer", "as.character", "as.logical", "as.double", "as.vector",
   "as.data.frame", "as.matrix", "factor", "levels", "droplevels", "I", "identity",
   "force", "invisible", "local", "new.env", "assign", "delayedAssign", "makeActiveBinding",
   "rm", "remove", "data", "load", "lapply", "sapply", "vapply", "apply", "tapply",
   "Map", "mapply", "Reduce", "Filter", "Find", "Position", "Negate", "do.call",
   "sum", "mean", "min", "max", "range", "prod", "all", "any", "median", "sd", "var",
   "round", "signif", "abs", "sqrt", "log", "log2", "log10", "exp", "floor", "ceiling",
   "trunc", "sign", "pmin", "pmax", "cumsum", "cumprod", "diff", "scale", "cor", "cov",
   "head", "tail", "subset", "transform", "aggregate", "ave", "merge", "rbind", "cbind",
   "sort", "order", "rank", "unique", "duplicated", "match", "which", "which.max", "which.min",
   "paste", "paste0", "sprintf", "format", "print", "summary", "str", "message", "warning", "stop",
   "stopifnot", "try", "tryCatch", "withCallingHandlers", "suppressWarnings", "suppressMessages",
   "file.path", "basename", "dirname", "normalizePath", "path.expand", "tempfile", "tempdir",
   "getwd", "file.exists", "dir.exists", "file.info", "file.access", "list.files", "list.dirs",
   "Sys.getenv", "Sys.time", "Sys.Date", "Sys.getlocale", "getOption", "quote", "substitute",
   "deparse", "expression", "alist", "missing", "isTRUE", "isFALSE", "identical", "all.equal",
   "grepl", "grep", "sub", "gsub", "strsplit", "substr", "substring", "nchar", "nzchar",
   "tolower", "toupper", "trimws", "startsWith", "endsWith", "setNames", "copy",
   "toTitleCase", "lm", "glm", "predict", "coef", "unname")
assign(".rs.rai.dataGuardNeutralCalls", .rs.rai.dataGuardNeutralCalls, envir = .rs.toolsEnv())

# Functions whose first argument is recorded as an observed file input.
.rs.rai.dataGuardReaders <- c(
   "read.csv", "read.csv2", "read.table", "read.delim", "read.delim2", "readRDS", "readLines",
   "scan", "load", "file", "read_csv", "read_tsv", "read_delim", "read_rds", "read_lines",
   "read_file", "read_excel", "read_xlsx", "read_xls", "fread", "read_parquet", "read_feather",
   "read_sav", "read_dta", "read_sas", "read_xpt", "read_json", "fromJSON", "qread",
   "vroom", "read_fst", "read.xlsx", "readWorkbook")
assign(".rs.rai.dataGuardReaders", .rs.rai.dataGuardReaders, envir = .rs.toolsEnv())

# data.table and similar by-reference mutators: first argument is modified in place.
.rs.rai.dataGuardByReference <- c(
   "set", "setattr", "setnames", "setkey", "setkeyv", "setorder", "setorderv", "setcolorder",
   "setDT", "setDF", "setindex", "setindexv", "alloc.col", "setalloccol", "setDTthreads")
assign(".rs.rai.dataGuardByReference", .rs.rai.dataGuardByReference, envir = .rs.toolsEnv())

# A plain `name <- reader(...)` (or `name <- pkg::reader(...)`) assignment
# materializes an ORIGINAL file's content into a brand-new binding: it is not
# a derived computation, and the resulting binding must stay protected from
# later direct mutation exactly like any other original object. Without this,
# a run that merely loads a file (e.g. `orig <- utils::read.csv(...)`) got
# recorded as "Assistant-derived", which let a LATER run rebind/mutate that
# same name directly (`orig$v <- 0`) and pass the original-data guard --
# confirmed defect: trace showed run_queued/run_completed with no refusal and
# the loaded object's later read-back no longer matched the source file. This
# is a structural, no-eval classification of the RHS call head only -- it
# never evaluates or inspects argument values.
.rs.rai.readerCallHeadName <- function(node)
{
   if (!is.call(node))
      return(NA_character_)
   head <- node[[1L]]
   if (is.symbol(head))
      headName <- as.character(head)
   else if (is.call(head) && is.symbol(head[[1L]]) &&
            as.character(head[[1L]]) %in% c("::", ":::") && length(head) == 3L)
      headName <- as.character(head[[3L]])
   else
      return(NA_character_)
   if (headName %in% .rs.rai.dataGuardReaders) headName else NA_character_
}
assign(".rs.rai.readerCallHeadName", .rs.rai.readerCallHeadName, envir = .rs.toolsEnv())

# A wrapper can return the original reader's object unchanged (identity(),
# local(), a user helper, etc.). Conservatively keep any new binding whose RHS
# contains a reader call in the original-data class; do not label it derived
# merely because the outermost call is not read.csv()/readRDS().
.rs.rai.containsReaderCall <- function(node)
{
   if (!is.call(node) && !is.pairlist(node))
      return(FALSE)
   if (is.call(node) && !is.na(.rs.rai.readerCallHeadName(node)))
      return(TRUE)
   children <- as.list(node)
   if (is.call(node))
      children <- children[-1L]
   any(vapply(children, .rs.rai.containsReaderCall, logical(1L)))
}
assign(".rs.rai.containsReaderCall", .rs.rai.containsReaderCall, envir = .rs.toolsEnv())

# Fold a destination expression built only from string literals, file.path(),
# paste()/paste0() and tempdir()/tempfile(). Anything else is unresolvable.
.rs.rai.foldPath <- function(node)
{
   if (is.character(node) && length(node) == 1L && !is.na(node))
      return(list(path = node, fresh = FALSE))
   if (!is.call(node) || !is.symbol(node[[1L]]))
      return(NULL)
   head <- as.character(node[[1L]])
   if (identical(head, "tempfile"))
   {
      matched <- tryCatch(match.call(base::tempfile, node, expand.dots = FALSE),
                          error = function(e) NULL)
      if (is.null(matched)) return(NULL)
      arguments <- as.list(matched)[-1L]
      pattern <- if ("pattern" %in% names(arguments)) arguments[["pattern"]] else "file"
      extension <- if ("fileext" %in% names(arguments)) arguments[["fileext"]] else ""
      tokens <- list(pattern, extension)
      if (!all(vapply(tokens, function(value) is.character(value) &&
          length(value) == 1L && !is.na(value) &&
          !grepl("/", value, fixed = TRUE) && !grepl("\\", value, fixed = TRUE), logical(1L))))
         return(NULL)
      directory <- if ("tmpdir" %in% names(arguments))
         .rs.rai.foldPath(arguments[["tmpdir"]]) else list(path = tempdir(), fresh = FALSE)
      if (is.null(directory) || isTRUE(directory$fresh) || !nzchar(directory$path))
         return(NULL)
      return(list(path = directory$path, fresh = TRUE, pattern = pattern, extension = extension))
   }
   if (identical(head, "tempdir") && length(node) == 1L)
      return(list(path = tempdir(), fresh = FALSE))
   if (!head %in% c("file.path", "paste0", "paste"))
      return(NULL)
   args <- as.list(node)[-1L]
   argNames <- names(args)
   if (is.null(argNames))
      argNames <- rep("", length(args))
   values <- list()
   sep <- if (identical(head, "paste")) " " else if (identical(head, "file.path")) "/" else ""
   for (i in seq_along(args))
   {
      if (identical(head, "paste") && identical(argNames[[i]], "sep") &&
          is.character(args[[i]]) && length(args[[i]]) == 1L)
      {
         sep <- args[[i]]
         next
      }
      if (nzchar(argNames[[i]]))
         return(NULL)
      folded <- .rs.rai.foldPath(args[[i]])
      if (is.null(folded) || isTRUE(folded$fresh))
         return(NULL)
      values[[length(values) + 1L]] <- folded$path
   }
   if (!length(values))
      return(NULL)
   list(path = paste(unlist(values), collapse = sep), fresh = FALSE)
}

# Resolve one call argument by name or position without evaluating anything.
.rs.rai.callArgument <- function(node, name, position)
{
   args <- as.list(node)[-1L]
   argNames <- names(args)
   if (is.null(argNames))
      argNames <- rep("", length(args))
   if (!is.na(name) && name %in% argNames)
      return(list(present = TRUE, value = args[[which(argNames == name)[[1L]]]]))
   if (!is.na(position))
   {
      positional <- which(!nzchar(argNames))
      if (length(positional) >= position)
         return(list(present = TRUE, value = args[[positional[[position]]]]))
   }
   list(present = FALSE, value = NULL)
}

# Root binding an assignment/replacement target resolves to: a name, or NA
# when it is computed (and therefore cannot be checked).
.rs.rai.assignmentRoot <- function(lhs)
{
   while (is.call(lhs))
   {
      if (length(lhs) < 2L)
         return(NA_character_)
      lhs <- lhs[[2L]]
   }
   if (is.symbol(lhs))
      return(as.character(lhs))
   if (is.character(lhs) && length(lhs) == 1L && !is.na(lhs))
      return(lhs)
   NA_character_
}

# Static policy walk. Returns list(ok, reason, inputs, targets, files_read,
# files_written). `local` is TRUE inside a function body or local(), where
# plain assignment binds a local variable rather than a .GlobalEnv binding.
.rs.rai.dataGuard <- function(expr, snapshot, workingDir = getwd())
{
   acc <- new.env(parent = emptyenv())
   acc$reason <- NULL
   acc$inputs <- character(0)
   acc$targets <- character(0)
   # Targets assigned directly from a reader call's return value (a new binding
   # materializing an ORIGINAL file's content): these must be treated as
   # original data from that point on, never as Assistant-derived, so a later
   # run cannot rebind/mutate them and pass the original-data guard.
   acc$originalTargets <- character(0)
   acc$filesRead <- character(0)
   acc$filesWritten <- character(0)
   acc$inspectingCallees <- character(0)
   acc$localBindings <- NULL
   walkNodes <- 0L

   refuse <- function(message)
   {
      if (is.null(acc$reason))
         acc$reason <- message
      TRUE
   }

   resolvePath <- function(path)
   {
      if (!nzchar(path))
         return(path)
      expanded <- path.expand(path)
      if (!grepl("^(/|[A-Za-z]:)", expanded))
         expanded <- file.path(workingDir, expanded)
      # A not-yet-existing file is not resolved through symlinks by
      # normalizePath(); resolve its (existing) directory instead so the
      # recorded destination is the real path later fingerprinted.
      if (file.exists(expanded))
         return(normalizePath(expanded, winslash = "/", mustWork = FALSE))
      file.path(normalizePath(dirname(expanded), winslash = "/", mustWork = FALSE), basename(expanded))
   }

   protectedPathMessage <- paste0("refused: the proposal names a protected environment, credential or system ",
                                  "path; the Assistant neither reads nor changes those locations")
   environmentValueMessage <- paste0("refused: Sys.getenv() reads only literal, non-secret names; it cannot be ",
                                     "listed, passed as a value or given a computed name")

   internalsMessage <- paste0("refused: .rs.* RStudio internals cannot be referenced as values; ",
                              "they are outside the Assistant's R Console scope")

   protectedPath <- function(text)
      !is.na(text) && nzchar(text) &&
         (.rs.rai.isProtectedLocation(text) || .rs.rai.isProtectedLocation(resolvePath(text)))

   protectedLiteral <- function(text)
      !is.na(text) && (startsWith(text, "~") || grepl("/", text, fixed = TRUE) ||
                       grepl("\\", text, fixed = TRUE)) && protectedPath(text)

   scanLiterals <- function(node, isHead = FALSE)
   {
      if (is.symbol(node))
      {
         name <- as.character(node)
         if (!isHead && startsWith(name, ".rs."))
            return(refuse(internalsMessage))
         return(!isHead && identical(name, "Sys.getenv") && refuse(environmentValueMessage))
      }
      if (is.character(node))
      {
         if (any(node == "Sys.getenv", na.rm = TRUE))
            return(refuse(environmentValueMessage))
         if (any(startsWith(node, ".rs."), na.rm = TRUE))
            return(refuse(internalsMessage))
         if (any(vapply(node, protectedLiteral, logical(1L))))
            return(refuse(protectedPathMessage))
         return(FALSE)
      }
      if (is.pairlist(node) || is.expression(node))
         return(any(vapply(as.list(node), scanLiterals, logical(1L))))
      if (!is.call(node))
         return(FALSE)
      head <- node[[1L]]
      if (is.symbol(head) && as.character(head) %in% c("::", ":::") && length(node) == 3L)
         return(!isHead && identical(as.character(node[[3L]]), "Sys.getenv") && refuse(environmentValueMessage))
      if (is.symbol(head) && as.character(head) %in% c("file.path", "paste", "paste0"))
      {
         folded <- .rs.rai.foldPath(node)
         if (!is.null(folded) && !isTRUE(folded$fresh) && protectedLiteral(folded$path))
            return(refuse(protectedPathMessage))
      }
      any(scanLiterals(head, TRUE), vapply(as.list(node)[-1L], scanLiterals, logical(1L)))
   }

   # A small provenance lattice, not an R evaluator. Unknown/unsupported
   # results remain read-only originals at both this proposal and later runs.
   # original-value distinguishes inspected value-only data from references;
   # only explicit value transforms/deep copies may discard its lineage.
   acc$bindings <- list()
   acc$nextFrame <- 0L
   acc$frames <- list(global = list())
   acc$nextForward <- 0L
   frameId <- function(scope) .rs.rai.orElse(attr(scope, "frame_id", exact = TRUE), "global")
   rememberScope <- function(scope) acc$frames[[frameId(scope)]] <- scope
   provenanceState <- function(value)
   {
      if (isTRUE(value)) "original" else if (identical(value, FALSE)) "fresh" else
         if (is.character(value) && length(value) == 1L &&
             value %in% c("fresh", "original-value", "original", "unknown")) as.character(value)[[1L]] else "unknown"
   }
   normalizedState <- function(value)
   {
      state <- provenanceState(value)
      # One scalar lattice tag plus bounded evidence. Unknown retains possible
      # callable lineage; losing exact identity never proves non-callability.
      for (key in c("columns", "copyable", "callable", "lexical", "lexical_frame", "core_callable", "numeric_plain", "numeric_columns", "element_numeric_plain", "column_vector", "row_schema_safe"))
         if (!is.null(attr(value, key, exact = TRUE))) attr(state, key) <- attr(value, key, exact = TRUE)
      if (isTRUE(attr(value, "may_callable", exact = TRUE)) || !is.null(attr(value, "callable", exact = TRUE)))
         attr(state, "may_callable") <- TRUE
      state
   }
   joinProvenance <- function(states)
   {
      values <- if (is.character(states) && length(states) == 1L) list(states) else as.list(states)
      values <- lapply(values, normalizedState)
      tags <- vapply(values, provenanceState, character(1L))
      joined <- if ("original" %in% tags) "original" else if ("unknown" %in% tags) "unknown" else
         if ("original-value" %in% tags) "original-value" else "fresh"
      for (key in c("columns", "copyable", "callable", "lexical", "lexical_frame", "core_callable", "numeric_plain", "numeric_columns", "element_numeric_plain", "column_vector", "row_schema_safe"))
      {
         metadata <- lapply(values, attr, which = key, exact = TRUE)
         if (length(metadata) && !is.null(metadata[[1L]]) &&
             all(vapply(metadata, identical, logical(1L), metadata[[1L]])))
            attr(joined, key) <- metadata[[1L]]
      }
      if (any(vapply(values, function(value) isTRUE(attr(value, "may_callable", exact = TRUE)), logical(1L))))
         attr(joined, "may_callable") <- TRUE
      joined
   }
   protectedOriginal <- function(name)
   {
      if (name %in% names(acc$localBindings))
         return(!identical(provenanceState(acc$localBindings[[name]]), "fresh"))
      if (isTRUE(attr(acc$localBindings,"closed_unknown",exact=TRUE))) return(TRUE)
      name %in% acc$originalTargets ||
         (name %in% names(acc$bindings) && !identical(provenanceState(acc$bindings[[name]]), "fresh")) ||
         .rs.rai.isProtectedOriginal(name, snapshot)
   }
   # Inspect only native-realized ordinary values; never force a promise/active
   # binding or traverse an environment. Bounded list/attribute inspection is
   # sufficient to exclude reference-bearing columns from fresh transforms.
   valueOnly <- function(value, depth = 0L)
   {
      provenanceNodes <<- provenanceNodes + 1L
      if (provenanceNodes > 4096L || depth > 64L ||
          !(is.atomic(value) || is.null(value) || is.list(value))) return(FALSE)
      if (is.list(value) && !all(vapply(unclass(value), valueOnly, logical(1L), depth = depth + 1L)))
         return(FALSE)
      attrs <- attributes(value)
      # data.table's internal self-reference is managed by its explicit copy();
      # do not confuse it with a reference-bearing data column/other attribute.
      if (is.data.frame(value) && "data.table" %in% class(value))
         attrs <- attrs[setdiff(names(attrs), ".internal.selfref")]
      is.null(attrs) || all(vapply(attrs, valueOnly, logical(1L), depth = depth + 1L))
   }
   # Scalar type/class witnesses, independent of original/fresh lineage.
   # Native-realized values only; never invoke class methods to inspect them.
   plainNumeric <- function(value)
      typeof(value) %in% c("integer", "double", "logical", "complex") &&
         is.null(attr(value, "class", exact=TRUE)) && !isS4(value)
   plainColumnVector <- function(value)
      is.atomic(value) && is.null(attr(value, "dim", exact=TRUE)) &&
         is.null(attr(value, "class", exact=TRUE)) && !isS4(value)
   uniqueColumnNames <- function(names, count)
      !is.null(names) && length(names) == count && count <= 256L &&
         !anyNA(names) && all(nzchar(names)) && !anyDuplicated(names)
   numericState <- function(state, value)
   {
      if (plainNumeric(value)) attr(state, "numeric_plain") <- TRUE
      if (plainColumnVector(value)) attr(state, "column_vector") <- TRUE
      if (is.data.frame(value) && !isS4(value) &&
          identical(attr(value, "class", exact=TRUE), "data.frame"))
      {
         columns <- unclass(value)
         # Name lookup must identify exactly one actual column, never a numeric
         # sibling of a classed duplicate. A matrix/list can expand on construction.
         if (uniqueColumnNames(names(columns), length(columns)))
         {
            attr(state, "numeric_columns") <- names(columns)[vapply(columns, plainNumeric, logical(1L))]
            if (all(vapply(columns, plainColumnVector, logical(1L))))
               attr(state, "row_schema_safe") <- TRUE
         }
      }
      state
   }
   provenanceNodes <- 0L
   bindingProvenance <- function(name, bindings)
   {
      if (!nzchar(name)) return("unknown") # missing index/formal, never exists("")
      # Keep bounded column/copy metadata on states; only tag comparisons strip it.
      if (name %in% names(bindings)) return(normalizedState(bindings[[name]]))
      if (isTRUE(attr(bindings, "closed_unknown", exact = TRUE)))
         return(if (headAvailable(name,bindings)) "fresh" else "unknown")
      if (name %in% names(acc$bindings)) return(normalizedState(acc$bindings[[name]]))
      index <- match(name, snapshot$names)
      if (is.na(index))
         return(if (exists(name, envir = baseenv(), mode = "function") ||
                    exists(name, envir = asNamespace("stats"), mode = "function", inherits = FALSE))
                   "fresh" else "unknown")
      identity <- snapshot$identities[[index]]
      if (is.na(identity) || !startsWith(identity, "value:")) return("unknown")
      # Snapshot metadata can outlive a binding. Never force an absent,
      # active or delayed value while classifying a read-only alias.
      live <- tryCatch(.Call("rs_raiGlobalBindingSnapshot", PACKAGE="(embedding)"),
                       error=function(e) NULL)
      liveIndex <- match(name, live$names)
      if (is.na(liveIndex) || !startsWith(live$identities[[liveIndex]], "value:"))
         return("unknown")
      value <- get(name, envir = globalenv(), inherits = FALSE)
      if (is.function(value))
         return(structure(if (.rs.rai.isProtectedOriginal(name, snapshot)) "original" else "fresh", may_callable = TRUE))
      if (!.rs.rai.isProtectedOriginal(name, snapshot))
         return(numericState(structure("fresh", columns = if (is.data.frame(value)) attr(value, "names", exact = TRUE) else NULL), value))
      if (valueOnly(value))
         numericState(structure(if (is.data.frame(value) && "data.table" %in% class(value)) "original" else "original-value",
                   columns = if (is.data.frame(value)) attr(value, "names", exact = TRUE) else NULL, copyable = TRUE), value)
      else "original"
   }
   mergeBindings <- function(left, right)
   {
      # Two untouched scopes are the same scope. Building a new empty list
      # makes a later unordered call look like its argument changed bindings.
      if (is.null(left) && is.null(right)) return(NULL)
      result <- list()
      for (name in sort(union(names(left), names(right))))
         result[[name]] <- joinProvenance(list(bindingProvenance(name, left),
                                              bindingProvenance(name, right)))
      for (key in c("frame_id", "closed_unknown", "trusted_heads"))
      {
         value <- attr(left, key, exact = TRUE)
         if (identical(value, attr(right, key, exact = TRUE))) attr(result, key) <- value
         else if (identical(key, "closed_unknown") && (isTRUE(value) || isTRUE(attr(right,key,exact=TRUE))))
            attr(result, key) <- TRUE
      }
      pending <- list()
      leftDefaults <- attr(left,"defaults",exact=TRUE);rightDefaults <- attr(right,"defaults",exact=TRUE)
      for (name in union(names(leftDefaults),names(rightDefaults)))
      {
         if (name %in% names(leftDefaults) && name %in% names(rightDefaults) &&
             !identical(leftDefaults[[name]],rightDefaults[[name]])) pending[[name]] <- quote(.rai_unknown_default())
         else pending[[name]] <- if(name %in% names(leftDefaults)) leftDefaults[[name]] else rightDefaults[[name]]
      }
      if(length(pending)) attr(result,"defaults") <- pending
      result
   }
   definingScope <- function(captured, caller)
   {
      id <- frameId(captured)
      current <- if (identical(id, "global")) acc$bindings else acc$frames[[id]]
      if (identical(frameId(caller), id)) current <- caller
      if (is.null(current)) current <- captured
      scope <- mergeBindings(captured, current)
      attr(scope, "frame_id") <- id
      scope
   }
   boundedHeads <- function(nodes)
   {
      heads <- character(0)
      scan <- function(node,depth=0L)
      {
         provenanceNodes <<- provenanceNodes + 1L
         if(provenanceNodes > 4096L || depth > 64L) return(FALSE)
         if(is.call(node))
         {
            if(is.symbol(node[[1L]])) heads <<- unique(c(heads,as.character(node[[1L]])))
            forwarded <- forwardingShape(node,list(),requireIdentity=FALSE)
            selected <- if(is.null(forwarded) || !isTRUE(forwarded$ok)) node else
               as.call(c(list(forwarded$target_head),forwarded$args))
            if(!is.null(forwarded) && isTRUE(forwarded$ok) && is.symbol(selected[[1L]]))
               heads <<- unique(c(heads,as.character(selected[[1L]])))
            contract <- callbackContract(selected,list(),requireIdentity=FALSE)
            if(!is.null(contract$matched))
               for(role in intersect(contract$names,names(contract$matched)))
               {
                  value <- contract$matched[[role]]
                  if(is.symbol(value)) heads <<- unique(c(heads,as.character(value)))
                  else if(is.character(value) && length(value)==1L && !is.na(value))
                     heads <<- unique(c(heads,value))
               }
         }
         if(is.call(node) || is.pairlist(node))
            return(all(vapply(as.list(node),scan,logical(1L),depth=depth+1L)))
         TRUE
      }
      if(all(vapply(nodes,scan,logical(1L)))) heads else character(0)
   }
   trustedHead <- function(name, environment, packages = c("base", "stats", "utils"))
   {
      for (depth in seq_len(16L))
      {
         if (identical(environment,emptyenv())) return(FALSE)
         if (exists(name,envir=environment,inherits=FALSE))
         {
            if (bindingIsActive(name,environment)) return(FALSE)
            if (identical(environment,baseenv())) return(bindingIsLocked(name,environment))
            for (package in packages)
            {
               if (!package %in% loadedNamespaces()) next
               namespace <- asNamespace(package)
               if (!exists(name,envir=namespace,inherits=FALSE) ||
                   !bindingIsLocked(name,namespace)) next
               # substitute retains the old expression even for a forced
               # promise. Compare already-realized callable values natively,
               # against the actual namespace object, without evaluating an
               # arbitrary capture, active getter, or delayed alias.
               same <- tryCatch(.Call("rs_raiRealizedBindingIdentity",environment,
                  name,namespace,PACKAGE="(embedding)"),error=function(e) FALSE)
               if (isTRUE(same)) return(TRUE)
            }
            return(FALSE)
         }
         environment <- parent.env(environment)
      }
      FALSE
   }
   headAvailable <- function(name,scope)
      !isTRUE(attr(scope,"closed_unknown",exact=TRUE)) || name %in% attr(scope,"trusted_heads",exact=TRUE)
   workspaceScope <- function(callee)
   {
      scope <- acc$bindings
      if (!identical(environment(callee), globalenv()))
      {
         # Never enumerate/force arbitrary captured environments. Parameters
         # and canonical operations remain supported; free captures unknown.
         scope <- list()
         attr(scope, "closed_unknown") <- TRUE
         heads <- boundedHeads(list(formals(callee),body(callee)))
         attr(scope, "trusted_heads") <- heads[vapply(heads,trustedHead,logical(1L),environment=environment(callee))]
      }
      attr(scope, "frame_id") <- "global"
      scope
   }
   literalCallable <- function(node)
   {
      # Only transparent parentheses and literal formals/body are supported;
      # computed/container/operator callable flow is never interpreted.
      for (i in seq_len(8L))
      {
         if (!is.call(node)) return(NULL)
         if (identical(node[[1L]], as.name("function")) && length(node) >= 3L)
            return(node)
         if (identical(node[[1L]], as.name("(")) && length(node) == 2L) node <- node[[2L]]
         else return(NULL)
      }
      NULL
   }
   coreCallee <- function(head,scope,requireIdentity=TRUE,packages=c("base","stats","utils"))
   {
      namespace <- NULL; name <- NULL
      if (is.symbol(head))
      {
         name <- as.character(head)
         if(!nzchar(name)) return(NULL)
         state <- if(name %in% names(scope)) scope[[name]] else acc$bindings[[name]]
         witness <- attr(state,"core_callable",exact=TRUE)
         if(!is.null(witness)) return(witness) # internally proved materialized callable value
         # A listed reader/writer/neutral name may still be a lazy search-path
         # export. Classify it from the locked namespace instead of refusing.
         inventoryHead <- name %in% c(.rs.rai.dataGuardNeutralCalls,
            .rs.rai.dataGuardReaders, names(.rs.rai.dataGuardWriters),
            .rs.rai.dataGuardByReference)
         if (name %in% c(names(scope),names(acc$bindings),snapshot$names) ||
             !headAvailable(name,scope) ||
             (requireIdentity && !isTRUE(attr(scope,"closed_unknown",exact=TRUE)) &&
              !trustedHead(name,globalenv(),packages) && !inventoryHead)) return(NULL)
      }
      else if (is.call(head) && identical(head[[1L]],as.name("::")) && length(head)==3L)
      { namespace <- as.character(head[[2L]]); name <- as.character(head[[3L]]) }
      else return(NULL)
      for (package in packages)
      {
         if (!is.null(namespace) && !identical(namespace,package)) next
         if (!package %in% loadedNamespaces()) next
         environment <- asNamespace(package)
         if (exists(name,envir=environment,inherits=FALSE) && bindingIsLocked(name,environment))
         {
            signature <- get(name,envir=environment,inherits=FALSE)
            if(is.function(signature)) return(list(name=name,package=package,signature=signature))
         }
      }
      NULL
   }
   safeRowIndex <- function(node, scope, depth=0L)
   {
      provenanceNodes <<- provenanceNodes + 1L
      if (provenanceNodes > 4096L || depth > 16L) return(FALSE)
      if (identical(node, quote(expr=))) return(TRUE)
      if (is.atomic(node)) return(plainColumnVector(node))
      if (is.symbol(node))
         return(isTRUE(attr(bindingProvenance(as.character(node), scope), "column_vector", exact=TRUE)))
      if (!is.call(node)) return(FALSE)
      core <- coreCallee(node[[1L]], scope)
      args <- as.list(node)[-1L]
      !is.null(core) && identical(core$package, "base") &&
         core$name %in% c("(", "c", ":", "+", "-") && length(args) <= 256L &&
         (identical(core$name, "c") ||
          length(args) == if (identical(core$name, ":")) 2L else 1L) &&
         all(vapply(args, safeRowIndex, logical(1L), scope=scope, depth=depth+1L))
   }
   rowOnlySchema <- function(args, state, scope)
   {
      # Ordinary dataframe and plain columns only; overridden/unknown methods,
      # dynamic indices, extraction, column changes and implicit drop erase proof.
      named <- names(args)
      length(args) == 4L && !is.null(named) &&
         identical(named, c("", "", "", "drop")) &&
         identical(args[[3L]], quote(expr=)) && identical(args[[4L]], FALSE) &&
         isTRUE(attr(state, "row_schema_safe", exact=TRUE)) &&
         !"[.data.frame" %in% snapshot$names && safeRowIndex(args[[2L]], scope)
   }
   callbackNumericInput <- function(contract, scope)
   {
      # Model only the canonical caller's value slot. Formula aggregate applies
      # FUN to the selected data column; group labels are not callback inputs.
      matched <- contract$matched
      if (is.null(matched)) return(FALSE)
      key <- intersect(c("X", "x"), names(matched))
      if (!length(key)) return(FALSE)
      input <- matched[[key[[1L]]]]
      if (identical(contract$core$name, "aggregate") && is.call(input) &&
          identical(input[[1L]], as.name("~")))
      {
         if (length(input) != 3L || !is.symbol(input[[2L]])) return(FALSE)
         dots <- if ("..." %in% names(matched)) as.list(matched[["..."]]) else list()
         data <- if ("data" %in% names(matched)) matched[["data"]] else dots[["data"]]
         if (is.null(data)) return(FALSE)
         state <- provenance(data, bindings=scope)$state
         return(as.character(input[[2L]]) %in% attr(state, "numeric_columns", exact=TRUE))
      }
      state <- provenance(input, bindings=scope)$state
      isTRUE(attr(state, "numeric_plain", exact=TRUE)) ||
         (contract$core$name %in% c("lapply", "sapply", "vapply") &&
          isTRUE(attr(state, "element_numeric_plain", exact=TRUE)))
   }
   readonlyCallback <- function(node,scope,inputNumeric=FALSE)
   {
      # Callable role is not data freshness. Inspect a literal, unary value
      # callback without executing its body/defaults or resolving captures.
      literal <- literalCallable(node)
      if (!is.null(literal))
      {
         parameters <- as.list(literal[[2L]])
         if (length(parameters) != 1L || identical(names(parameters), "...") ||
             !identical(parameters[[1L]], quote(expr=))) return(FALSE)
         pureValue <- function(value, depth=0L)
         {
            if (depth > 32L) return(FALSE)
            if (is.symbol(value)) return(as.character(value) %in% names(parameters))
            if (is.atomic(value) || is.null(value)) return(TRUE)
            if (!is.call(value)) return(FALSE)
            core <- coreCallee(value[[1L]], scope)
            !is.null(core) && identical(core$package, "base") &&
               core$name %in% c("(", "+", "-", "*", "/", "^", "%%", "%/%", ":") &&
               typeof(core$signature) %in% c("builtin", "special") &&
               # Parentheses/identity have no Ops dispatch. For arithmetic,
               # unrelated methods cannot dispatch on proved plain numerics;
               # uninspectable/classed inputs retain the refusal boundary.
               (identical(core$name, "(") || inputNumeric ||
                !any(startsWith(snapshot$names, "Ops."))) &&
               all(vapply(as.list(value)[-1L], pureValue, logical(1L), depth=depth+1L))
         }
         return(pureValue(literal[[3L]]))
      }
      # Other selectors retain canonical native identity and dispatch checks.
      if (is.character(node) && length(node)==1L && node %in% c("identity","mean","sum")) node <- as.name(node)
      core <- coreCallee(node,scope)
      !is.null(core) && identical(core$package,"base") && core$name %in% c("identity","mean","sum") &&
         (if (identical(core$name,"sum"))
             identical(typeof(core$signature),"builtin") &&
             (inputNumeric || (!any(startsWith(snapshot$names,"sum.")) &&
                               !any(startsWith(snapshot$names,"Summary."))))
          else !any(startsWith(snapshot$names,paste0(core$name,"."))))
   }
   callbackContract <- function(node,scope,requireIdentity=TRUE)
   {
      core <- coreCallee(node[[1L]],scope,requireIdentity=requireIdentity)
      contract <- if(is.null(core)) coreCallee(node[[1L]],scope,requireIdentity=FALSE) else core
      names <- character(0);matched <- NULL
      if(!is.null(contract) && identical(typeof(contract$signature),"closure"))
      {
         signature <- contract$signature
         if(identical(contract$package,"stats") && identical(contract$name,"aggregate"))
            signature <- get("aggregate.data.frame",asNamespace("stats"),inherits=FALSE)
         names <- intersect(names(formals(signature)),c("FUN","f"))
         if(length(names)) matched <- tryCatch(as.list(match.call(signature,node,
            expand.dots=FALSE))[-1L],error=function(error)NULL)
      }
      list(core=core,names=names,matched=matched)
   }
   validatedCallFlow <- function(node,scope)
   {
      contract <- callbackContract(node,scope)
      data <- as.list(node)[-1L];bad <- character(0)
      if(!length(contract$names))
         return(list(ok=TRUE,contract=contract,data=data,consumed=FALSE,result_flow="unmodeled"))
      if(is.null(contract$core) || is.null(contract$matched))
         return(list(ok=FALSE,contract=contract,data=data,consumed=FALSE,result_flow="unknown"))
      supplied <- intersect(contract$names,names(contract$matched))
      for(role in supplied)
         if(!readonlyCallback(contract$matched[[role]],scope,
             (any(startsWith(snapshot$names,"Ops.")) || any(startsWith(snapshot$names,"Summary.")) ||
              any(startsWith(snapshot$names,"sum."))) && callbackNumericInput(contract,scope))) bad <- c(bad,role)
      if(length(bad))
         return(list(ok=FALSE,contract=contract,data=data,bad=bad,consumed=FALSE,result_flow="unknown"))
      # Only proved readonly callback VALUE slots are consumed. Identity can
      # return callable-valued DATA: retain every data argument and all existing
      # result provenance. This contract never turns an unknown result fresh.
      list(ok=TRUE,contract=contract,data=contract$matched[setdiff(names(contract$matched),contract$names)],
         consumed=TRUE,result_flow="preserve-data-or-unknown")
   }
   orderedArguments <- function(head,args,scope)
   {
      core <- coreCallee(head,scope)
      # R builtins evaluate supplied arguments in order. The bounded unary
      # transparent operations and eager pairlist constructor have that same
      # transfer contract. Other closure/special forcing orders are unknown.
      !is.null(core) && identical(core$package,"base") &&
         (identical(typeof(core$signature),"builtin") ||
          core$name %in% c("pairlist","identity","force","I","local","(","return","try",
                           "suppressWarnings","suppressMessages") ||
          (core$name %in% c("$","@","[","[[") &&
           all(vapply(args[-1L],pureDefault,logical(1L),bindings=scope))))
   }
   argumentTransfers <- function(args,depth,scope,ordered)
   {
      children <- list();effects <- scope;uncertain <- FALSE
      for(i in seq_along(args))
      {
         input <- if(ordered) effects else scope
         child <- provenance(args[[i]],depth + 1L,input)
         children[[i]] <- child
         if(!identical(child$bindings,input))
         {
            if(ordered) effects <- refreshDefaults(child$bindings)
            else { uncertain <- TRUE;effects <- refreshDefaults(mergeBindings(effects,child$bindings)) }
         }
      }
      if(uncertain)
         for(i in seq_along(children))
         {
            children[[i]]$state <- joinProvenance(list(children[[i]]$state,"unknown"))
            children[[i]]$returns <- lapply(children[[i]]$returns,
               function(state)joinProvenance(list(state,"unknown")))
         }
      list(children=children,bindings=effects,uncertain=uncertain)
   }
   forwardingShape <- function(node,scope,requireIdentity=TRUE)
   {
      head <- node[[1L]]
      name <- if(is.symbol(head)) as.character(head) else if(is.call(head) &&
         length(head)==3L && identical(head[[1L]],as.name("::"))) as.character(head[[3L]]) else ""
      if(!identical(name,"do.call")) return(NULL)
      core <- coreCallee(head,scope,requireIdentity=requireIdentity)
      if(is.null(core) || !identical(core$package,"base")) return(list(ok=FALSE))
      matched <- tryCatch(as.list(match.call(core$signature,node,expand.dots=FALSE))[-1L],error=function(error)NULL)
      if(is.null(matched) || !all(c("what","args") %in% names(matched)) ||
         "envir" %in% names(matched) ||
         ("quote" %in% names(matched) && !identical(matched$quote,FALSE))) return(list(ok=FALSE))
      what <- matched$what
      string <- is.character(what) && length(what)==1L && !is.na(what) && nzchar(what)
      if(!string && !(is.symbol(what) || !is.null(literalCallable(what)) ||
         (is.call(what) && length(what)==3L && identical(what[[1L]],as.name("::"))))) return(list(ok=FALSE))
      values <- matched$args
      constructor <- if(is.call(values)) coreCallee(values[[1L]],scope,requireIdentity=requireIdentity) else NULL
      if(is.null(constructor) || !identical(constructor$package,"base") ||
         !constructor$name %in% c("list","pairlist")) return(list(ok=FALSE))
      args <- as.list(values)[-1L]
      if(any(vapply(args,function(value)is.symbol(value) && identical(value,as.name("...")),logical(1L))))
         return(list(ok=FALSE))
      list(ok=TRUE,target_kind=if(string) "string-late-lookup" else "captured-callable-value",
         target_head=if(string) as.name(what) else what,args=args)
   }
   materializedState <- function(node,state,scope)
   {
      core <- coreCallee(node,scope)
      if(!is.null(core)) return(structure("fresh",core_callable=core,may_callable=TRUE))
      normalizedState(state)
   }
   forwardingTransfer <- function(node,depth,scope)
   {
      shape <- forwardingShape(node,scope)
      if(is.null(shape) || !isTRUE(shape$ok)) return(shape)
      if(depth>64L || provenanceNodes>4096L) return(list(ok=FALSE))
      # Current do.call first forces args through is.list(args). The what
      # promise is forced later: strings look up a function in this post scope,
      # callable values are captured here (not before argument effects).
      post <- scope;arguments <- list();returns <- list()
      for(i in seq_along(shape$args))
      {
         input <- post
         value <- provenance(shape$args[[i]],depth + 1L,input)
         arguments[[i]] <- list(node=shape$args[[i]],state=materializedState(shape$args[[i]],value$state,input),
            input_scope=input,post_scope=value$bindings)
         post <- refreshDefaults(value$bindings)
         returns <- c(returns,value$returns)
      }
      core <- coreCallee(shape$target_head,post)
      proposed <- if(is.null(core)) proposedCallable(shape$target_head,post) else NULL
      if(is.null(core) && is.null(proposed)) return(list(ok=FALSE,post_scope=post))
      acc$nextForward <- acc$nextForward + 1L
      if(acc$nextForward>4096L) return(list(ok=FALSE))
      occupied <- unique(c(names(post),names(acc$bindings),snapshot$names,all.names(node),
         if(!is.null(proposed)) all.names(body(proposed$signature)) else character(0)))
      prefix <- paste0(".rai.materialized.",acc$nextForward,".")
      slots <- paste0(prefix,seq_len(length(arguments)+1L))
      if(any(slots %in% occupied)) return(list(ok=FALSE)) # no user binding may be shadowed by a matching slot
      dispatch <- post;nodes <- shape$args
      for(i in seq_along(arguments))
      {
         # Literal scalar values remain literal for central string/path/label
         # contracts. All other arguments are already-realized state slots.
         if(is.atomic(arguments[[i]]$node) || is.null(arguments[[i]]$node)) next
         dispatch[[slots[[i]]]] <- arguments[[i]]$state
         nodes[[i]] <- as.name(slots[[i]])
      }
      if(!is.null(core))
         head <- as.call(list(as.name("::"),as.name(core$package),as.name(core$name)))
      else
      {
         targetSlot <- slots[[length(slots)]]
         literal <- as.call(list(as.name("function"),formals(proposed$signature),body(proposed$signature)))
         dispatch[[targetSlot]] <- structure("fresh",callable=literal,lexical=proposed$lexical,may_callable=TRUE)
         head <- as.name(targetSlot)
      }
      call <- as.call(c(list(head),nodes))
      # Both consumers dispatch this SAME record through the central contract.
      # Selector strings resolve in post scope; callable slots keep the actual
      # argument-position witness even if a later argument rebinds its name.
      flow <- validatedCallFlow(call,dispatch)
      if(!isTRUE(flow$ok)) return(list(ok=FALSE,post_scope=post))
      list(ok=TRUE,target_kind=shape$target_kind,target_witness=if(is.null(core)) proposed else core,
         arguments=arguments,post_scope=post,dispatch_scope=dispatch,dispatch_call=call,
         slots=slots,returns=returns)
   }
   projectForwardingScope <- function(transfer,scope)
   {
      # Keep real post-dispatch caller deltas and its lexical/default attributes.
      # Only collision-checked materialization witnesses leave the caller frame.
      for(slot in intersect(transfer$slots,names(scope))) scope[[slot]] <- NULL
      refreshDefaults(scope)
   }
   consumeForwarding <- function(transfer,mode,depth=0L,local=FALSE)
   {
      if(identical(mode,"provenance"))
      {
         if(!isTRUE(transfer$ok)) return(list(state="unknown",bindings=.rs.rai.orElse(transfer$post_scope,acc$localBindings),returns=list()))
         out <- provenance(transfer$dispatch_call,depth + 1L,transfer$dispatch_scope)
         out$bindings <- projectForwardingScope(transfer,out$bindings)
         out$returns <- c(transfer$returns,out$returns)
         return(out)
      }
      if(!isTRUE(transfer$ok)) return(refuse("refused: do.call() materialized target or argument contract is unavailable"))
      # Check original side effects in actual order ONCE. Then validate the
      # already-materialized dispatch: it contains no original argument AST.
      for(argument in transfer$arguments)
         if(walk(argument$node,local)) return(TRUE)
      previous <- acc$localBindings
      acc$localBindings <- transfer$dispatch_scope
      on.exit({
         projected <- projectForwardingScope(transfer,acc$localBindings)
         # walkLocal already isolates helper invocations. Publish this caller's
         # frame only, never a provenance-only helper frame into the global cache.
         # Global writes live in acc$bindings; keep its temporary local overlay
         # separate so later global rebindings cannot see stale local freshness.
         acc$localBindings <- if(local) projected else previous
         if(local) rememberScope(acc$localBindings)
         acc$targets <- setdiff(acc$targets,transfer$slots)
         acc$originalTargets <- setdiff(acc$originalTargets,transfer$slots)
      },add=TRUE)
      walk(transfer$dispatch_call,local)
   }
   sequenceNonempty <- function(node,scope)
   {
      if(is.atomic(node)) return(length(node)>0L)
      if(!is.call(node)) return(FALSE)
      core <- coreCallee(node[[1L]],scope)
      !is.null(core) && identical(core$package,"base") && core$name %in% c("list","pairlist","c") &&
         length(node)>1L && !any(vapply(as.list(node)[-1L],function(value)
            is.symbol(value) && identical(value,as.name("...")),logical(1L))) &&
         (core$name %in% c("list","pairlist") ||
          all(vapply(as.list(node)[-1L],function(value)is.atomic(value) && length(value)>0L,logical(1L))))
   }
   joinLoopScopes <- function(entry,before,after,includeEntry=TRUE)
   {
      joined <- mergeBindings(before,after)
      if(includeEntry) joined <- mergeBindings(entry,joined)
      refreshDefaults(joined)
   }
   proposedCallable <- function(head, bindings)
   {
      literal <- literalCallable(head)
      state <- if (!is.null(literal)) structure("fresh", callable = literal, may_callable = TRUE,
                                              lexical = .rs.rai.orElse(bindings, acc$bindings)) else
         if (is.symbol(head)) bindingProvenance(as.character(head), bindings) else "unknown"
      literal <- attr(state, "callable", exact = TRUE)
      if (is.null(literal)) return(NULL)
      # Construct a matching-only closure; NEVER evaluate its body/defaults.
      signature <- tryCatch(as.function(c(as.list(literal[[2L]]), list(literal[[3L]])), baseenv()),
                            error = function(error) NULL)
      if (is.null(signature)) return(NULL)
      list(signature = signature, lexical = definingScope(attr(state, "lexical", exact = TRUE), bindings))
   }
   pureDefault <- function(node, bindings, depth = 0L)
   {
      provenanceNodes <<- provenanceNodes + 1L
      if (provenanceNodes > 4096L || depth > 64L) return(FALSE)
      if (is.symbol(node) || is.atomic(node) || is.null(node)) return(TRUE)
      if (!is.call(node)) return(FALSE)
      head <- node[[1L]]
      name <- if (is.symbol(head)) as.character(head) else
         if (is.call(head) && length(head) == 3L && identical(head[[1L]], as.name("::"))) as.character(head[[3L]]) else ""
      if (is.symbol(head) && (!headAvailable(name,bindings) || name %in% names(bindings) || name %in% names(acc$bindings) || name %in% snapshot$names))
         return(FALSE)
      namespace <- if (is.call(head) && length(head) == 3L) as.character(head[[2L]]) else ""
      supported <- name %in% c("{", "(", "if", "identity", "force", "$", "@", "[", "[[", "I", "list", "pairlist",
         "structure", "data.frame", "matrix", "array", "c", ":", "+", "-", "*", "/", "^", "%%", "%/%",
         "transform", "aggregate", "head", "tail", "subset", "paste", "paste0") &&
         namespace %in% c("", "base", "stats", "utils")
      if (identical(head, quote(data.table::copy))) supported <- TRUE
      supported && all(vapply(as.list(node)[-1L], pureDefault, logical(1L), bindings = bindings, depth = depth + 1L))
   }
   helperParameters <- function(signature, call, depth, bindings, lexical)
   {
      matched <- tryCatch(as.list(match.call(signature, call, expand.dots = FALSE))[-1L],
                          error = function(error) NULL)
      if (is.null(matched)) return(NULL)
      defaults <- formals(signature)
      parameters <- setNames(as.list(rep("unknown", length(defaults))), names(defaults))
      for (parameter in names(matched))
      {
         # Supplied expressions are promises in the caller. Do not fake an
         # eager proof for effects we cannot model in that frame.
         if (!pureDefault(matched[[parameter]],bindings)) return(NULL)
         parameters[[parameter]] <- provenance(matched[[parameter]],depth + 1L,bindings)$state
      }
      # R defaults are promises in the invocation frame, NOT the defining
      # frame. Match supplied arguments first; all formals shadow outer names.
      # Resolve dependent defaults to a bounded fixed point without forcing
      # promises or evaluating any expression. Cycles/unresolved stay unknown.
      pending <- list()
      for (parameter in setdiff(names(defaults), names(matched)))
      {
         value <- defaults[[parameter]]
         if (!missing(value))
         {
            if (!pureDefault(value, lexical)) return(NULL)
            pending[[parameter]] <- value
         }
      }
      for (iteration in seq_len(16L))
      {
         scope <- lexical
         for (parameter in names(parameters)) scope[[parameter]] <- parameters[[parameter]]
         nextParameters <- parameters
         for (parameter in setdiff(names(defaults), names(matched)))
         {
            value <- defaults[[parameter]]
            nextParameters[[parameter]] <- if (missing(value)) "unknown" else
               provenance(value, depth + 1L, scope)$state
         }
         if (identical(nextParameters, parameters))
         {
            attr(parameters, "defaults") <- pending
            return(parameters)
         }
         parameters <- nextParameters
      }
      NULL
   }
   refreshDefaults <- function(scope)
   {
      pending <- attr(scope, "defaults", exact = TRUE)
      if (!length(pending)) return(scope)
      for (iteration in seq_len(16L))
      {
         nextScope <- scope
         for (parameter in names(pending))
            nextScope[[parameter]] <- joinProvenance(list(scope[[parameter]], provenance(pending[[parameter]], bindings = scope)$state))
         if (identical(nextScope, scope)) return(scope)
         scope <- nextScope
      }
      for (parameter in names(pending)) scope[[parameter]] <- joinProvenance(list(scope[[parameter]], "unknown"))
      scope
   }
   bindState <- function(scope, name, state)
   {
      scope[[name]] <- normalizedState(state)
      pending <- attr(scope, "defaults", exact = TRUE)
      if (name %in% names(pending)) attr(scope, "defaults") <- pending[setdiff(names(pending), name)]
      refreshDefaults(scope)
   }
   removeStates <- function(scope, names)
   {
      for (name in names) scope <- bindState(scope,name,"unknown")
      scope
   }
   removalNames <- function(args, scope)
   {
      bad <- function(reason) list(ok=FALSE,reason=reason,names=character(0))
      argNames <- names(args)
      if (is.null(argNames)) argNames <- rep("",length(args))
      if (any(argNames %in% c("envir","pos","inherits")))
         return(bad("refused: rm() with an explicit environment"))
      targets <- character(0)
      for (i in seq_along(args))
      {
         value <- args[[i]]
         if (identical(argNames[[i]],"list"))
         {
            folded <- if (is.character(value)) value else if (is.call(value) &&
               identical(value[[1L]],as.name("c")) && headAvailable("c",scope) &&
               !"c" %in% c(names(scope),names(acc$bindings),snapshot$names) &&
               all(vapply(as.list(value)[-1L],is.character,logical(1L))))
               unlist(as.list(value)[-1L],use.names=FALSE) else NULL
            if (is.null(folded)) return(bad("refused: rm(list = ...) with computed names"))
            targets <- c(targets,folded)
         }
         else if (is.symbol(value)) targets <- c(targets,as.character(value))
         else if (is.character(value) && length(value)==1L) targets <- c(targets,value)
         else return(bad("refused: rm() with a computed argument"))
      }
      list(ok=TRUE,names=unique(targets),reason=NULL)
   }
   insertedState <- function(receiver, payload)
   {
      freshValue <- function(value)
      {
         value <- normalizedState(value)
         if (identical(provenanceState(value),"original-value"))
         {
            metadata <- attributes(value)
            value <- "fresh"
            attributes(value) <- metadata
         }
         value
      }
      joinProvenance(c(list(freshValue(receiver)),lapply(payload,freshValue)))
   }
   invocationScope <- function(lexical, parameters)
   {
      scope <- lexical
      for (parameter in names(parameters)) scope[[parameter]] <- parameters[[parameter]]
      attr(scope, "defaults") <- attr(parameters, "defaults", exact = TRUE)
      refreshDefaults(scope)
   }
   containsCallable <- function(node, depth = 0L, bindings = acc$localBindings)
   {
      walkNodes <<- walkNodes + 1L
      if (walkNodes > 4096L || depth > 64L) return(TRUE)
      # Result evidence wins BEFORE consuming a callback role. A function
      # returned by a helper/identity must not disappear from value lineage.
      if (!is.null(proposedCallable(node,bindings)) ||
          isTRUE(attr(provenance(node,bindings=bindings)$state,"may_callable",exact=TRUE))) return(TRUE)
      if (is.symbol(node) && as.character(node) %in% snapshot$names)
      {
         name <- as.character(node);identity <- snapshot$identities[[match(name,snapshot$names)]]
         if(!is.na(identity) && startsWith(identity,"value:"))
         {
            live <- tryCatch(.Call("rs_raiGlobalBindingSnapshot", PACKAGE="(embedding)"),
                             error=function(e) NULL)
            liveIndex <- match(name,live$names)
            if(!is.na(liveIndex) && startsWith(live$identities[[liveIndex]],"value:") &&
               is.function(get(name,envir=globalenv(),inherits=FALSE))) return(TRUE)
         }
      }
      if(is.pairlist(node)) return(any(vapply(as.list(node),containsCallable,logical(1L),
         depth=depth + 1L,bindings=bindings)))
      if(!is.call(node)) return(FALSE)
      if(identical(node[[1L]],as.name("::"))) return(TRUE)
      forwarded <- forwardingTransfer(node,depth,bindings)
      if(!is.null(forwarded))
      {
         if(!isTRUE(forwarded$ok)) return(TRUE)
         return(containsCallable(forwarded$dispatch_call,depth + 1L,forwarded$dispatch_scope))
      }
      flow <- validatedCallFlow(node,bindings)
      if(!isTRUE(flow$ok)) return(TRUE) # unknown/unproved callbacks cannot be consumed
      # Inspect result-bearing DATA, not the call head or identity-validated
      # consumed callback. Containers, forwarded dots and wrapped data still
      # retain callable/unknown/original lineage; provenance is unchanged.
      any(vapply(flow$data,containsCallable,logical(1L),depth=depth + 1L,bindings=bindings))
   }
   provenance <- function(node, depth = 0L, bindings = acc$localBindings)
   {
      result <- function(state, scope = bindings, returns = list())
         list(state = normalizedState(state), bindings = scope, returns = returns)
      provenanceNodes <<- provenanceNodes + 1L
      if (provenanceNodes > 4096L || depth > 64L) return(result("unknown"))
      if (is.symbol(node)) return(result(materializedState(node,bindingProvenance(as.character(node),bindings),bindings)))
      if (!is.call(node)) return(result(numericState(if (is.atomic(node) || is.null(node)) "fresh" else "unknown", node)))
      head <- node[[1L]]
      name <- if (is.symbol(head)) as.character(head) else
         if (is.call(head) && length(head) == 3L &&
             identical(head[[1L]], as.name("::"))) as.character(head[[3L]]) else ""
      args <- as.list(node)[-1L]
      if(identical(head,as.name("::")) && length(node)==3L)
      {
         selected <- coreCallee(node,bindings)
         if(!is.null(selected)) return(result(structure("fresh",core_callable=selected,may_callable=TRUE)))
      }
      forwarded <- forwardingTransfer(node,depth,bindings)
      if(!is.null(forwarded)) return(consumeForwarding(forwarded,"provenance",depth))
      namespace <- if (is.call(head) && length(head) == 3L) as.character(head[[2L]]) else ""
      if (is.symbol(head) && !headAvailable(name,bindings) && !name %in% names(bindings))
         return(result(structure("unknown",may_callable=TRUE)))
      # A local/new callable is not the canonical operation with that name.
      shadowed <- is.symbol(head) && (name %in% names(bindings) || name %in% names(acc$bindings))
      if (identical(name, "function"))
         return(result(structure("fresh", callable = node, may_callable = TRUE,
                                 lexical = .rs.rai.orElse(bindings, acc$bindings)))) # no RHS evaluation
      if (identical(name, "~")) return(result("fresh")) # literal formula, not evaluated here
      if (identical(name, "{"))
      {
         out <- result("fresh")
         for (part in args)
         {
            nextPart <- provenance(part, depth + 1L, out$bindings)
            out <- result(nextPart$state, nextPart$bindings, c(out$returns, nextPart$returns))
         }
         return(out) # all early returns retained, not just last expression
      }
      if (name %in% c("<-", "=") && length(args) == 2L)
      {
         out <- provenance(args[[2L]], depth + 1L, bindings)
         if (is.symbol(args[[1L]])) out$bindings <- bindState(out$bindings, as.character(args[[1L]]), out$state)
         else
         {
            root <- .rs.rai.assignmentRoot(args[[1L]])
            if (!is.na(root) && nzchar(root)) out$bindings <- bindState(out$bindings,root,
               insertedState(bindingProvenance(root,bindings),list(out$state)))
         }
         return(out)
      }
      if (identical(name, "if") && length(args) >= 2L)
      {
         condition <- provenance(args[[1L]], depth + 1L, bindings)
         yes <- provenance(args[[2L]], depth + 1L, condition$bindings)
         no <- if (length(args) == 3L) provenance(args[[3L]], depth + 1L, condition$bindings) else
            result("fresh", condition$bindings)
         return(result(joinProvenance(list(yes$state, no$state)),
                       mergeBindings(yes$bindings, no$bindings),
                       c(condition$returns, yes$returns, no$returns)))
      }
      if (name %in% c("for", "while", "repeat"))
      {
         scope <- bindings;entry <- bindings;iterator <- NULL;sequence <- NULL
         includeEntry <- TRUE
         parts <- args
         if (identical(name, "for") && length(args) == 3L && is.symbol(args[[1L]]))
         {
            sequence <- provenance(args[[2L]],depth + 1L,scope)
            entry <- sequence$bindings
            iterator <- as.character(args[[1L]])
            includeEntry <- !sequenceNonempty(args[[2L]],bindings)
            scope <- bindState(entry,iterator,sequence$state)
            parts <- list(args[[3L]])
         }
         returns <- list()
         # Monotone lattice iteration includes zero iterations, every back edge
         # and early return. Unresolved/budget-exhausted loops cannot earn fresh.
         for (iteration in seq_len(16L))
         {
            out <- result("fresh",if(is.null(iterator)) scope else bindState(scope,iterator,sequence$state))
            for (part in parts)
            {
               nextPart <- provenance(part, depth + 1L, out$bindings)
               out <- result("fresh", nextPart$bindings, c(out$returns, nextPart$returns))
            }
            returns <- unique(c(returns, out$returns))
            joined <- joinLoopScopes(entry,scope,out$bindings,includeEntry)
            if (identical(joined, scope)) return(result("fresh", joined, returns))
            scope <- joined
         }
         return(result("unknown", scope, c(returns, list("unknown"))))
      }
      proposed <- proposedCallable(head, bindings)
      if (!is.null(proposed))
      {
         parameters <- helperParameters(proposed$signature, node, depth, bindings, proposed$lexical)
         if (is.null(parameters)) return(result("unknown"))
         scope <- invocationScope(proposed$lexical, parameters)
         out <- provenance(body(proposed$signature), depth + 1L, scope)
         return(result(joinProvenance(c(list(out$state), out$returns))))
      }
      # Only an already identity-approved live closure may contribute a body.
      # Bound recursion/node limits handle cycles without executing any RHS.
      if (is.symbol(head) && !shadowed && name %in% snapshot$names &&
          !.rs.rai.isProtectedOriginal(name, snapshot))
      {
         identity <- snapshot$identities[[match(name, snapshot$names)]]
         if (is.na(identity) || !startsWith(identity, "value:")) return(result("unknown"))
         callee <- get(name, envir = globalenv(), inherits = FALSE)
         if (identical(typeof(callee), "closure"))
         {
            matched <- tryCatch(as.list(match.call(callee, node, expand.dots = FALSE))[-1L],
                                error = function(error) NULL)
            if (is.null(matched)) return(result("unknown"))
            lexical <- workspaceScope(callee)
            parameters <- helperParameters(callee, node, depth, bindings, lexical)
            if (is.null(parameters)) return(result("unknown"))
            out <- provenance(body(callee), depth + 1L, invocationScope(lexical, parameters))
            return(result(joinProvenance(c(list(out$state), out$returns))))
         }
      }
      # Container and transparent operations preserve contained reference
      # lineage. Unsupported/dynamic calls stay unknown, even without inputs.
      canonical <- !shadowed && (!is.symbol(head) || !name %in% snapshot$names) &&
         (identical(namespace, "") ||
          (identical(namespace, "base") && !name %in% c("aggregate", "head", "tail", "copy")) ||
          (identical(namespace, "stats") && identical(name, "aggregate")) ||
          (identical(namespace, "utils") && name %in% c("head", "tail")) ||
          (identical(namespace, "data.table") && identical(name, "copy")))
      if (canonical && is.symbol(head)) canonical <- !is.null(coreCallee(head,bindings))
      childBindings <- bindings
      # transform()'s inspected dataframe columns are a bounded lexical read
      # scope, not free global variables. Never mark unknown calls/reference
      # updates fresh merely because the outer call is a transform.
      if (canonical && identical(name, "transform") && length(args))
      {
         input <- provenance(args[[1L]], depth + 1L, bindings)$state
         for (column in attr(input, "columns")) childBindings[[column]] <- "fresh"
      }
      if (name %in% c("rm","remove") && canonical)
      {
         removed <- removalNames(args,bindings)
         if (!removed$ok) return(result("unknown"))
         return(result("fresh",removeStates(bindings,removed$names)))
      }
      # A native-identity-proved readonly callback occupies a callable role,
      # not a data column. Consume only that validated slot; result-bearing
      # arguments retain their original/unknown/reference lineage.
      flow <- validatedCallFlow(node,bindings)
      valueArgs <- if(canonical && isTRUE(flow$ok) && isTRUE(flow$consumed)) flow$data else args
      transfer <- argumentTransfers(valueArgs,depth,childBindings,
         canonical && orderedArguments(head,valueArgs,bindings))
      children <- transfer$children
      states <- lapply(children, function(child) child$state)
      effects <- if(identical(transfer$bindings,childBindings)) bindings else transfer$bindings
      returns <- do.call(c, lapply(children, function(child) child$returns))
      if (is.null(returns)) returns <- list()
      if (identical(name, "return"))
      {
         state <- joinProvenance(states)
         return(result(state,effects,c(returns,list(state))))
      }
      if (canonical && identical(name, "local") && length(children))
         return(result(joinProvenance(c(list(children[[1L]]$state), returns)), bindings, returns))
      if (canonical && identical(name, "I") && length(children))
      {
         # I() adds AsIs: lineage is unchanged, but unclassed scalar/column/
         # element evidence cannot survive this class-producing operation.
         state <- children[[1L]]$state
         for (key in c("numeric_plain", "numeric_columns", "element_numeric_plain", "column_vector", "row_schema_safe"))
            attr(state, key) <- NULL
         return(result(state,
            if(length(children)==1L) children[[1L]]$bindings else effects,returns))
      }
      if (canonical && name %in% c("$", "@", "[", "[[") && length(children))
      {
         # Extraction can return another/classed container or remove columns.
         # The receiver's numeric column schema is not proof about that result.
         state <- children[[1L]]$state
         if (!identical(name, "[") || !rowOnlySchema(valueArgs, state, bindings))
         {
            attr(state, "numeric_columns") <- NULL
            attr(state, "row_schema_safe") <- NULL
         }
         return(result(state,
            if(length(children)==1L) children[[1L]]$bindings else effects,returns))
      }
      if (canonical && name %in% c("(", "identity", "force") && length(children))
         return(result(children[[1L]]$state,
            if(length(children)==1L) children[[1L]]$bindings else effects,returns))
      if (canonical && name %in% c("list", "pairlist", "structure"))
      {
         joined <- joinProvenance(states)
         # A numeric element witness is not a numeric container witness.
         attr(joined, "numeric_plain") <- NULL
         attr(joined, "numeric_columns") <- NULL
         attr(joined, "column_vector") <- NULL
         attr(joined, "row_schema_safe") <- NULL
         if (name %in% c("list", "pairlist") && length(states) &&
             all(vapply(states,function(x)isTRUE(attr(x,"numeric_plain",exact=TRUE)),logical(1L))))
            attr(joined, "element_numeric_plain") <- TRUE
         else attr(joined, "element_numeric_plain") <- NULL
         return(result(joined,effects,returns))
      }
      # Explicit fresh value transforms are operation semantics, never names of
      # fixture/user helpers. Refuse reference/unknown-bearing inputs; a copy
      # of an environment or reference-bearing list is NOT proven deep copy.
      freshOps <- c("data.frame", "matrix", "array", "c", ":", "+", "-", "*", "/", "^", "%%", "%/%",
                    "transform", "aggregate", "head", "tail", "subset", "paste", "paste0")
      if (canonical && (name %in% freshOps || (identical(name, "copy") && is.call(head) &&
          identical(head, quote(data.table::copy)))) &&
          (all(vapply(states, provenanceState, character(1L)) %in% c("fresh", "original-value")) &&
           !any(vapply(states, function(value) isTRUE(attr(value, "may_callable", exact = TRUE)), logical(1L))) ||
           (identical(head, quote(data.table::copy)) && length(children) == 1L &&
            isTRUE(attr(children[[1L]]$state, "copyable")))))
      {
         state <- "fresh"
         if (name %in% c("c", ":", "+", "-", "*", "/", "^", "%%", "%/%") && length(states) &&
             all(vapply(states,function(x)isTRUE(attr(x,"numeric_plain",exact=TRUE)),logical(1L))))
            attr(state,"numeric_plain") <- TRUE
         if (name %in% c("c", ":", "+", "-", "*", "/", "^", "%%", "%/%") && length(states) &&
             all(vapply(states,function(x)isTRUE(attr(x,"column_vector",exact=TRUE)),logical(1L))))
            attr(state,"column_vector") <- TRUE
         if (identical(name,"data.frame") && length(states))
         {
            named <- names(valueArgs)
            controls <- c("row.names","check.rows","check.names","fix.empty.names","stringsAsFactors")
            columns <- if (is.null(named)) integer(0) else which(!named %in% controls)
            checkNames <- if (!is.null(named) && "check.names" %in% named)
               valueArgs[[match("check.names", named)]] else TRUE
            # Prove one unclassed vector per explicit unique unchanged final name.
            # Unknown/expanded/classed inputs and repaired/colliding names lose
            # schema evidence, not freshness or legitimate plain-vector workflows.
            if (length(columns) && !anyDuplicated(named[named %in% controls]) &&
                uniqueColumnNames(named[columns], length(columns)) &&
                (identical(checkNames,FALSE) || (identical(checkNames,TRUE) &&
                 identical(base::make.names(named[columns]), named[columns]))) &&
                all(vapply(states[columns],function(x)isTRUE(attr(x,"column_vector",exact=TRUE)),logical(1L))))
            {
               attr(state,"numeric_columns") <- named[columns][vapply(states[columns],
                  function(x)isTRUE(attr(x,"numeric_plain",exact=TRUE)),logical(1L))]
               stringsFactors <- if ("stringsAsFactors" %in% named)
                  valueArgs[[match("stringsAsFactors",named)]] else FALSE
               if (identical(stringsFactors,FALSE)) attr(state,"row_schema_safe") <- TRUE
            }
         }
         return(result(state,effects,returns))
      }
      result("unknown",effects,returns)
   }

   # Inspect lexical bodies with independent binding provenance. Local plain
   # assignment may shadow an original; subassignment through an original or
   # its reference alias may not. Restore the caller's scope on every return.
   walkLocal <- function(nodes, parameters = list(), lexical = acc$localBindings)
   {
      previous <- acc$localBindings
      rememberScope(.rs.rai.orElse(previous, acc$bindings))
      acc$nextFrame <- acc$nextFrame + 1L
      if (acc$nextFrame > 4096L) return(refuse("refused: lexical frame budget exceeded"))
      acc$localBindings <- invocationScope(.rs.rai.orElse(lexical, list()), parameters)
      attr(acc$localBindings, "frame_id") <- paste0("local-", acc$nextFrame)
      rememberScope(acc$localBindings)
      on.exit({ rememberScope(acc$localBindings); acc$localBindings <- previous }, add = TRUE)
      any(vapply(nodes, walk, logical(1L), local = TRUE))
   }

   checkTarget <- function(name, how)
   {
      if (is.na(name))
         return(refuse(paste0("refused: ", how, " target is computed; derived data must be ",
                              "assigned to a plain new name")))
      if (protectedOriginal(name))
         return(refuse(paste0("refused: `", name, "` is existing original data; ", how,
                              " would change it directly. Assign the transformed result to a ",
                              "NEW name (for example `", name, "_derived <- ...`)")))
      acc$targets <- unique(c(acc$targets, name))
      FALSE
   }

   checkInsertion <- function(target, values, local)
   {
      if (is.na(target)) return(refuse("refused: insertion receiver is computed"))
      states <- lapply(values, function(value) provenance(value)$state)
      # Insertion copies inspected value-only columns/scalars; only reference
      # or unknown payloads can carry a receiver alias into protected data.
      state <- insertedState(bindingProvenance(target,acc$localBindings),states)
      if (local)
      {
         acc$localBindings <- bindState(acc$localBindings,target,state)
         rememberScope(acc$localBindings)
      }
      else
      {
         acc$bindings <- bindState(acc$bindings,target,state)
         rememberScope(acc$bindings)
      }
      # Reference-bearing/unknown insertion may taint preexisting aliases of a
      # by-reference receiver. Without a proven alias graph refuse at insertion,
      # not just at a later write. Inspected scalar/value-only copies stay valid.
      if (any(vapply(states, function(value) provenanceState(value) %in% c("original", "unknown"), logical(1L))))
         return(refuse("refused: insertion contains original reference or unknown lineage; use inspected value-only data"))
      FALSE
   }

   writerCall <- function(node, forRead = FALSE)
   {
      packages <- c("base", "utils", "grDevices", "ggplot2", "readr", "data.table",
                    "arrow", "writexl", "openxlsx", "haven", "jsonlite", "vroom", "qs", "fst")
      if (forRead) packages <- c(packages, "readxl", "feather")
      callee <- coreCallee(node[[1L]], acc$localBindings, packages = packages)
      if (is.null(callee) || typeof(callee$signature) != "closure") return(NULL)
      signature <- callee$signature
      if (callee$package == "utils" && callee$name %in% c("write.csv", "write.csv2"))
         signature <- get("write.table", envir = asNamespace("utils"), inherits = FALSE)
      if (any(all.names(node) == "..." | grepl("^\\.\\.[0-9]+$", all.names(node)))) return(NULL)
      matched <- tryCatch(match.call(signature, node, expand.dots = FALSE), error = function(e) NULL)
      if (is.null(matched)) return(NULL)
      arguments <- as.list(matched)[-1L]
      dots <- arguments[["..."]]
      if (!is.null(dots))
      {
         # Concrete unnamed payloads belong to cat/save/file.create; named extras are unknown
         if (!forRead)
         {
            if (!callee$name %in% c("cat", "save", "file.create") ||
                any(nzchar(names(dots)))) return(NULL)
            arguments[["..."]] <- NULL
            arguments <- c(arguments, as.list(dots))
         }
      }
      canonical <- as.call(c(list(node[[1L]]), arguments))
      if (forRead)
         attr(canonical, "rai_reader_source") <- names(formals(signature))[[1L]]
      canonical
   }

   checkDestination <- function(node, spec, headName)
   {
      createsDirectory <- FALSE
      if (identical(headName, "ggsave"))
      {
         directory <- .rs.rai.callArgument(node, "path", NA_integer_)
         filename <- .rs.rai.callArgument(node, spec[[1L]], spec[[2L]])
         createDirectory <- .rs.rai.callArgument(node, "create.dir", NA_integer_)
         createsDirectory <- createDirectory$present && !identical(createDirectory$value, FALSE)
         if (directory$present && !is.null(directory$value) && filename$present)
            node <- as.call(list(node[[1L]], filename = call("file.path", directory$value, filename$value)))
      }
      argument <- .rs.rai.callArgument(node, spec[[1L]], spec[[2L]])
      if (!argument$present)
      {
         default <- spec[[3L]]
         if (is.na(default))
            return(FALSE) # R itself errors on the missing required argument
         if (!nzchar(default))
            return(FALSE) # stdout / in-memory result, not a file
         destination <- list(path = default, fresh = FALSE)
      }
      else
      {
         value <- argument$value
         if (is.null(value) || (is.logical(value) && length(value) == 1L) ||
             (is.character(value) && length(value) == 1L && !nzchar(value)))
            return(FALSE) # NULL / "" / TRUE-style non-file destinations
         destination <- .rs.rai.foldPath(value)
         if (is.null(destination))
            return(refuse(paste0("refused: ", headName, "() destination is not a literal path; ",
                                 "write derived output to an explicit NEW file path")))
      }
      if (isTRUE(destination$fresh))
      {
         # Random naming does not exempt the actual directory or filename role.
         # No temporary filename is generated/evaluated during classification.
         directory <- resolvePath(destination$path)
         if (!dir.exists(directory) ||
             grepl("(^|/)(raw|data|ref|reference|references|environment)(/|$)", directory, ignore.case = TRUE) ||
             .rs.rai.isEnvironmentFile(directory) || protectedPath(directory) ||
             .rs.rai.isEnvironmentFile(paste0(destination$pattern, "_rai_temporary_", destination$extension)))
            return(refuse("refused: tempfile destination is protected or unavailable"))
         acc$filesWritten <- unique(c(acc$filesWritten, "<tempfile>"))
         return(FALSE)
      }
      path <- resolvePath(destination$path)
      if (createsDirectory && !dir.exists(dirname(path)))
         return(refuse("refused: ggsave(create.dir = ) would create a directory; create it first or save into an existing folder"))
      if (grepl("(^|/)(raw|data|ref|reference|references|environment)(/|$)", dirname(path), ignore.case = TRUE))
         return(refuse("refused: destination is inside a protected data directory"))
      if (.rs.rai.isEnvironmentFile(path))
         return(refuse(paste0("refused: ", headName, "() would write environment/profile file ",
                              basename(path), "; those files are never changed by the Assistant")))
      if (protectedPath(path) || protectedPath(destination$path))
         return(refuse(paste0("refused: ", headName, "() would write a protected environment, credential or ",
                              "system location; the Assistant never changes those")))
      if (headName %in% c("png", "jpeg", "bmp", "tiff", "pdf", "svg", "cairo_pdf", "postscript") &&
          grepl("%", destination$path, fixed = TRUE))
      {
         # One decimal page field in a literal basename; inspect a superset of all page numbers
         filename <- basename(path)
         field <- regexpr("%d|%0[1-9]d", filename)
         if (field[[1L]] < 0L || grepl("%", dirname(path), fixed = TRUE))
            return(refuse("refused: graphics filename expansion is not inspectable"))
         prefix <- substr(filename, 1L, field[[1L]] - 1L)
         suffix <- substring(filename, field[[1L]] + attr(field, "match.length"))
         if (grepl("%", paste0(prefix, suffix), fixed = TRUE) ||
             !grepl("\\.(png|jpe?g|bmp|tiff?|pdf|svg|ps)$", suffix, ignore.case = TRUE) ||
             .rs.rai.isEnvironmentFile(prefix) ||
             grepl("(^|/)(raw|data|ref|reference|references|environment)(/|$)", dirname(path), ignore.case = TRUE) ||
             !dir.exists(dirname(path)) || file.access(dirname(path), 4L) != 0L)
            return(refuse("refused: graphics expansion targets protected data or an uninspectable path/type"))
         entries <- tryCatch(list.files(dirname(path), all.files = TRUE, no.. = TRUE),
                             warning = function(e) NULL, error = function(e) NULL)
         if (is.null(entries)) return(refuse("refused: graphics expansion directory is unavailable"))
         candidates <- entries[startsWith(entries, prefix) & endsWith(entries, suffix)]
         middle <- substring(candidates, nchar(prefix) + 1L, nchar(candidates) - nchar(suffix))
         if (any(grepl("^[0-9]+$", middle)))
            return(refuse("refused: graphics expansion would overwrite an existing file"))
         return(refuse("refused: graphics expansion produces non-code output; data files are read-only"))
      }
      if (file.exists(path) || isTRUE(nzchar(Sys.readlink(path), keepNA = TRUE)))
         return(refuse(paste0("refused: ", headName, "() would overwrite existing file ", path,
                              "; originals are preserved, write derived output to a NEW path")))
      acc$filesWritten <- unique(c(acc$filesWritten, path))
      FALSE
   }

   walk <- function(node, local)
   {
      walkNodes <<- walkNodes + 1L
      if (walkNodes > 4096L)
         return(refuse("refused: data policy traversal exceeded its bounded node budget"))
      if (is.symbol(node))
      {
         name <- as.character(node)
         if (identical(name, ".GlobalEnv"))
            return(refuse(paste0("refused: direct .GlobalEnv access is outside the Assistant's ",
                                 "autonomous scope; assign derived data to a plain new name")))
         if (nzchar(name) && name %in% snapshot$names)
            acc$inputs <- unique(c(acc$inputs, name))
         return(FALSE)
      }
      if (is.pairlist(node))
         return(any(vapply(as.list(node), walk, logical(1L), local = local)))
      if (is.null(node) || !is.language(node))
         return(FALSE)
      if (!is.call(node))
         return(FALSE)

      head <- node[[1L]]
      qualified <- NULL
      headName <- NULL
      if (is.symbol(head))
         headName <- as.character(head)
      else if (is.call(head) && is.symbol(head[[1L]]) &&
               as.character(head[[1L]]) %in% c("::", ":::") && length(head) == 3L)
      {
         if (identical(as.character(head[[1L]]), ":::"))
            return(refuse("refused: non-exported namespace calls are not inspectable"))
         namespace <- as.character(head[[2L]])
         headName <- as.character(head[[3L]])
         qualified <- paste0(namespace, "::", headName)
         if (namespace %in% .rs.rai.dataGuardRefusedNamespaces)
            return(refuse(paste0("refused: ", namespace, ":: calls are outside the Assistant's ",
                                 "R Console scope (process, IDE, or file-system control)")))
      }
      else
      {
         proposed <- proposedCallable(head, acc$localBindings)
         if (is.null(proposed)) return(refuse("refused: computed helper callable provenance is unavailable"))
         headName <- "<literal-helper>"
      }
      if(identical(head,as.name("::")) && length(node)==3L &&
         !is.null(coreCallee(node,acc$localBindings))) return(FALSE)
      if (is.symbol(head) && !headAvailable(headName,acc$localBindings) && !headName %in% names(acc$localBindings))
         return(refuse("refused: helper canonical lookup in unknown defining scope is unavailable"))
      proposed <- proposedCallable(head, acc$localBindings)
      localCallee <- is.symbol(head) && (headName %in% names(acc$localBindings) ||
         headName %in% names(acc$bindings)) &&
         !headName %in% c("<-", "=", "<<-", "function", "for", "if", "while", "repeat", "{", "(")
      if (!is.null(proposed) || localCallee)
      {
         if (is.null(proposed) || length(acc$inspectingCallees) >= 8L || headName %in% acc$inspectingCallees)
            return(refuse("refused: local helper callable provenance is unavailable or recursive"))
         parameters <- helperParameters(proposed$signature, node, 0L, acc$localBindings, proposed$lexical)
         if (is.null(parameters)) return(refuse("refused: helper argument provenance is unavailable"))
         acc$inspectingCallees <- c(acc$inspectingCallees, headName)
         denied <- walkLocal(list(formals(proposed$signature), body(proposed$signature)), parameters, proposed$lexical)
         acc$inspectingCallees <- acc$inspectingCallees[-length(acc$inspectingCallees)]
         if (denied) return(TRUE)
         return(any(vapply(as.list(node)[-1L], walk, logical(1L), local = local)))
      }

      if (headName %in% .rs.rai.dataGuardRefusedCalls ||
          (!is.null(qualified) && qualified %in% .rs.rai.dataGuardRefusedQualified) ||
          headName %in% .rs.rai.dataGuardRefusedQualified ||
          startsWith(headName, ".rs."))
         return(refuse(paste0("refused: ", headName, "() is outside the Assistant's autonomous ",
                              "R Console scope (direct data/file/environment/IDE mutation or ",
                              "uninspectable code)")))

      # Base/package generics can dispatch to a user-defined S3 method whose
      # body is absent from this expression. Even base::print(x) still finds
      # print.foo in .GlobalEnv. Do not execute a hidden workspace method;
      # explicit approved helper calls receive recursive body inspection below.
      methodBinding <- function(name) tryCatch(
      {
         identity <- snapshot$identities[[match(name, snapshot$names)]]
         is.na(identity) || !startsWith(identity, "value:") ||
            is.function(get(name, envir = globalenv(), inherits = FALSE))
      }, error = function(error) TRUE)
      if (any(vapply(snapshot$names[startsWith(snapshot$names, paste0(headName, "."))],
                     methodBinding, logical(1L))))
         return(refuse(paste0("refused: ", headName,
                              "() method dispatch may execute an uninspected workspace method")))

      # A call into an existing workspace closure could hide mutation even if
      # this proposal contains no forbidden token. Permit only an Assistant-
      # derived or explicitly designated normal binding, and inspect its live
      # body recursively before allowing the call. Cycles/deep indirection
      # fail closed; no promise or active binding is ever forced here.
      if (is.null(qualified) && headName %in% snapshot$names &&
          !headName %in% c("<-", "=", "<<-", "function", "for", "if", "while", "repeat", "{", "("))
      {
         index <- match(headName, snapshot$names)
         identity <- snapshot$identities[[index]]
         if (is.na(identity) || !startsWith(identity, "value:") ||
             .rs.rai.isProtectedOriginal(headName, snapshot) ||
             length(acc$inspectingCallees) >= 8L || headName %in% acc$inspectingCallees)
            return(refuse(paste0("refused: existing workspace callee `", headName,
                                 "` lacks inspectable, approved derived provenance")))
         callee <- get(headName, envir = globalenv(), inherits = FALSE)
         if (!identical(typeof(callee), "closure"))
            return(refuse(paste0("refused: workspace callee `", headName, "` is not a closure")))
         acc$inspectingCallees <- c(acc$inspectingCallees, headName)
         matched <- tryCatch(as.list(match.call(callee, node, expand.dots = FALSE))[-1L],
                             error = function(error) NULL)
         if (is.null(matched))
            return(refuse("refused: helper argument provenance is unavailable"))
         lexical <- workspaceScope(callee)
         parameters <- helperParameters(callee, node, 0L, acc$localBindings, lexical)
         if (is.null(parameters)) return(refuse("refused: helper default provenance did not converge"))
         nestedRefusal <- walkLocal(list(formals(callee), body(callee)), parameters, lexical)
         acc$inspectingCallees <- acc$inspectingCallees[-length(acc$inspectingCallees)]
         if (nestedRefusal) return(TRUE)
      }

      known <- headName %in% c(.rs.rai.dataGuardNeutralCalls,
         names(.rs.rai.dataGuardWriters), .rs.rai.dataGuardReaders,
         .rs.rai.dataGuardByReference, "file", "gzfile", "bzfile", "xzfile")
      packages <- c("base", "utils", "tools", "stats", "methods", "graphics", "grDevices",
         "data.table", "readr", "readxl", "arrow", "jsonlite", "openxlsx", "writexl",
         "haven", "vroom", "qs", "feather", "fst", "ggplot2")
      approvedWorkspace <- is.null(qualified) && headName %in% snapshot$names
      # Installed third-party namespaces are a trust boundary, not a purity proof.
      # Do not load a namespace (or its lazy database) just to classify a proposal:
      # that would execute package hooks before approval. Inspect a realized body
      # when available; otherwise screen the qualified name and supplied arguments.
      thirdParty <- !is.null(qualified) &&
         !namespace %in% c("base", "utils", "tools", "stats", "methods", "graphics", "grDevices",
            "readr", "data.table", "arrow", "jsonlite", "openxlsx", "writexl", "yaml", "fs",
            "withr", "readxl", "haven", "vroom", "qs", "feather", "fst")
      packageNeutral <- FALSE
      if (thirdParty && !headName %in% c(names(.rs.rai.dataGuardWriters), "file", "gzfile", "bzfile", "xzfile"))
      {
         writerName <- function(name)
            name %in% c(names(.rs.rai.dataGuardWriters), .rs.rai.dataGuardRefusedCalls,
               "<<-", "->>", ".Internal", ".Primitive", "open", "close", "closeAllConnections", "pushBack", "clearPushBack", "seek", "truncate",
               "setHook", "addTaskCallback", "removeTaskCallback", "set.seed", "RNGkind", "RNGversion",
               "library", "require", "attach", "detach", "unloadNamespace") ||
            grepl("^(write|save|export|dump|sink)|^(create|delete|remove|rename|move|copy|link|chmod|touch|download|unzip|untar|zip|tar)($|[._A-Z])|^(with_|local_)", name)
         bodyEffect <- function(node)
         {
            if (missing(node)) return(FALSE)
            walkNodes <<- walkNodes + 1L
            if (walkNodes > 4096L) return(TRUE)
            if (is.symbol(node)) return(as.character(node) %in% c(names(.rs.rai.dataGuardWriters),
               "setwd", "Sys.setenv", "options", "get", "match.fun", "do.call", ".Call", ".External"))
            if (is.pairlist(node)) return(any(vapply(as.list(node), bodyEffect, logical(1L))))
            if (!is.call(node)) return(FALSE)
            h <- node[[1L]]
            n <- if (is.symbol(h)) as.character(h) else if (is.call(h) && length(h) == 3L &&
               identical(h[[1L]], as.name("::"))) as.character(h[[3L]]) else ""
            if (!nzchar(n)) return(TRUE)
            # Console diagnostics are neutral only with the default stdout target.
            stdout <- n %in% c("cat", "message", "warning", "try") &&
               !any(names(as.list(node)[-1L]) %in% c("file", "con", "outFile"))
            readFrame <- n %in% c("parent.frame", "environment", "globalenv", "as.environment",
               "pos.to.env", "sys.frame", "sys.frames", "topenv")
            if (!stdout && !readFrame && writerName(n)) return(TRUE)
            if (n == "do.call")
            {
               target <- .rs.rai.callArgument(node, "what", 1L)
               value <- target$value
               literal <- is.character(value) && length(value) == 1L && !is.na(value)
               if (is.symbol(value))
               {
                  name <- as.character(value)
                  assigned <- function(expr)
                  {
                     if (!is.call(expr)) return(FALSE)
                     if (as.character(expr[[1L]])[[1L]] %in% c("<-", "=", "<<-", "for") &&
                         identical(expr[[2L]], value)) return(TRUE)
                     any(vapply(as.list(expr)[-1L], assigned, logical(1L)))
                  }
                  literal <- name %in% .rs.rai.dataGuardNeutralCalls &&
                     !name %in% names(formals(signature)) && !assigned(body(signature)) &&
                     trustedHead(name, environment(signature), packages = c("base", "stats", "utils", "BiocGenerics"))
                  value <- name
               }
               if (!target$present || !literal || writerName(value)) return(TRUE)
            }
            any(vapply(as.list(node)[-1L], bodyEffect, logical(1L)))
         }
         if (writerName(headName))
            return(refuse("refused: package callee matches writer/state inventory"))
         if (grepl(paste0("^(source|sys[._]source|load_all|load_code|test_file|test_dir|test_local|test_package|",
                          "run|knit|render|spin|purl|eval|evaluate|exec|install)($|[._])|",
                          "^(knit2(html|pdf|wp)|run(App|Example|Gist|Url|GitHub|Tests|Gadget))$"), headName))
            return(refuse("refused: package callee runs or loads a file as code"))
# A package function can open any string it is given, in any argument position.
         argumentStrings <- function(value)
         {
            if (is.character(value)) return(value[!is.na(value)])
            if (is.call(value) || is.pairlist(value) || is.expression(value))
               return(unlist(lapply(seq_along(value), function(i)
                  tryCatch(argumentStrings(value[[i]]), error = function(error) character(0L)))))
            character(0L)
         }
         if (any(vapply(unlist(lapply(as.list(node)[-1L], argumentStrings)), protectedPath, logical(1L))))
            return(refuse(protectedPathMessage))
         if (!length(find.package(namespace, quiet = TRUE)))
            return(refuse("refused: package callee is unavailable"))
         signature <- NULL
         if (namespace %in% loadedNamespaces())
         {
            ns <- asNamespace(namespace)
            if (!exists(headName, ns, inherits = FALSE) || bindingIsActive(headName, ns) ||
                !bindingIsLocked(headName, ns))
               return(refuse("refused: package callee is not a locked realized function"))
            # An unforced lazy binding may load code; only inspect realized values.
            realized <- tryCatch(.Call("rs_raiRealizedBindingIdentity", ns, headName, ns,
               PACKAGE = "(embedding)"), error = function(e) FALSE)
            if (isTRUE(realized))
            {
               signature <- get(headName, ns, inherits = FALSE)
               if (!is.function(signature)) return(refuse("refused: package callee is not a function"))
               if (!is.primitive(signature) &&
                   (bodyEffect(body(signature)) || bodyEffect(formals(signature))))
                  return(refuse("refused: package body/formals match writer/state inventory"))
            }
         }
         packageNeutral <- TRUE
      }
      if (!is.null(qualified) && !headName %in% c(names(.rs.rai.dataGuardWriters),
          .rs.rai.dataGuardReaders, "file", "gzfile", "bzfile", "xzfile"))
      {
         if (!thirdParty)
         {
            callee <- coreCallee(head, acc$localBindings, packages = packages)
            signature <- if (is.null(callee)) NULL else callee$signature
         }
         destinationCall <- node
         if (!is.null(signature) && !is.primitive(signature))
         {
            destinationCall <- tryCatch(match.call(signature, node), error = function(e) NULL)
            if (is.null(destinationCall)) return(refuse("refused: package argument matching is unavailable"))
         }
         destinationNames <- names(as.list(destinationCall)[-1L])
         for (argument in destinationNames)
         {
            if (!nzchar(argument)) next
            candidates <- c("file", "path", "con", "filename", "outfile")
            if (any(startsWith(candidates, argument)))
            {
               value <- destinationCall[[argument]]
               if (!is.character(value) || length(value) != 1L || is.na(value))
                  return(refuse("refused: package file argument must be literal"))
               if (checkDestination(destinationCall, list(argument, NA_integer_, NA), headName)) return(TRUE)
            }
         }
      }

      exactNeutral <- !is.null(qualified) && qualified %in% c("tools::toTitleCase", "stats::lm")
      if (!approvedWorkspace && !packageNeutral && !exactNeutral && !headName %in% c(names(.rs.rai.dataGuardWriters), "file", "gzfile", "bzfile", "xzfile") &&
          (!known || is.null(coreCallee(head, acc$localBindings, packages = packages))))
         return(refuse("refused: autonomous callee has no approved effect contract"))
      forwarded <- forwardingTransfer(node,0L,acc$localBindings)
      if(!is.null(forwarded)) return(consumeForwarding(forwarded,"walk",local=local))
      args <- as.list(node)[-1L]
      if(!headName %in% c("function","<-","=","<<-","{","(","if","for","while","repeat","local","return") &&
         !orderedArguments(head,args,acc$localBindings) &&
         argumentTransfers(args,0L,acc$localBindings,FALSE)$uncertain)
         return(refuse("refused: call argument effect order is unavailable"))
      callableDataArgs <- args
      flow <- validatedCallFlow(node,acc$localBindings)
      contract <- flow$contract
      if(length(contract$names))
      {
         if(is.null(contract$core)) return(refuse("refused: canonical callback head identity is unavailable"))
         if(is.null(contract$matched)) return(refuse("refused: callback argument binding is unavailable"))
         if(!isTRUE(flow$ok))
         {
            callback <- contract$matched[[flow$bad[[1L]]]]
            return(refuse(if(containsCallable(callback))
               "refused: higher-order helper argument flow is not inspectable" else
               "refused: callback callable identity or provenance is unavailable"))
         }
         callableDataArgs <- flow$data
      }
      if (!headName %in% c("function", "<-", "=", "{", "(", "if", "for", "while", "repeat", "local", "return") &&
          !(headName %in% c("rm", "remove") && (is.null(qualified) || identical(namespace, "base"))) &&
          any(vapply(callableDataArgs, containsCallable, logical(1L))))
         return(refuse("refused: higher-order helper argument flow is not inspectable"))

      if (identical(headName, "if") && length(args) >= 2L)
      {
         if (walk(args[[1L]], local)) return(TRUE)
         before <- acc$localBindings; beforeGlobal <- acc$bindings
         if (walk(args[[2L]], local)) return(TRUE)
         yes <- acc$localBindings; yesGlobal <- acc$bindings
         acc$localBindings <- before; acc$bindings <- beforeGlobal
         if (length(args) == 3L && walk(args[[3L]], local)) return(TRUE)
         acc$localBindings <- mergeBindings(yes, acc$localBindings)
         acc$bindings <- mergeBindings(yesGlobal, acc$bindings)
         return(FALSE) # neither branch may overwrite the other's provenance
      }

      if (headName %in% c("function"))
      {
         parameters <- if (length(node) >= 2L)
            setNames(as.list(rep(FALSE, length(node[[2L]]))), names(node[[2L]])) else list()
         return(walkLocal(as.list(node)[-1L], parameters))
      }
      if (identical(headName, "local"))
      {
         if (length(args) > 1L)
            return(refuse("refused: local() with an explicit environment"))
         return(walkLocal(args))
      }

      if (headName %in% c("<-", "=", "<<-", "%<>%"))
      {
         lhs <- node[[2L]]
         superAssign <- identical(headName, "<<-")
         if (superAssign)
            return(refuse("refused: superassignment can mutate an uninspected environment"))
         if (local && is.symbol(lhs) && length(node) >= 3L)
         {
            state <- if (.rs.rai.containsReaderCall(node[[3L]])) "original" else provenance(node[[3L]])$state
            if (walk(node[[3L]], local)) return(TRUE)
            acc$localBindings <- bindState(acc$localBindings, as.character(lhs), state)
            rememberScope(acc$localBindings)
            return(FALSE)
         }
         if (is.call(lhs) || superAssign || !local)
         {
            root <- .rs.rai.assignmentRoot(lhs)
            if (!is.na(root) && .rs.rai.authorizedExisting(root, snapshot) && is.call(lhs))
               return(refuse("refused: authorized derived bindings permit plain rebinding, not in-place changes"))
            if (!(local && !superAssign && is.symbol(lhs)) &&
                !(local && !superAssign && !is.na(root) && !identical(root, "") &&
                  !protectedOriginal(root)))
            {
               if (checkTarget(root, "assignment"))
                  return(TRUE)
               if (!is.na(root) && .rs.rai.authorizedExisting(root, snapshot) && is.symbol(lhs) &&
                   length(node) >= 3L)
               {
                  kind <- get(root, envir = .rs.rai.dataState$authorized, inherits = FALSE)$kind
                  rhs <- node[[3L]]
                  if (.rs.rai.containsReaderCall(rhs))
                     return(refuse("refused: a reader result cannot replace an authorized derived binding"))
                  if (identical(kind, "helper") && !(is.call(rhs) &&
                      identical(rhs[[1L]], as.name("function"))))
                     return(refuse("refused: an authorized helper must be replaced by an inspected function literal"))
                  if (identical(kind, "path"))
                  {
                     path <- .rs.rai.foldPath(rhs)
                     if (is.null(path) || isTRUE(path$fresh) || .rs.rai.isEnvironmentFile(path$path))
                        return(refuse("refused: an authorized path needs a literal non-environment destination"))
                  }
               }
               # A nested read may be returned unchanged by a wrapper, so
               # conservatively protect any binding with reader provenance.
               if (!is.na(root) && nzchar(root) && is.symbol(lhs) && length(node) >= 3L)
               {
                  state <- if (.rs.rai.containsReaderCall(node[[3L]])) "original" else provenance(node[[3L]])$state
                  acc$bindings <- bindState(acc$bindings, root, state)
                  rememberScope(acc$bindings)
                  if (!identical(provenanceState(state), "fresh"))
                     acc$originalTargets <- unique(c(acc$originalTargets, root))
               }
            }
         }
         if (is.call(lhs) && any(vapply(as.list(lhs)[-1L], walk, logical(1L), local = local)))
            return(TRUE)
         if (length(node) >= 3L && walk(node[[3L]], local)) return(TRUE)
         if (is.call(lhs) && length(node) >= 3L)
         {
            root <- .rs.rai.assignmentRoot(lhs)
            if (checkInsertion(root, list(node[[3L]]), local)) return(TRUE)
         }
         FALSE
      }

      if (headName %in% c("for", "while", "repeat"))
      {
         iterator <- NULL;includeEntry <- TRUE
         if (identical(headName, "for") && length(node) == 4L && is.symbol(node[[2L]]))
         {
            name <- as.character(node[[2L]])
            state <- provenance(node[[3L]])$state
            nonempty <- sequenceNonempty(node[[3L]],acc$localBindings)
            if (walk(node[[3L]], local)) return(TRUE)
            entry <- acc$localBindings;entryGlobal <- acc$bindings
            iterator <- name;includeEntry <- !nonempty
            if (local) acc$localBindings <- bindState(acc$localBindings, name, state)
            else
            {
               if (checkTarget(name, "for-loop variable")) return(TRUE)
               acc$bindings <- bindState(acc$bindings, name, state)
               if (!identical(provenanceState(state), "fresh")) acc$originalTargets <- unique(c(acc$originalTargets, name))
            }
            nodes <- list(node[[4L]])
         }
         else { nodes <- args;entry <- acc$localBindings;entryGlobal <- acc$bindings }
         for (iteration in seq_len(16L))
         {
            before <- acc$localBindings; beforeGlobal <- acc$bindings
            if(!is.null(iterator))
            {
               if(local) acc$localBindings <- bindState(acc$localBindings,iterator,state)
               else acc$bindings <- bindState(acc$bindings,iterator,state)
            }
            if (any(vapply(nodes, walk, logical(1L), local = local))) return(TRUE)
            acc$localBindings <- joinLoopScopes(entry,before,acc$localBindings,includeEntry)
            acc$bindings <- joinLoopScopes(entryGlobal,beforeGlobal,acc$bindings,includeEntry)
            if (identical(before, acc$localBindings) && identical(beforeGlobal, acc$bindings))
               return(FALSE) # body checked at the stable back-edge state
         }
         return(refuse("refused: loop provenance did not converge within its bounded policy budget"))
      }

      if (headName %in% c("assign", "delayedAssign", "makeActiveBinding"))
      {
         target <- .rs.rai.callArgument(node, "x", 1L)
         if (!target$present)
            target <- .rs.rai.callArgument(node, "sym", 1L)
         environmentArg <- .rs.rai.callArgument(node, "envir", NA_integer_)
         positionArg <- .rs.rai.callArgument(node, "pos", NA_integer_)
         argNames <- names(args)
         if (is.null(argNames))
            argNames <- rep("", length(args))
         # R matches argument names partially, and a third argument of any kind binds to an environment formal.
         environmentFormals <- c("pos", "envir", "env", "inherits", "immediate", "eval.env", "assign.env")
         positionalEnvironment <- length(args) > 2L ||
            any(nzchar(argNames) & vapply(argNames, function(argName)
               nzchar(argName) && any(startsWith(environmentFormals, argName)), logical(1L)))
         if (environmentArg$present || positionArg$present || positionalEnvironment)
            return(refuse(paste0("refused: ", headName, "() into an explicit environment; ",
                                 "derived data must be assigned to a plain new name")))
         name <- if (target$present && is.character(target$value) && length(target$value) == 1L)
            target$value else NA_character_
         if (!is.na(name) && .rs.rai.authorizedExisting(name, snapshot))
            return(refuse("refused: an authorized derived binding must use a plain assignment"))
         if (!local && checkTarget(name, paste0(headName, "()")))
            return(TRUE)
         value <- .rs.rai.callArgument(node, "value", 2L)
         state <- if (!value$present) "unknown" else
            if (.rs.rai.containsReaderCall(value$value)) "original" else provenance(value$value)$state
         if (!is.na(name))
         {
            if (local) acc$localBindings <- bindState(acc$localBindings, name, state)
            else
            {
               acc$bindings <- bindState(acc$bindings, name, state)
               if (!identical(provenanceState(state), "fresh"))
                  acc$originalTargets <- unique(c(acc$originalTargets, name))
            }
         }
         return(any(vapply(args, walk, logical(1L), local = local)))
      }

      if (identical(headName, "try") && (is.null(qualified) || identical(namespace, "base")))
      {
         tryNames <- .rs.rai.orElse(names(args), rep("", length(args)))
         if (length(args) > 2L || any(nzchar(tryNames) & startsWith("outFile", tryNames)))
            return(refuse("refused: try() cannot send its error text to an outFile"))
      }

      if (identical(headName, "Sys.getenv") && (is.null(qualified) || identical(namespace, "base")))
      {
         requested <- .rs.rai.callArgument(node, "x", 1L)
         variables <- if (requested$present) .rs.rai.literalStrings(requested$value) else NULL
         if (is.null(variables) ||
             any(grepl(.rs.rai.secretEnvironmentPattern, variables, ignore.case = TRUE, perl = TRUE)))
            return(refuse(environmentValueMessage))
      }

      if (headName %in% c("list.files", "list.dirs", "dir.exists", "file.access", "normalizePath",
                          "file.exists", "file.info"))
      {
         inspected <- if (headName %in% c("file.exists", "file.info"))
            args[!nzchar(.rs.rai.orElse(names(args), rep("", length(args))))] else
            list(.rs.rai.callArgument(node, switch(headName, dir.exists = "paths", file.access = "names", "path"), 1L)$value)
         for (target in inspected)
         {
            values <- .rs.rai.literalStrings(target)
            if (!is.null(values) && any(vapply(values, protectedPath, logical(1L))))
               return(refuse(protectedPathMessage))
         }
      }

      if (headName %in% c("rm", "remove"))
      {
         removed <- removalNames(args,acc$localBindings)
         if (!removed$ok) return(refuse(removed$reason))
         names <- removed$names
         for (name in names)
            {
               if (.rs.rai.authorizedExisting(name, snapshot))
                  return(refuse(paste0("refused: deleting an authorized derived binding `", name, "` is not a rebind")))
               if (protectedOriginal(name))
                  return(refuse(paste0("refused: rm() would delete original data `", name, "`")))
            }
         if (local)
         {
            acc$localBindings <- removeStates(acc$localBindings,names)
            rememberScope(acc$localBindings)
         }
         return(FALSE)
      }

      if (headName %in% c("data", "load"))
      {
         environmentArg <- .rs.rai.callArgument(node, "envir", NA_integer_)
         isFreshEnvironment <- environmentArg$present && is.call(environmentArg$value) &&
            identical(environmentArg$value[[1L]], as.name("new.env"))
         if (identical(headName, "load") && !isFreshEnvironment)
            return(refuse(paste0("refused: load() without `envir = new.env()` can overwrite ",
                                 "existing workspace bindings; load into a new environment")))
         if (identical(headName, "load"))
         {
            source <- .rs.rai.callArgument(node, "file", 1L)
            folded <- if (source$present) .rs.rai.foldPath(source$value) else NULL
            if (source$present && (is.null(folded) || isTRUE(folded$fresh)))
               return(refuse("refused: load() source is not a literal inspectable path"))
            if (!is.null(folded))
            {
               path <- resolvePath(folded$path)
               if (.rs.rai.isEnvironmentFile(folded$path, forRead = TRUE) ||
                   .rs.rai.isEnvironmentFile(path, forRead = TRUE))
                  return(refuse("refused: load() cannot read a protected environment, credential or system file"))
               acc$filesRead <- unique(c(acc$filesRead, path))
            }
            return(any(vapply(args, walk, logical(1L), local = local)))
         }
         if (!isFreshEnvironment)
         {
            argNames <- names(args)
            if (is.null(argNames))
               argNames <- rep("", length(args))
            for (i in seq_along(args))
            {
               if (nzchar(argNames[[i]]) && !argNames[[i]] %in% c("list", "package"))
                  next
               if (identical(argNames[[i]], "package"))
                  next
               value <- args[[i]]
               name <- if (is.symbol(value)) as.character(value) else
                  if (is.character(value) && length(value) == 1L) value else NA_character_
               if (!local && checkTarget(name, "data()"))
                  return(TRUE)
            }
         }
         return(FALSE)
      }

      if (headName %in% .rs.rai.dataGuardByReference)
      {
         # Match supported writer signatures without evaluating any argument.
         # R permits partial names and unnamed arguments mixed with named j;
         # counting unnamed arguments cannot identify the inserted payload.
         matched <- NULL
         if (headName %in% c("set", "setattr"))
         {
            signature <- if (identical(headName, "set")) function(x, i = NULL, j, value = NULL) NULL else
               function(x, name, value) NULL
            matched <- tryCatch(as.list(match.call(signature, node, expand.dots = FALSE))[-1L],
                                error = function(error) NULL)
            if (is.null(matched)) return(refuse("refused: by-reference argument lineage is unavailable"))
            receiver <- list(present = "x" %in% names(matched), value = matched$x)
         }
         else receiver <- .rs.rai.callArgument(node, "x", 1L)
         target <- if (receiver$present) .rs.rai.assignmentRoot(receiver$value) else NA_character_
         if (is.na(target)) return(refuse("refused: by-reference receiver is computed"))
         if (protectedOriginal(target))
            return(refuse(paste0("refused: ", headName, "() modifies `", target, "` in place; ",
                                 "copy it to a NEW name first (for example data.table::copy())")))
         if (any(vapply(args, walk, logical(1L), local = local))) return(TRUE)
         # Column selectors in setkey/setorder are unevaluated labels, not
         # inserted values. set()/setattr() are the reference-bearing writers.
         if (headName %in% c("set", "setattr"))
         {
            if ("value" %in% names(matched) && checkInsertion(target, list(matched$value), local)) return(TRUE)
         }
         acc$targets <- unique(c(acc$targets, target))
         return(FALSE)
      }

      if (headName %in% c("[", "[[") && length(args) >= 2L)
      {
         byReference <- any(vapply(args[-1L], function(argument)
            is.call(argument) && is.symbol(argument[[1L]]) &&
               as.character(argument[[1L]]) %in% c(":=", "let"), logical(1L)))
         if (byReference)
         {
            target <- .rs.rai.assignmentRoot(args[[1L]])
            if (is.na(target) || protectedOriginal(target))
               return(refuse(paste0("refused: `:=` modifies ",
                                    if (is.na(target)) "a computed object" else paste0("`", target, "`"),
                                    " in place; copy it to a NEW name first")))
            insertions <- Filter(function(argument) is.call(argument) &&
               is.symbol(argument[[1L]]) && as.character(argument[[1L]]) %in% c(":=", "let"), args[-1L])
            for (insertion in insertions)
            {
               values <- as.list(insertion)[-1L]
               if (is.null(names(values)) && identical(insertion[[1L]], as.name(":="))) values <- values[-1L]
               if (any(vapply(values, walk, logical(1L), local = local)) || checkInsertion(target, values, local))
                  return(TRUE)
            }
            acc$targets <- unique(c(acc$targets, target))
         }
      }

      if (grepl("<-$", headName) && !headName %in% c("<-", "<<-") && length(args))
      {
         # functional replacement call, e.g. `$<-`(env, "a", 1): by-reference on environments
         target <- .rs.rai.assignmentRoot(args[[1L]])
         if (is.na(target) || protectedOriginal(target))
            return(refuse(paste0("refused: ", headName, "() applied to ",
                                 if (is.na(target)) "a computed object" else paste0("original `", target, "`"))))
         if (any(vapply(args[-1L], walk, logical(1L), local = local)) ||
             checkInsertion(target, args[-1L], local)) return(TRUE)
      }

      if (headName %in% c(names(.rs.rai.dataGuardWriters), .rs.rai.dataGuardReaders,
                           "file", "gzfile", "bzfile", "xzfile"))
      {
         reader <- headName %in% .rs.rai.dataGuardReaders &&
            !headName %in% c(names(.rs.rai.dataGuardWriters), "file", "gzfile", "bzfile", "xzfile")
         matchedWriter <- writerCall(node, forRead = reader)
         if (is.null(matchedWriter))
            return(refuse(if (reader) "refused: reader callee or argument matching is unavailable" else
                          "refused: writer callee or argument matching is unavailable"))
         node <- matchedWriter
         args <- as.list(node)[-1L]
      }

      if (headName %in% names(.rs.rai.dataGuardWriters))
      {
         spec <- .rs.rai.dataGuardWriters[[headName]]
         if (headName %in% c("zip", "tar", "download.file"))
         {
            method <- .rs.rai.callArgument(node, "method", NA_integer_)
            if (any(names(args) %in% c("zip", "tar", "flags", "extras", "extra_flags", "extra")) ||
                (method$present && !identical(method$value, "libcurl")))
               return(refuse(paste0("refused: ", headName, "() command-line arguments reach the system shell")))
         }
         if (identical(headName, "file.copy"))
         {
            overwrite <- .rs.rai.callArgument(node, "overwrite", NA_integer_)
            if (overwrite$present && !identical(overwrite$value, FALSE))
               return(refuse("refused: file.copy(overwrite = ...) can replace an original file"))
            source <- .rs.rai.callArgument(node, "from", 1L)
            folded <- if (source$present) .rs.rai.foldPath(source$value) else NULL
            if (source$present && (is.null(folded) || isTRUE(folded$fresh)))
               return(refuse("refused: file.copy() source is not a literal inspectable path"))
            if (!is.null(folded))
            {
               path <- resolvePath(folded$path)
               if (.rs.rai.isEnvironmentFile(folded$path, forRead = TRUE) ||
                   .rs.rai.isEnvironmentFile(path, forRead = TRUE))
                  return(refuse("refused: file.copy() cannot read a protected environment, credential or system file"))
               acc$filesRead <- unique(c(acc$filesRead, path))
            }
         }
         if (identical(headName, "file.create"))
         {
            for (i in seq_along(args))
               if (!nzchar(.rs.rai.orElse(names(args)[i], "")) &&
                   checkDestination(as.call(list(as.name("file.create"), args[[i]])),
                                    list(NA_character_, 1L, NA), headName))
                  return(TRUE)
         }
         else if (checkDestination(node, spec, headName))
            return(TRUE)
      }

      if (identical(headName, "fread"))
      {
         supplied <- names(args)
         if (any(vapply(supplied, function(name) nzchar(name) &&
             (startsWith("cmd", name) || startsWith("text", name)), logical(1L))))
            return(refuse("refused: fread command/text input can execute commands or write temporary files"))
         for (argument in supplied)
            if (nzchar(argument) && startsWith("tmpdir", argument) &&
                checkDestination(node, list(argument, NA_integer_, NA), headName))
               return(TRUE)
         input <- .rs.rai.callArgument(node, "file", NA_integer_)
         if (!input$present) input <- .rs.rai.callArgument(node, "input", 1L)
         path <- if (input$present) .rs.rai.foldPath(input$value) else NULL
         if (is.null(path) || isTRUE(path$fresh) || !file.exists(resolvePath(path$path)) ||
             dir.exists(resolvePath(path$path)))
            return(refuse("refused: fread requires an existing literal file input"))
      }

      connection <- headName %in% c("file", "gzfile", "bzfile", "xzfile")
      connectionRead <- FALSE
      connectionWrite <- FALSE
      computedMode <- FALSE
      if (connection)
      {
         mode <- .rs.rai.callArgument(node, "open", 2L)
         literalMode <- mode$present && is.character(mode$value) &&
            length(mode$value) == 1L && !is.na(mode$value)
         computedMode <- mode$present && !literalMode
         readOnly <- literalMode && mode$value %in% c("r", "rb", "rt")
         writeOnly <- literalMode && mode$value %in% c("w", "wb", "wt", "a", "ab", "at")
         connectionRead <- !writeOnly
         connectionWrite <- !readOnly
      }

      if ((connectionRead || (!connection && headName %in% .rs.rai.dataGuardReaders)) && length(args))
      {
         source <- list(present = FALSE, value = NULL)
         for (name in unique(c(attr(node, "rai_reader_source", exact = TRUE),
                               "description", "file", "path", "con", "input", "txt", "x")))
         {
            source <- .rs.rai.callArgument(node, name, NA_integer_)
            if (source$present) break
         }
         if (!source$present)
            source <- .rs.rai.callArgument(node, NA_character_, 1L)
         folded <- if (source$present) .rs.rai.foldPath(source$value) else NULL
         if (source$present && (is.null(folded) || isTRUE(folded$fresh)))
            return(refuse(paste0("refused: ", headName,
                                 "() reader source is not a literal inspectable path")))
         if (!is.null(folded))
         {
            path <- resolvePath(folded$path)
            if (.rs.rai.isEnvironmentFile(folded$path, forRead = TRUE) ||
                .rs.rai.isEnvironmentFile(path, forRead = TRUE))
               return(refuse(paste0("refused: ", headName,
                                    "() cannot read a protected environment, credential or system file; ",
                                    "read data from the project folder, a data folder or tempdir() instead")))
            acc$filesRead <- unique(c(acc$filesRead, path))
         }
      }

      if (connectionWrite && checkDestination(node, list("description", 1L, NA), headName))
         return(TRUE)
      if (computedMode)
         return(refuse("refused: file connection with a computed open mode"))

      any(vapply(callableDataArgs, walk, logical(1L), local = local))
   }

   refused <- tryCatch(walk(expr, FALSE) || scanLiterals(expr), error = function(error)
      refuse(paste0("refused: data policy could not classify this proposal (",
                    conditionMessage(error), ")")))
   if (isTRUE(refused) || !is.null(acc$reason))
      return(list(ok = FALSE, reason = .rs.rai.orElse(acc$reason, "refused: data policy")))
   list(ok = TRUE, reason = NULL,
        inputs = setdiff(acc$inputs, acc$targets),
        targets = acc$targets,
        original_targets = acc$originalTargets,
        files_read = acc$filesRead,
        files_written = acc$filesWritten)
}

# Bounded fingerprint of a file used as observed evidence that an input was not
# changed by the run. Hashes only files up to 64 MB; larger ones are compared
# by size and modification time and reported as such.
.rs.rai.fileFingerprint <- function(path)
{
   info <- suppressWarnings(file.info(path, extra_cols = FALSE))
   if (is.na(info$size))
      return(list(path = path, exists = FALSE))
   fingerprint <- list(path = path, exists = TRUE, size = as.numeric(info$size),
                       mtime = format(info$mtime, "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC"),
                       is_dir = isTRUE(info$isdir))
   # Devices, pipes and sockets report size 0 and a digest of one never reaches end of file.
   if (!isTRUE(info$isdir) && info$size > 0 && info$size <= 64 * 1024 * 1024 &&
       !grepl("^/(dev|proc)/", normalizePath(path, winslash = "/", mustWork = FALSE)) &&
       requireNamespace("digest", quietly = TRUE))
   {
      hash <- tryCatch(digest::digest(file = path, algo = "sha256"), error = function(error) NULL)
      if (is.character(hash))
         fingerprint$sha256 <- hash
   }
   fingerprint
}

# Classify and record a proposal immediately before it may run. On success the
# returned evidence carries the pre-run snapshot the completion diff needs.
.rs.rai.prepareRunEvidence <- function(code)
{
   parsed <- tryCatch(parse(text = code, keep.source = FALSE), error = function(error) NULL)
   if (is.null(parsed) || length(parsed) != 1L)
      return(list(ok = FALSE, reason = "run_r accepts exactly one R statement per call"))
   snapshot <- .rs.rai.globalSnapshot()
   guard <- .rs.rai.dataGuard(parsed[[1L]], snapshot)
   if (!isTRUE(guard$ok))
      return(list(ok = FALSE, reason = guard$reason))
   list(ok = TRUE, snapshot = snapshot, guard = guard,
        inputs_before = lapply(setdiff(guard$files_read, guard$files_written), .rs.rai.fileFingerprint))
}

# Observed run effects: bindings created / rebound / removed across the run
# boundary (identity comparison, nothing forced), and input-file fingerprints
# before vs after. Evidence only -- never a complete lineage claim.
.rs.rai.observeRunEffects <- function(record)
{
   before <- record$pre_snapshot
   if (is.null(before))
      return(NULL)
   after <- .rs.rai.globalSnapshot()
   created <- setdiff(after$names, before$names)
   removed <- setdiff(before$names, after$names)
   common <- intersect(before$names, after$names)
   identityBefore <- before$identities[match(common, before$names)]
   identityAfter <- after$identities[match(common, after$names)]
   comparable <- !is.na(identityBefore) & !is.na(identityAfter)
   rebound <- common[comparable & identityBefore != identityAfter]
   bookkeeping <- intersect(c(created, rebound, removed), .rs.rai.sessionBookkeeping)
   created <- setdiff(created, bookkeeping)
   rebound <- setdiff(rebound, bookkeeping)
   removed <- setdiff(removed, bookkeeping)

   derived <- .rs.rai.dataState$derived
   wasDerived <- vapply(rebound, function(name)
      exists(name, envir = derived, inherits = FALSE) &&
         !.rs.rai.isProtectedOriginal(name, before), logical(1L))
   wasAuthorized <- vapply(rebound, .rs.rai.authorizedExisting,
                           logical(1L), snapshot = before)
   originalsChanged <- rebound[!wasDerived & !wasAuthorized]
   originalsRemoved <- removed[!vapply(removed, function(name)
      exists(name, envir = derived, inherits = FALSE), logical(1L))]

   # Names this run's own guard classified as reader-loaded ORIGINAL data
   # (`name <- read.csv(...)` and similar): never record these as
   # Assistant-derived, even though they are newly created bindings, so a
   # LATER run cannot rebind/mutate them directly and pass the guard. Fixes
   # the confirmed defect where `rai_e2e_orig <- utils::read.csv(...)` was
   # treated as derived, letting a subsequent `rai_e2e_orig$v <- 0` pass.
   # Still reported in bindings_created (it IS a new binding this run made);
   # only excluded from the derived-identity bookkeeping below.
   originalTargets <- .rs.rai.orElse(record$original_targets, character(0))
   derivedEligible <- setdiff(c(created, rebound[wasDerived]), originalTargets)
   for (name in intersect(rebound[wasDerived], originalTargets))
      if (exists(name, envir = derived, inherits = FALSE))
         rm(list = name, envir = derived)

   # Record identities of Assistant-created/rebound derived bindings.
   for (name in if (isTRUE(record$tainted)) character(0) else derivedEligible)
   {
      identity <- after$identities[[match(name, after$names)]]
      if (!is.na(identity))
         assign(name, identity, envir = derived)
   }
   for (name in removed)
      if (exists(name, envir = derived, inherits = FALSE))
         rm(list = name, envir = derived)

   # Identity-bound authorization follows only a replacement that remains the
   # same bounded kind. A changed/unknown kind loses its designation and needs
   # fresh native type/identity validation before it can be rebound again.
   authorized <- .rs.rai.dataState$authorized
   authorizedKindLost <- character(0)
   for (name in rebound[wasAuthorized])
   {
      entry <- get(name, envir = authorized, inherits = FALSE)
      identity <- after$identities[[match(name, after$names)]]
      if (!is.na(identity) && startsWith(identity, "value:") &&
          .rs.rai.allowedDerivedKind(get(name, envir = globalenv(), inherits = FALSE), entry$kind))
         assign(name, list(kind = entry$kind, identity = identity), envir = authorized)
      else
      {
         rm(list = name, envir = authorized)
         authorizedKindLost <- c(authorizedKindLost, name)
      }
   }
   for (name in removed)
      if (exists(name, envir = authorized, inherits = FALSE))
         rm(list = name, envir = authorized)

   inputsAfter <- lapply(.rs.rai.orElse(record$inputs_before, list()), function(fingerprint)
   {
      now <- .rs.rai.fileFingerprint(fingerprint$path)
      same <- identical(fingerprint$exists, now$exists) &&
         identical(fingerprint$size, now$size) &&
         identical(fingerprint$sha256, now$sha256) &&
         (!is.null(fingerprint$sha256) || identical(fingerprint$mtime, now$mtime))
      list(path = fingerprint$path, unchanged = isTRUE(same),
           basis = if (!is.null(fingerprint$sha256)) "sha256" else "size+mtime",
           sha256 = fingerprint$sha256)
   })
   outputs <- lapply(.rs.rai.orElse(record$files_written, character(0)), function(path)
      if (identical(path, "<tempfile>")) list(path = path) else
      {
         fingerprint <- .rs.rai.fileFingerprint(path)
         fingerprint[intersect(names(fingerprint), c("path", "exists", "size", "sha256"))]
      })

   # Only documented scalar members of a file/effect record get a scalar
   # marker. Keep input_files/output_files and name collections as arrays.
   wireScalars <- function(fields)
      lapply(fields, function(value)
         if (is.atomic(value) && length(value) == 1L && !is.na(value)) I(value) else value)

   list(
      original_data_changed_observed = I(length(originalsChanged) > 0L || length(originalsRemoved) > 0L ||
         any(!vapply(inputsAfter, function(input) isTRUE(input$unchanged), logical(1L)))),
      # Both serializers must agree: RJson renders an unmarked length-one
      # vector as ["name"], while trace toJson renders it as "name". A list
      # of AsIs scalar names is a flat JSON array for both (also for 0/2+).
      bindings_created = lapply(as.list(created), I),
      bindings_rebound_derived = lapply(as.list(rebound[wasDerived]), I),
      bindings_rebound_authorized = lapply(as.list(rebound[wasAuthorized]), I),
      authorized_kind_lost = lapply(as.list(authorizedKindLost), I),
      originals_rebound = lapply(as.list(originalsChanged), I),
      originals_removed = lapply(as.list(originalsRemoved), I),
      session_bookkeeping_changed = lapply(as.list(bookkeeping), I),
      referenced_inputs = lapply(as.list(.rs.rai.orElse(record$static_inputs, character(0))), I),
      input_files = lapply(inputsAfter, wireScalars),
      output_files = lapply(outputs, wireScalars),
      identity_basis = I(if (isTRUE(before$complete) && isTRUE(after$complete))
         "native binding identity; in-place mutation of an unchanged binding is not observable"
      else "binding names only; rebinding not observable"),
      lineage = I("observed evidence at the run boundary, not a complete lineage"))
}

# Bind policy evidence and the durable "run_queued" trace record to a freshly
# registered run, immediately before it may reach the Console. The guard is
# re-evaluated here against the CURRENT workspace (an approval card may have
# waited). Any failure removes the registration: a run that cannot be traced,
# or that the data policy refuses, is never queued (fail closed).
.rs.rai.attachRunEvidence <- function(runId, approval)
{
   state <- .rs.rai.runState
   if (!exists(runId, envir = state$records, inherits = FALSE))
      return(list(ok = FALSE, reason = "could not register console run"))
   record <- get(runId, envir = state$records, inherits = FALSE)
   if (!is.null(record$trace_queued))
      return(list(ok = TRUE))

   discard <- function(reason)
   {
      if (exists(runId, envir = state$records, inherits = FALSE))
         rm(list = runId, envir = state$records)
      list(ok = FALSE, reason = reason)
   }

   evidence <- .rs.rai.prepareRunEvidence(record$code)
   if (!isTRUE(evidence$ok))
   {
      .rs.rai.appendTrace("run_refused", list(
         proposal_id = record$proposal_id, code = record$code, code_hash = record$code_hash,
         approval = approval, reason = evidence$reason))
      return(discard(evidence$reason))
   }

   link <- .rs.rai.appendTrace("run_queued", list(
      run_id = runId, proposal_id = record$proposal_id, code = record$code,
      code_hash = record$code_hash, digest = record$digest, approval = approval,
      working_directory = getwd(),
      referenced_inputs = as.list(evidence$guard$inputs),
      declared_targets = as.list(evidence$guard$targets),
      declared_files_read = as.list(evidence$guard$files_read),
      declared_files_written = as.list(evidence$guard$files_written),
      policy = "static original-data guard passed; not a proof of immutability"))
   if (is.null(link))
      return(discard("run refused: the durable code trace could not be written"))

   record$approval <- approval
   record$pre_snapshot <- evidence$snapshot
   record$inputs_before <- evidence$inputs_before
   record$static_inputs <- evidence$guard$inputs
   record$files_written <- evidence$guard$files_written
   record$original_targets <- evidence$guard$original_targets
   record$trace_queued <- link
   assign(runId, record, envir = state$records)
   list(ok = TRUE)
}

# Settle the observed effects and the "run_completed" trace record exactly
# once per run. Called from storeRunResult; a run that never executed
# (terminalized before capture) is traced without an effects diff.
.rs.rai.traceRunCompletion <- function(record, executed)
{
   if (is.null(record$trace_queued) || !is.null(record$trace_completed))
      return(record)
   effects <- if (isTRUE(executed)) tryCatch(.rs.rai.observeRunEffects(record),
                                             error = function(error) NULL) else NULL
   link <- .rs.rai.appendTrace(if (isTRUE(executed)) "run_completed" else "run_not_executed", list(
      run_id = record$run_id, proposal_id = record$proposal_id, code_hash = record$code_hash,
      queued_seq = record$trace_queued$seq, status = record$status, error = record$error,
      completion = record$completion, elapsed_ms = record$elapsed_ms,
      tainted = isTRUE(record$tainted), effects = effects))
   record$data_effects <- effects
   record$trace_completed <- if (is.null(link)) list(file = NULL, seq = NULL, error = "trace write failed") else link
   if (is.null(link))
   {
      # Execution already happened; missing durable completion is not success
      # and must stop the caller's next step. Preserve the original R error.
      record$status <- "error"
      record$error <- paste(c(record$error,
         "durable completion trace write failed; stop and request a fresh proposal"), collapse = "; ")
   }
   record$pre_snapshot <- NULL
   record$inputs_before <- NULL
   record
}

# Parse, gate (approval), and register a console run, returning its id. This
# function never evaluates or queues code itself: on "queued" the native session
# module enters the raw approved source as real Console input and captures the
# result from the console event stream (see .rs.rai.recordConsoleCapture). The
# owner / mode / policy gate runs here, once, before anything reaches the Console.
.rs.rai.queueConsoleRun <- function(proposalId, code, maxLines = 200L)
{
   if (!is.character(proposalId) || length(proposalId) != 1L || is.na(proposalId) ||
       !nzchar(proposalId))
      return(list(status = "error", message = "run_r requires proposal_id"))

   # Reject prose before approval; only syntactically valid R can be proposed.
   parsed <- tryCatch(parse(text = code, keep.source = TRUE), error = function(error) NULL)
   if (is.null(parsed) || !length(parsed))
      return(list(status = "error", message = "run_r accepts executable R code only"))

   # One proposal is one Console statement. "a; b" parses to two top-level
   # expressions, which would mean the user approves one card and the Console
   # runs two things, and the native capture -- which correlates a single
   # queued input with the output up to the next top-level prompt -- has no
   # unambiguous unit to attribute the result to. Multi-step work is proposed
   # as one expression by wrapping it: { a; b }.
   if (length(parsed) != 1L)
      return(list(status = "error",
                  message = "run_r accepts exactly one R statement per call"))

   # Lines after the statement would reach the Console as extra input, so the queued text ends with the statement.
   sourceLines <- strsplit(code, "\n", fixed = TRUE)[[1L]]
   lastLine <- as.integer(attr(parsed, "srcref")[[1L]])[[3L]]
   if (length(sourceLines) > lastLine)
      code <- paste(sourceLines[seq_len(lastLine)], collapse = "\n")
   # The Console cuts a line at 4094 bytes, so a longer line would run as text other than the text checked here.
   if (any(nchar(sourceLines[seq_len(min(lastLine, length(sourceLines)))], type = "bytes") > 4000L))
      return(list(status = "error",
                  message = "run_r lines must stay under 4000 bytes; split the code into shorter lines"))

   if (isTRUE(.rs.rai.consoleSessionUnsafe(parsed[[1L]])))
      return(list(status = "error",
                  message = "run_r rejects R forms that are not session-safe"))

   target <- .rs.rai.canonicalTarget("run_r", NULL)
   digest <- .rs.rai.proposalDigest("run_r", target, code, maxLines)
   key <- paste0("proposal\r", proposalId)
   if (exists(key, envir = .rs.rai.grantState$requests, inherits = FALSE))
   {
      request <- get(key, envir = .rs.rai.grantState$requests, inherits = FALSE)
      if (!identical(request$digest, digest) || !identical(request$preview, code) ||
          !identical(request$max_lines, maxLines))
         return(list(status = "error", message = "proposal_id payload mismatch"))
      # A failed approval may have lost its run registration when evidence
      # admission failed. It remains decided even if automatic approval is
      # now enabled or the evidence source has recovered.
      if (identical(request$decision, "failed"))
         return(list(status = "error", message = "approval request failed; submit a fresh proposal",
                     enqueue = "no"))
      if (identical(request$decision, "allow") && !is.null(request$run_id))
         return(.rs.rai.existingRunResponse(request))
   }

   # Full Auto has no approval request, but still has a registered run. An
   # exact retry must report its real outcome before rechecking a workspace
   # its own first execution may have changed; never queue it again.
   ids <- ls(.rs.rai.runState$records, all.names = TRUE)
   for (id in ids)
   {
      record <- get(id, envir = .rs.rai.runState$records, inherits = FALSE)
      if (!identical(record$proposal_id, proposalId))
         next
      if (!identical(record$code, code) || !identical(record$max_lines, maxLines) ||
          !identical(record$digest, digest))
         return(list(status = "error", message = "proposal_id payload mismatch"))
      return(.rs.rai.existingRunResponse(list(run_id = id, preview = code,
         digest = digest, proposal_id = proposalId)))
   }

   # New proposals alone pass the original-data guard. A refusal is final,
   # never a card; a cached response above grants no new execution.
   policy <- .rs.rai.prepareRunEvidence(code)
   if (!isTRUE(policy$ok))
   {
      .rs.rai.appendTrace("run_refused", list(proposal_id = proposalId, code = code,
                                              code_hash = .rs.rai.codeHash(code),
                                              reason = policy$reason))
      assign(key, list(requestId = paste0("rai-", basename(tempfile())),
         tool = "run_r", target = target, preview = code, digest = digest,
         proposal_id = proposalId, max_lines = maxLines, decision = "failed",
         reason = policy$reason, created_at = Sys.time()),
         envir = .rs.rai.grantState$requests)
      return(list(status = "error", message = policy$reason, policy = "refused"))
   }

   gate <- .rs.rai.checkGate(.rs.rai.ownerToken(), "run_r", NULL,
                             preview = code, proposalId = proposalId, maxLines = maxLines)
   if (!identical(gate, "ok"))
   {
      if (identical(gate, "blocked: automatic approval unavailable"))
         assign(key, list(requestId = paste0("rai-", basename(tempfile())),
            tool = "run_r", target = target, preview = code, digest = digest,
            proposal_id = proposalId, max_lines = maxLines, decision = "failed",
            reason = gate, created_at = Sys.time()), envir = .rs.rai.grantState$requests)
      return(list(status = if (startsWith(gate, "approval_required: "))
         "approval_required" else "error", message = gate))
   }

   runId <- .rs.rai.registerRun(code, maxLines, proposalId, digest)
   if (is.null(runId))
   {
      assign(key, list(requestId = paste0("rai-", basename(tempfile())),
         tool = "run_r", target = target, preview = code, digest = digest,
         proposal_id = proposalId, max_lines = maxLines, decision = "failed",
         reason = "could not register console run", created_at = Sys.time()),
         envir = .rs.rai.grantState$requests)
      return(list(status = "error", message = "could not register console run"))
   }
   autonomous <- tryCatch(.rs.rai.autoApproveReadOnlyEnabled(), error = function(error) NA)
   attached <- if (is.na(autonomous))
   {
      rm(list = runId, envir = .rs.rai.runState$records)
      list(ok = FALSE, reason = "automatic approval unavailable")
   }
   else .rs.rai.attachRunEvidence(runId, if (isTRUE(autonomous)) "autonomous" else "granted")
   if (!isTRUE(attached$ok))
   {
      # Evidence refusal removes the run registration. Preserve the spent
      # proposal in the existing decision store, without raising a card.
      assign(key, list(requestId = paste0("rai-", basename(tempfile())),
         tool = "run_r", target = target, preview = code, digest = digest,
         proposal_id = proposalId, max_lines = maxLines, decision = "failed",
         reason = attached$reason, created_at = Sys.time()),
         envir = .rs.rai.grantState$requests)
      return(list(status = "error", message = attached$reason, policy = "refused"))
   }

   record <- get(runId, envir = .rs.rai.runState$records, inherits = FALSE)
   # Result-cache eviction must not turn an already admitted proposal into a
   # fresh run. The existing decision store retains its exact run binding.
   assign(key, list(requestId = paste0("rai-", basename(tempfile())),
      tool = "run_r", target = target, preview = code, digest = digest,
      proposal_id = proposalId, max_lines = maxLines, decision = "allow",
      run_id = runId, created_at = Sys.time()), envir = .rs.rai.grantState$requests)
   list(status = "queued", run_id = runId, code = code, code_hash = record$code_hash,
       max_lines = record$max_lines, digest = digest,
       proposal_id = proposalId, enqueue = "yes")
}

.rs.addFunction("rai.ownerToken", .rs.rai.ownerToken)
.rs.addFunction("rai.stampOwner", .rs.rai.stampOwner)
.rs.addFunction("rai.checkGate", .rs.rai.checkGate)
.rs.addFunction("rai.listOpenDocuments", .rs.rai.listOpenDocuments)
.rs.addFunction("rai.conditionObserverReady", .rs.rai.conditionObserverReady)
.rs.addFunction("rai.registerRun", .rs.rai.registerRun)
.rs.addFunction("rai.getRunResult", .rs.rai.getRunResult)
.rs.addFunction("rai.getDebugInfo", .rs.rai.getDebugInfo)
.rs.addFunction("rai.parseErrorDetail", .rs.rai.parseErrorDetail)
.rs.addFunction("rai.parseWarnings", .rs.rai.parseWarnings)
.rs.addFunction("rai.safeObjectSummary", .rs.rai.safeObjectSummary)
.rs.addFunction("rai.dataObjectDetail", .rs.rai.dataObjectDetail)
.rs.addFunction("rai.environmentSummary", .rs.rai.environmentSummary)
.rs.addFunction("rai.warningOutputMatches", .rs.rai.warningOutputMatches)
.rs.addFunction("rai.recordConsoleCapture", .rs.rai.recordConsoleCapture)
.rs.addFunction("rai.terminalizeRun", .rs.rai.terminalizeRun)
.rs.addFunction("rai.queueConsoleRun", .rs.rai.queueConsoleRun)
.rs.addFunction("rai.authorizeDerivedBinding", .rs.rai.authorizeDerivedBinding)
.rs.addFunction("rai.consoleSessionUnsafe", .rs.rai.consoleSessionUnsafe)
.rs.addFunction("rai.isSafeReadOnlyR", .rs.rai.isSafeReadOnlyR)
.rs.addFunction("rai.autoApproveReadOnlyEnabled", .rs.rai.autoApproveReadOnlyEnabled)
.rs.addFunction("rai.readOnlyReject", .rs.rai.readOnlyReject)
.rs.addFunction("rai.storedDecision", .rs.rai.storedDecision)

# Every helper the functions above call must also be registered here.
# .rs.addFunction() rebinds a function's closure to the shared tools:rstudio
# environment (see Tools.R), so a helper left unregistered becomes
# unreachable the moment the throwaway local() sourcing scope it was
# originally defined in is garbage collected -- even though it looks fine
# under testthat, which sources this file directly into a plain env and
# fetches functions by name, bypassing this mechanism entirely.
.rs.addFunction("rai.targetForGrant", .rs.rai.targetForGrant)
.rs.addFunction("rai.canonicalTarget", .rs.rai.canonicalTarget)
.rs.addFunction("rai.isOpenDocumentId", .rs.rai.isOpenDocumentId)
.rs.addFunction("rai.targetDisplay", .rs.rai.targetDisplay)
.rs.addFunction("rai.grantMatches", .rs.rai.grantMatches)
.rs.addFunction("rai.grantAuthorizes", .rs.rai.grantAuthorizes)
.rs.addFunction("rai.proposalDigest", .rs.rai.proposalDigest)
.rs.addFunction("rai.codeHash", .rs.rai.codeHash)
.rs.addFunction("rai.requestKey", .rs.rai.requestKey)
.rs.addFunction("rai.chmodOwnerOnly", .rs.rai.chmodOwnerOnly)
.rs.addFunction("rai.userStateDir", .rs.rai.userStateDir)
.rs.addFunction("rai.policySecret", .rs.rai.policySecret)
.rs.addFunction("rai.policyPayload", .rs.rai.policyPayload)
.rs.addFunction("rai.policyMac", .rs.rai.policyMac)
.rs.addFunction("rai.projectPolicyPath", .rs.rai.projectPolicyPath)
.rs.addFunction("rai.readProjectGrants", .rs.rai.readProjectGrants)
.rs.addFunction("rai.writeProjectGrants", .rs.rai.writeProjectGrants)
.rs.addFunction("rai.requestApproval", .rs.rai.requestApproval)
.rs.addFunction("rai.editorApprovalExpired", .rs.rai.editorApprovalExpired)
.rs.addFunction("rai.existingRunResponse", .rs.rai.existingRunResponse)
.rs.addFunction("rai.recordGrant", .rs.rai.recordGrant)
.rs.addFunction("rai.findGrant", .rs.rai.findGrant)
.rs.addFunction("rai.setRunLimits", .rs.rai.setRunLimits)
.rs.addFunction("rai.boundText", .rs.rai.boundText)
.rs.addFunction("rai.pruneRuns", .rs.rai.pruneRuns)
.rs.addFunction("rai.evictRuns", .rs.rai.evictRuns)
.rs.addFunction("rai.storeRunResult", .rs.rai.storeRunResult)
.rs.addFunction("rai.openDocumentPath", .rs.rai.openDocumentPath)
.rs.addFunction("rai.orElse", .rs.rai.orElse)
.rs.addFunction("rai.isEnvironmentFile", .rs.rai.isEnvironmentFile)
.rs.addFunction("rai.isProtectedLocation", .rs.rai.isProtectedLocation)
.rs.addFunction("rai.literalStrings", .rs.rai.literalStrings)
.rs.addFunction("rai.setTraceDir", .rs.rai.setTraceDir)
.rs.addFunction("rai.traceDir", .rs.rai.traceDir)
.rs.addFunction("rai.jsonString", .rs.rai.jsonString)
.rs.addFunction("rai.toJson", .rs.rai.toJson)
.rs.addFunction("rai.nowUtc", .rs.rai.nowUtc)
.rs.addFunction("rai.appendTrace", .rs.rai.appendTrace)
.rs.addFunction("rai.globalSnapshot", .rs.rai.globalSnapshot)
.rs.addFunction("rai.isProtectedOriginal", .rs.rai.isProtectedOriginal)
.rs.addFunction("rai.authorizedExisting", .rs.rai.authorizedExisting)
.rs.addFunction("rai.allowedDerivedKind", .rs.rai.allowedDerivedKind)
.rs.addFunction("rai.foldPath", .rs.rai.foldPath)
.rs.addFunction("rai.callArgument", .rs.rai.callArgument)
.rs.addFunction("rai.assignmentRoot", .rs.rai.assignmentRoot)
.rs.addFunction("rai.dataGuard", .rs.rai.dataGuard)
.rs.addFunction("rai.fileFingerprint", .rs.rai.fileFingerprint)
.rs.addFunction("rai.prepareRunEvidence", .rs.rai.prepareRunEvidence)
.rs.addFunction("rai.observeRunEffects", .rs.rai.observeRunEffects)
.rs.addFunction("rai.attachRunEvidence", .rs.rai.attachRunEvidence)
.rs.addFunction("rai.traceRunCompletion", .rs.rai.traceRunCompletion)
.rs.addFunction("rai.utf8Safe", .rs.rai.utf8Safe)
.rs.addFunction("rai.recordConsoleCaptureText", .rs.rai.recordConsoleCaptureText)
.rs.addFunction("rai.splitCallMessage", .rs.rai.splitCallMessage)
.rs.addFunction("rai.documentEditReplayable", .rs.rai.documentEditReplayable)


.rs.rai.traceDiskWrite <- function(event, path, before, after)
{
   if (!is.character(event) || length(event) != 1L ||
       !event %in% c("edit_apply_requested", "edit_applied", "document_save_requested", "document_saved")) return(FALSE)
   !is.null(.rs.rai.appendTrace(event, list(path = path, before_digest = before,
      content_digest = after, target = "project_disk", approval = "autonomous")))
}
.rs.addFunction("rai.traceDiskWrite", .rs.rai.traceDiskWrite)
