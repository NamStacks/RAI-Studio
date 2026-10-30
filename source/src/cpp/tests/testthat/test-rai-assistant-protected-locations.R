#
# test-rai-assistant-protected-locations.R
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

# Every fixture holds dummy values in a temporary directory, and no proposal here is ever executed.

context("RAI Assistant protected locations")

prot_snapshot <- function() list(names = character(), identities = list())

prot_guard <- function(code, workingDir = tempdir())
{
   statements <- parse(text = code)
   result <- NULL
   for (statement in statements)
   {
      result <- aut_get(".rs.rai.dataGuard")(statement, prot_snapshot(), workingDir)
      if (!isTRUE(result$ok))
         break
   }
   result
}

prot_expect_refused <- function(code, reason, workingDir = tempdir())
{
   result <- prot_guard(code, workingDir)
   expect_false(result$ok, info = code)
   if (!isTRUE(result$ok))
      expect_match(result$reason, reason, info = code)
   invisible(result)
}

prot_denied_relative <- c(
   ".ssh/id_rsa", ".ssh/config", ".ssh/known_hosts", ".aws/credentials", ".aws/config",
   ".gnupg/pubring.kbx", ".kube/config", ".docker/config.json", ".azure/accessTokens.json",
   ".oci/config", ".kaggle/kaggle.json", ".huggingface/token", ".raistudio/assistant.json",
   ".claude/settings.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".cursor/mcp.json",
   ".config/gcloud/credentials.db", ".config/gh/hosts.yml", ".config/op/config",
   ".config/rclone/rclone.conf", ".config/opencode/auth.json",
   ".config/github-copilot/hosts.json", ".config/google-chrome/Default/Cookies",
   ".local/share/opencode/auth.json", ".local/share/keyrings/login.keyring",
   "Library/Keychains/login.keychain-db", "Library/Cookies/Cookies.binarycookies",
   "Library/Safari/History.db", "Library/Mail/V10/Envelope Index",
   "Library/Messages/chat.db", "Library/Accounts/Accounts4.sqlite",
   "Library/LaunchAgents/com.example.plist", "Library/LaunchDaemons/com.example.plist",
   "Library/Application Support/Google/Chrome/Default/Login Data",
   "Library/Application Support/Firefox/Profiles/x/cookies.sqlite",
   ".Renviron", ".Renviron.local", ".Rprofile", ".Rprofile.local", "Renviron.site", "Rprofile.site",
   ".env", ".env.local", ".env.production", ".envrc", ".netrc", ".npmrc", ".pypirc", ".pgpass",
   ".my.cnf", ".git-credentials", ".databrickscfg", ".vault-token", ".s3cfg", ".boto",
   ".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile",
   ".zsh_history", ".bash_history", ".Rhistory",
   "work/credentials", "work/credentials.json", "work/secrets.yml", "work/secret.txt",
   "work/id_rsa", "work/id_ed25519", "work/server.pem", "work/tls.key", "work/store.p12",
   "work/vault.kdbx", "work/trust.jks", "work/app.keystore", "work/putty.ppk",
   "work/repo/.git/config", "work/rsconnect/accounts/connect.example.com/user.dcf",
   ".grok/auth.json", ".grok/config.toml", ".claude.json", ".config/anthropic/api.json",
   ".openai/auth.json", "Library/Application Support/Claude/claude_desktop_config.json",
   "work/secret/key.txt", "work/secrets/db.yml", "work/Secrets/db.yml",
   ".zlogin", ".zlogout", ".login", ".logout", ".inputrc", ".bash_logout", ".cshrc", ".tcshrc",
   ".config/fish/config.fish", ".config/fish/conf.d/x.fish", ".zshrc.local",
   "work/repo/.git/hooks/pre-commit", "work/repo/.git/hooks/post-merge.sample",
   ".config/autostart/x.desktop", ".gitconfig", ".R/Makevars", ".R/Makevars-4.6",
   ".config/git/config", ".config/git/ignore", ".config/nvim/init.lua", ".zshrc.d/x.zsh", ".bashrc.d/x.sh",
   ".oh-my-zsh/custom/x.zsh", ".vimrc", ".tmux.conf", ".bash_aliases", ".zsh_sessions/A1.history",
   ".cache/huggingface/token", ".Rapp.history", "work/repo/.git/modules/sub/hooks/pre-commit",
   "work/repo/.git/modules/sub/config")

prot_denied_system <- c("/etc/passwd", "/etc/shadow", "/etc/sudoers", "/private/etc/master.passwd",
                        "/private/etc/sudoers", "/etc/sudoers.d/90-local", "/proc/1/environ", "/proc/self/environ")

prot_allowed_relative <- c(
   "work/data/raw.csv", "work/secrets_of_success.csv", "work/model.profile",
   "work/history/data.csv", "work/renv.lock", "work/.RData", "work/results.rda",
   "work/envelope.csv", "work/monkey.csv", "work/credentials_report.csv",
   "work/keys_table.csv", "work/environment.csv", "work/profile.R", "work/notes.env.md",
   "Documents/study/cohort.csv", "Downloads/table.xlsx", ".config/rstudio/rstudio-prefs.json",
   "Library/Application Support/RStudio/monitored-lists/file_mru", ".local/share/rstudio/log/x.log",
   "work/secret_santa.csv", "work/secretary/notes.csv", "work/secrets_of_success.R",
   "work/claude.json", "work/grok/notes.csv", "work/hooks/helper.R", "work/autostart/x.R",
   "work/fish/x.csv", "work/login.csv", "work/repo/.git/HEAD",
   "Library/Application Support/Claudette/x.json", ".config/anthropic-notes/x.csv",
   ".openai-notes/x.csv", ".grokking/x.csv", "work/model.profile.csv", "work/gitconfig.txt",
   "work/Makevars", "work/R/Makevars.md", "work/sudoers.d.csv")

test_that("the matcher denies credential, profile and system locations by name", {
   matcher <- aut_get(".rs.rai.isProtectedLocation")
   home <- file.path(tempdir(), "matcher-home")
   for (path in file.path(home, prot_denied_relative))
      expect_true(matcher(path), info = path)
   for (path in prot_denied_system)
      expect_true(matcher(path), info = path)
   for (path in file.path(home, prot_allowed_relative))
      expect_false(matcher(path), info = path)
   for (path in c("~/.ssh/id_rsa", "~/.SSH/ID_RSA", "~/.aws", "~/Library/LaunchAgents/x.plist",
                  ".Renviron", ".env", "sub/.ssh/id_rsa", "C:\\Users\\a\\.ssh\\id_rsa",
                  file.path(home, "Documents", "..", ".ssh", "id_rsa")))
      expect_true(matcher(path), info = path)
   expect_false(matcher(""))
   expect_false(matcher(NA_character_))
   expect_false(matcher(c(".ssh/a", ".ssh/b")))
})

test_that("every reader refuses every protected location without echoing the path", {
   fx <- aut_fixture()
   home <- file.path(fx$dir, "home")
   copy_target <- "file.path(tempdir(), 'copy.txt')"
   readers <- c("readLines(%s)", "read.csv(%s)", "readRDS(%s)", "scan(%s, what = character())",
                "utils::read.table(%s)", "file(%s, open = 'r')", "gzfile(%s, 'rb')",
                "load(%s, envir = new.env())", paste0("file.copy(%s, ", copy_target, ")"))
   paths <- c(file.path(home, prot_denied_relative), prot_denied_system)
   for (path in paths) for (reader in readers)
   {
      code <- sprintf(reader, deparse(path))
      result <- prot_guard(code)
      expect_false(result$ok, info = code)
      if (!isTRUE(result$ok))
      {
         expect_match(result$reason, "protected environment, credential or system", info = code)
         expect_false(grepl(path, result$reason, fixed = TRUE), info = code)
         expect_false(grepl(fx$dir, result$reason, fixed = TRUE), info = code)
      }
   }
})

test_that("ordinary data, lock files and look-alike names stay readable", {
   fx <- aut_fixture()
   root <- normalizePath(fx$dir, winslash = "/")
   for (relative in prot_allowed_relative)
   {
      path <- file.path(root, "home", relative)
      dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
      writeLines("SYNTHETIC_ALLOWED", path)
      for (code in c(paste0("readLines(", deparse(path), ")"),
                     paste0("read.csv(", deparse(path), ")"),
                     paste0("file(", deparse(path), ", open = 'r')")))
      {
         result <- prot_guard(code)
         expect_true(result$ok, info = code)
         if (isTRUE(result$ok))
            expect_identical(result$files_read, path, info = code)
      }
   }
   rdata <- file.path(root, "home", "work", ".RData")
   expect_true(prot_guard(paste0("load(", deparse(rdata), ", envir = new.env())"))$ok)
   expect_true(prot_guard(paste0("list.files(", deparse(file.path(root, "home", "work")), ")"))$ok)
   expect_true(prot_guard(paste0("file.exists(", deparse(file.path(root, "home", "work", "renv.lock")), ")"))$ok)
})

test_that("symlinks, relative spellings and not-yet-existing paths resolve to the protected target", {
   fx <- aut_fixture()
   root <- normalizePath(fx$dir, winslash = "/")
   secret_dir <- file.path(root, "home", ".ssh")
   dir.create(secret_dir, recursive = TRUE)
   secret <- file.path(secret_dir, "id_rsa")
   writeLines("SYNTHETIC_KEY", secret)
   proj <- file.path(root, "proj")
   dir.create(proj)
   expect_true(file.symlink(secret, file.path(proj, "notes.txt")))
   expect_true(file.symlink(secret_dir, file.path(proj, "linkdir")))
   before <- aut_get(".rs.rai.fileFingerprint")(secret)

   for (code in c(paste0("readLines(", deparse(file.path(proj, "notes.txt")), ")"),
                  paste0("readLines(", deparse(file.path(proj, "linkdir", "id_rsa")), ")"),
                  paste0("file(", deparse(file.path(proj, "notes.txt")), ", open = 'r')"),
                  paste0("list.files(", deparse(file.path(proj, "linkdir")), ")"),
                  paste0("file.info(", deparse(file.path(proj, "notes.txt")), ")")))
      prot_expect_refused(code, "protected environment, credential or system")

   for (code in c("readLines('notes.txt')", "readLines('linkdir/id_rsa')", "list.files('linkdir')"))
      prot_expect_refused(code, "protected environment, credential or system", workingDir = proj)

   for (code in c(paste0("writeLines('x', ", deparse(file.path(proj, "linkdir", "config")), ")"),
                  paste0("writeLines('x', ", deparse(file.path(proj, "linkdir", "sub", "deep", "config")), ")"),
                  paste0("cat('x', file = ", deparse(file.path(proj, "linkdir", "authorized_keys")), ")")))
      prot_expect_refused(code, "protected environment, credential or system|environment/profile")

   expect_identical(aut_get(".rs.rai.fileFingerprint")(secret), before)
   expect_false(file.exists(file.path(secret_dir, "config")))
   expect_false(file.exists(file.path(secret_dir, "sub")))
})

test_that("tilde and computed spellings the guard can fold are refused", {
   protected <- "protected environment, credential or system"
   for (code in c("readLines('~/.ssh/id_rsa')", "read.csv('~/.aws/credentials')",
                  "readRDS('~/.config/gh/hosts.yml')", "scan('~/.Renviron', what = '')",
                  "file('~/Library/Application Support/Google/Chrome/Default/Cookies', open = 'r')",
                  "readLines('/etc/passwd')", "readLines('~/.SSH/id_rsa')",
                  "readLines(file.path('~', '.ssh', 'id_rsa'))",
                  "readLines(paste0('~/', '.aws/credentials'))",
                  "readLines(paste('~', '.aws', 'credentials', sep = '/'))",
                  "file.copy('~/.Renviron', file.path(tempdir(), 'x'))"))
      prot_expect_refused(code, protected)
})

test_that("listing and metadata calls on protected paths are refused", {
   protected <- "protected environment, credential or system"
   for (code in c("list.files('~/.ssh')", "list.files(path = '~/.ssh', all.files = TRUE)",
                  "list.dirs('~/.aws')", "dir.exists('~/.ssh')", "file.exists('~/.ssh/id_rsa')",
                  "file.info('~/.aws/credentials')", "file.access('~/.ssh/id_rsa')",
                  "normalizePath('~/.ssh/id_rsa')", "file.exists('.env')", "file.exists('.Renviron')",
                  "file.info(c('data.csv', '~/.ssh/id_rsa'))",
                  "x <- '~/.ssh'; list.files(x)",
                  "list.files(file.path('~', '.ssh'))",
                  "list.files(paste0('~/', '.ssh'))",
                  "file.exists(file.path('~', '.aws', 'credentials'))"))
      prot_expect_refused(code, protected)
   for (code in c("sapply('~/.ssh/id_rsa', file.exists)", "lapply(c('a.csv', '~/.ssh/id_rsa'), readLines)",
                  "lapply(file.path('~', '.ssh', 'id_rsa'), readLines)"))
      prot_expect_refused(code, "^refused: ")
})

test_that("listing and metadata calls on ordinary paths still pass", {
   fx <- aut_fixture()
   root <- normalizePath(fx$dir, winslash = "/")
   writeLines("a,b", file.path(root, "data.csv"))
   for (code in c(paste0("list.files(", deparse(root), ")"),
                  paste0("file.exists(", deparse(file.path(root, "data.csv")), ")"),
                  paste0("file.info(", deparse(file.path(root, "data.csv")), ")"),
                  "file.exists(tempfile())", "list.files(tempdir())", "getwd()",
                  "message('see the project folder for details')"))
      expect_true(prot_guard(code)$ok, info = code)
})

test_that("write destinations in protected locations are refused", {
   fx <- aut_fixture()
   root <- normalizePath(fx$dir, winslash = "/")
   source_file <- file.path(root, "source.txt")
   writeLines("SYNTHETIC_SOURCE", source_file)
   destinations <- c("~/.ssh/config", "~/.ssh/authorized_keys", "~/Library/LaunchAgents/com.example.plist",
                     "~/.zprofile", "~/.zshrc", "~/.bashrc", "~/.config/gh/hosts.yml",
                     "~/.aws/credentials", "~/.raistudio/policy.json",
                     file.path(root, "repo", ".git", "config"),
                     file.path(root, "repo", "rsconnect", "accounts", "connect.example.com", "u.dcf"))
   existed <- vapply(destinations, file.exists, logical(1L))
   for (destination in destinations)
   {
      target <- deparse(destination)
      for (code in c(paste0("writeLines('x', ", target, ")"),
                     paste0("cat('x', file = ", target, ")"),
                     paste0("write.csv(data.frame(a = 1), ", target, ")"),
                     paste0("saveRDS(1, ", target, ")"),
                     paste0("file(", target, ", open = 'w')"),
                     paste0("file.copy(", deparse(source_file), ", ", target, ")")))
         prot_expect_refused(code, "protected environment, credential or system|environment/profile")
   }
   ok <- prot_guard(paste0("writeLines('x', ", deparse(file.path(root, "out.txt")), ")"))
   expect_true(ok$ok)
   expect_identical(ok$files_written, file.path(root, "out.txt"))
   for (destination in destinations[!existed])
      expect_false(file.exists(destination), info = destination)
})

test_that("Sys.getenv refuses the no-argument form and secret-looking names", {
   refused <- c("Sys.getenv()", "Sys.getenv(names = TRUE)", "Sys.getenv(unset = '')",
                "Sys.getenv('RAI_OWNER_TOKEN')", "Sys.getenv('RAI_BRIDGE_TOKEN')",
                "Sys.getenv('RAI_SESSION_TOKEN')", "Sys.getenv('rai_owner_token')",
                "Sys.getenv(x = 'RAI_OWNER_TOKEN')", "base::Sys.getenv('RAI_OWNER_TOKEN')",
                "Sys.getenv('ANTHROPIC_API_KEY')", "Sys.getenv('GITHUB_TOKEN')",
                "Sys.getenv('AWS_SECRET_ACCESS_KEY')", "Sys.getenv('DB_PASSWORD')",
                "Sys.getenv('MYSQL_PASSWD')", "Sys.getenv('GOOGLE_CREDENTIALS')",
                "Sys.getenv('GH_AUTH')", "Sys.getenv('COOKIE_JAR')", "Sys.getenv('SESSION_ID')",
                "Sys.getenv(c('HOME', 'GITHUB_TOKEN'))",
                "Sys.getenv(paste0('RAI_', 'OWNER_TOKEN'))",
                "Sys.getenv(name)", "Sys.getenv(intToUtf8(c(72, 79, 77, 69)))")
   for (code in refused)
      prot_expect_refused(code, "Sys.getenv")
   for (code in c("vapply('HOME', Sys.getenv, '')", "sapply('RAI_OWNER_TOKEN', base::Sys.getenv)",
                  "do.call(Sys.getenv, list('RAI_OWNER_TOKEN'))", "vapply('RAI_OWNER_TOKEN', 'Sys.getenv', '')"))
      prot_expect_refused(code, "^refused: ")
   for (code in c("Sys.getenv('HOME')", "Sys.getenv('USER')", "Sys.getenv('PATH')",
                  "Sys.getenv('MY_DATA_DIR')", "Sys.getenv('TZ', unset = 'UTC')",
                  "Sys.getenv(c('HOME', 'LANG'))", "base::Sys.getenv('R_LIBS_USER')",
                  "Sys.getenv('HOME', names = TRUE)", "Sys.getenv(x = 'LC_ALL')"))
   {
      result <- prot_guard(code)
      expect_true(result$ok, info = code)
   }
})

test_that("escape-hatch namespaces are refused as whole namespaces", {
   for (code in c("reticulate::py_run_string('1')", "ps::ps_environ()", "parallel::makeCluster(2)",
                  "parallel::detectCores()", "keyring::key_get('service')",
                  "gitcreds::gitcreds_get()", "askpass::askpass('prompt')",
                  "dotenv::load_dot_env()"))
      prot_expect_refused(code, "outside the Assistant's R Console scope")
})

test_that("a refused read is final at the queue: error, policy refused, traced, no run, no card", {
   fx <- aut_fixture()
   root <- normalizePath(fx$dir, winslash = "/")
   secret <- file.path(root, "home", ".ssh", "id_rsa")
   dir.create(dirname(secret), recursive = TRUE)
   writeLines("SYNTHETIC_KEY", secret)
   before <- aut_get(".rs.rai.fileFingerprint")(secret)
   for (code in c(paste0("readLines(", deparse(secret), ")"), "Sys.getenv('RAI_OWNER_TOKEN')",
                  paste0("writeLines('x', ", deparse(file.path(root, "home", ".zprofile")), ")")))
   {
      result <- aut_queue(code)
      expect_identical(result$status, "error", info = code)
      expect_identical(result$policy, "refused", info = code)
      expect_null(result$run_id, info = code)
      expect_false(grepl("SYNTHETIC_KEY", result$message, fixed = TRUE), info = code)
   }
   records <- aut_trace_records(fx)
   expect_length(Filter(function(r) identical(r$event, "run_refused"), records), 3L)
   expect_length(Filter(function(r) identical(r$event, "run_queued"), records), 0L)
   expect_length(fx$events$items, 0L)
   expect_length(ls(aut_get(".rs.rai.runState")$records, all.names = TRUE), 0L)
   expect_identical(aut_get(".rs.rai.fileFingerprint")(secret), before)
   expect_false(file.exists(file.path(root, "home", ".zprofile")))
})

test_that("the native owner token getter and other RStudio internals are unreachable from a proposal", {
   for (code in c(".rs.rai.ownerToken()", "local(.rs.rai.ownerToken())", "x <- .rs.rai.ownerToken; x()",
                  "do.call('.rs.rai.ownerToken', list())", ".Call('rs_raiOwnerToken', PACKAGE = '(embedding)')",
                  "utils::getAnywhere('.rs.rai.ownerToken')", "message(.rs.rai.ownerToken())",
                  "f <- '.rs.rai.ownerToken'; f", "Sys.getenv(NULL)", "Sys.getenv(x = NULL)",
                  "local({ Sys.getenv('GITHUB_TOKEN') })", "f <- function() Sys.getenv('GITHUB_TOKEN'); f()",
                  "tryCatch(Sys.getenv('GITHUB_TOKEN'), error = function(e) NULL)"))
      prot_expect_refused(code, "^refused: ")
   fx <- aut_fixture()
   result <- aut_queue("local({ x <- .rs.rai.ownerToken; x() })")
   expect_identical(result$status, "error")
   expect_identical(result$policy, "refused")
   expect_length(fx$events$items, 0L)
})

test_that("bare relative names of protected files are refused for every reader", {
   fx <- aut_fixture()
   root <- normalizePath(fx$dir, winslash = "/")
   protected <- "protected environment, credential or system|environment/profile"
   for (name in c(".Renviron", ".env", ".Rprofile", "credentials"))
   {
      for (code in c(sprintf("readLines('%s')", name), sprintf("read.csv('%s')", name),
                     sprintf("readRDS('%s')", name), sprintf("scan('%s', what = '')", name),
                     sprintf("file('%s', open = 'r')", name),
                     sprintf("load('%s', envir = new.env())", name)))
         prot_expect_refused(code, protected, workingDir = root)
      for (code in c(sprintf("readr::read_lines('%s')", name), sprintf("yaml::read_yaml('%s')", name),
                     sprintf("utils::read.fwf('%s', widths = 1)", name),
                     sprintf("readBin('%s', 'raw')", name), sprintf("file.exists('%s')", name)))
         prot_expect_refused(code, "^refused: ", workingDir = root)
   }
})

test_that("the owner token is read from the native side and never from the process environment", {
   module <- file.path(.rs.sessionModulePath(), "SessionRaiAssistant.R")
   lines <- readLines(module, warn = FALSE)
   expect_false(any(grepl("Sys\\.getenv\\(\\s*[\"']RAI_OWNER_TOKEN", lines)))
   expect_true(is.function(aut_get(".rs.rai.ownerToken")))

   assignments <- Filter(function(node)
      is.call(node) && as.character(node[[1L]])[[1L]] %in% c("<-", "=") &&
         identical(as.character(node[[2L]]), ".rs.rai.ownerToken"),
      as.list(parse(module, keep.source = FALSE)))
   expect_length(assignments, 1L)
   definition <- assignments[[1L]][[3L]]
   expect_true(is.call(definition) && identical(definition[[1L]], as.name("function")))
   text <- paste(deparse(definition[[3L]]), collapse = " ")
   expect_true(".Call" %in% all.names(definition[[3L]]))
   expect_match(text, "rs_raiOwnerToken", fixed = TRUE)
   expect_false("Sys.getenv" %in% all.names(definition[[3L]]))
   expect_false(grepl("RAI_OWNER_TOKEN", text, fixed = TRUE))
})

test_that("a proposal with more than one statement is refused whole and every statement is guarded", {
   expect_false(prot_guard("x <- 1; readLines('~/.ssh/id_rsa')")$ok)
   expect_false(prot_guard("y <- 2\nSys.getenv('GITHUB_TOKEN')")$ok)
   prepared <- aut_get(".rs.rai.prepareRunEvidence")("x <- 1; readLines('~/.ssh/id_rsa')")
   expect_false(prepared$ok)
   expect_match(prepared$reason, "exactly one R statement")
})

test_that("try() cannot write its error text to a file", {
   for (code in c("try(stop('x'), outFile = 'try-out.txt')", "try(stop('x'), TRUE, 'try-out.txt')",
                  "try(stop('x'), silent = TRUE, outFile = file.path(tempdir(), 'try-out.txt'))",
                  "base::try(stop('x'), outFile = '~/.zshrc')", "try(stop('x'), out = 'try-out.txt')",
                  "try(stop('x'), outF = stderr())", "try(expr = stop('x'), silent = TRUE, outFile = stdout())"))
      prot_expect_refused(code, "^refused: ")
   for (code in c("try(log(-1))", "try(log(-1), silent = TRUE)", "base::try(log(1), TRUE)",
                  "message('see the project folder for details')", "warning('check the cohort size')"))
      expect_true(prot_guard(code)$ok, info = code)
})

test_that("native-code compilers, interpreters and network listeners are refused as whole namespaces", {
   refused <- aut_get(".rs.rai.dataGuardRefusedNamespaces")
   for (name in c("Rcpp", "RcppArmadillo", "RcppEigen", "cpp11", "inline", "V8", "httpuv", "rJava",
                  "plumber", "servr"))
      expect_true(name %in% refused, info = name)
   for (code in c("Rcpp::evalCpp('1 + 1')", "Rcpp::cppFunction('int f() { return 1; }')",
                  "RcppArmadillo::armadillo_version()", "RcppEigen::RcppEigen.package.skeleton()",
                  "cpp11::cpp_source(code = 'x')", "inline::cfunction(body = 'x')",
                  "V8::v8()", "httpuv::startServer('0.0.0.0', 8080, list())",
                  "rJava::.jinit()", "plumber::pr()", "servr::httd()"))
      prot_expect_refused(code, "outside the Assistant's R Console scope")
   expect_false(any(c("curl", "httr", "httr2", "gh") %in% refused))
})

test_that("string literals in any argument of a third-party call are screened for protected locations", {
   skip_if_not(requireNamespace("base64enc", quietly = TRUE))
   protected <- "protected environment, credential or system"
   for (code in c("base64enc::base64encode('.Renviron')", "base64enc::base64encode(what = '.env')",
                  "base64enc::base64encode('credentials')", "base64enc::base64encode(c('a.csv', '.Rprofile'))",
                  "base64enc::base64encode(file.path('~', '.ssh', 'id_rsa'))",
                  "base64enc::base64encode('~/.ssh/id_rsa')", "base64enc::base64encode('.grok/auth.json')",
                  "base64enc::base64encode(file.path(Sys.getenv('HOME'), '.ssh', 'id_rsa'))",
                  "base64enc::base64encode(paste0(Sys.getenv('HOME'), '/.aws/credentials'))"))
      prot_expect_refused(code, protected)
   expect_true(prot_guard("base64enc::base64encode('plain.csv')")$ok)
})

test_that("Sys.getenv refuses connection strings, short password names and credential-bearing URLs", {
   refused <- c("DATABASE_URL", "REDIS_URL", "MONGO_URL", "MONGODB_URL", "POSTGRES_URL", "MYSQL_URL",
                "AMQP_URL", "BROKER_URL", "CELERY_BROKER_URL", "DB_PASS", "SMTP_PASS", "MYSQL_PWD",
                "DB_PW", "APP_PW_FILE", "SENTRY_DSN", "DATABASE_DSN", "AZURE_CONNECTION_STRING",
                "PRIVATE_NOTES", "MY_PRIVATE", "SESSION_ID", "SESSION_TOKEN", "SESSION_KEY",
                "SESSION_COOKIE", "SESSION_SECRET", "R_SESSION_SECRET", "database_url")
   for (name in refused)
      prot_expect_refused(sprintf("Sys.getenv('%s')", name), "Sys.getenv")
   allowed <- c("R_SESSION_TMPDIR", "PWD", "OLDPWD", "HOME", "PASSENGER_COUNT", "SPW", "COMPASS_DIR",
                "REDIS_HOST", "DATABASE_NAME", "MY_DATA_URL", "TMPDIR", "R_HOME")
   for (name in allowed)
      expect_true(prot_guard(sprintf("Sys.getenv('%s')", name))$ok, info = name)
})

test_that("the R and C++ protected-location pattern lists are identical", {
   candidates <- c(file.path(.rs.sessionModulePath(), "SessionRaiAssistant.cpp"),
                   file.path(.rs.sessionModulePath(), "..", "SessionRaiAssistant.cpp"),
                   test_path("..", "..", "session", "modules", "SessionRaiAssistant.cpp"))
   source_file <- candidates[file.exists(candidates)][1L]
   expect_false(is.na(source_file))
   lines <- readLines(source_file, warn = FALSE)
   start <- grep("kPatterns\\[\\] = \\{", lines)
   expect_length(start, 1L)
   end <- start + which(grepl("\\};\\s*$", lines[start:length(lines)]))[1L] - 1L
   block <- lines[(start + 1L):end]
   extracted <- regmatches(block, regexec('R"\\((.*)\\)"[,}]*;?\\s*$', block))
   cpp_patterns <- vapply(extracted, function(m) if (length(m) == 2L) m[[2L]] else NA_character_, character(1L))
   expect_false(anyNA(cpp_patterns))
   r_patterns <- unname(unlist(aut_get(".rs.rai.protectedLocationPatterns")))
   expect_identical(cpp_patterns, r_patterns)
})

test_that("file URLs resolve to the protected path they name", {
   for (code in c("readLines('file:///etc/shadow')", "readLines('file://localhost/etc/passwd')",
                  "readLines('file:///etc/master.passwd')", "scan('FILE:///private/etc/shadow', what = '')"))
      expect_false(prot_guard(code)$ok, info = code)
   expect_true(prot_guard("readLines('file:///tmp/notes.txt')")$ok)
})
