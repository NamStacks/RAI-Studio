# RAI-Studio

RAI-Studio is RStudio with a built-in terminal for Claude Code, Codex CLI, OpenCode and Grok Build. Mac only.

**Beta (version 0.1.63).** Expect rough edges, and please report them.

RAI-Studio is an independent fork of the open-source RStudio IDE. Its built-in MCP connector, the RAI tools, gives the assistant in the pane a controlled link to your live R session: your objects, plots, open files and Console. This page walks through installing it and using it for R coding and analysis.

## What you get

- **Four assistants in one pane.** Claude Code, Codex CLI, OpenCode and Grok Build run as their own command-line programs in a real terminal next to your editor and Console. You pick the model inside each assistant.
- **20 RAI tools.** Every assistant gets the same set: read your environment, plots and open files, edit code, run R in your real Console, and audit a notebook.
- **Guard rails on the RAI tools.** Existing objects and files are protected from overwrites, secret locations are refused, and every run is logged. The assistants' own tools are not covered by these rules.
- **Settings.** General (assistant, sign-in, theme, font size, keep awake), Global (standing instructions) and Snippets (up to five prompt buttons).
- **/rai-audit.** A 13-phase audit of a notebook and your live session that looks for wrong numbers that raise no error. Claude Code, Grok Build and OpenCode list a `/rai-audit` command for the session. Codex CLI rejects any command it does not know, so there you write "Run the RAI audit". The two audit tools work in all four assistants.

## Install

RAI-Studio runs on Macs with Apple silicon or Intel. It was tested only on Apple silicon (see Known limits).

1. **Install R** (tested with R 4.6.0). RAI-Studio does not include R.
2. **Install at least one assistant.** RAI-Studio does not include them. Sign-in uses your own subscription (API-key mode is not supported). You do not need to install Node.js for RAI-Studio itself.
   - Claude Code: https://docs.claude.com/en/docs/claude-code/setup
   - Codex CLI: https://github.com/openai/codex#installation
   - OpenCode: https://opencode.ai/docs/
   - Grok Build: `curl -fsSL https://x.ai/cli/install.sh | bash`
3. **Download `RAI-Studio-0.1.63-beta-universal.dmg`** (about 790 MB) from the [Releases page](https://github.com/NamStacks/RAI-Studio/releases), open it and drag RAI-Studio to Applications. It is signed with a Developer ID and notarized by Apple. To check the file, run `shasum -a 256 RAI-Studio-0.1.63-beta-universal.dmg` and compare the result with `SHA256SUMS`.
4. **Open your R project** in RAI-Studio, then open the assistant pane with the **RAI Assistant** toolbar button, **View > Show RAI Assistant**, or **Ctrl+Cmd+I**. The shortcut toggles the pane, so pressing it on an open pane hides it again. The pane opens over the Environment/Files column on the right.
5. **Sign in.** Click the gear in the pane toolbar, stay on General, pick your assistant and press **Sign in**. The assistant's own login runs in the pane. Claude Code is the default.

The app looks for the programs `claude`, `codex`, `opencode` and `grok` on your PATH and in the usual places (Homebrew, `~/.local/bin`, npm global, bun, pnpm, yarn, Volta, nvm). If the selected program is missing, the pane shows a message such as "claude not found on PATH. Install it or pick another provider in Settings." The first word is the program's name.

## Tour of the pane

The pane toolbar has four icon-only buttons. The names show when you hover.

| Button | What it does |
|---|---|
| Restart terminal | Reloads the pane and reconnects to the same running assistant. The conversation stays. |
| Reset Assistant | Starts a fresh assistant in the open project. The conversation is lost. Use it after you open a different project. An older assistant that is still running stops by itself after about 60 seconds without a pane. |
| Keep Mac Awake | On by default. Keeps the display lit and idle sleep off (system sleep too, on AC power) for as long as an assistant is running, even when it sits idle, so it uses battery. Turn it off if you leave your Mac unattended. Same switch as the checkbox in General. |
| RAI Assistant settings (gear) | Opens Settings. |

More things to know:

- The RAI Assistant toolbar button turns **blue** while the assistant is busy and **green** when it is idle. Busy and idle are a guess from terminal output: one second of silence counts as idle. A snippet clicked at the wrong moment is typed into whatever the terminal shows, so check the terminal first. It is still never sent. You can hide the toolbar button with a right-click. The View menu still opens the pane.
- **Restart Assistant** is a separate button at the top right of the terminal. It appears only after you save a changed assistant or changed Global instructions. It works only while the assistant is idle, and you click it twice (the second label is "Confirm restart"). It ends the current conversation.
- The conversation survives **Session > Restart R** and pane reloads. After a reload, the last 512 KB of terminal output is replayed. A pane left detached for 60 seconds stops the assistant.
- A running assistant keeps the folder it started in. After you open another project, press Reset Assistant.
- While the assistant watches a long R run (with monitor_console_run), a strip above the terminal shows state, elapsed seconds, quiet seconds, output size and the time left in the current watch window (labeled "deadline"; 30 seconds unless the assistant asks for longer). It is not an estimate of how long the R run will take. It never shows Console text.
- The terminal keeps 10,000 lines of scrollback.

## Settings

Open Settings with the gear. Press **Save changes** to keep your edits, or Cancel. If you close with edits, it asks "Unsaved changes. Save, discard, or continue editing?" Everything is stored in `~/.raistudio/assistant.json`.

### General

- **Provider list.** Claude Code, Codex CLI, OpenCode and Grok Build, each with a state: Signed in, Sign in needed, Not installed, Unknown or Checking.
- **Sign in / Sign in again / Check sign-in.** Sign in saves your settings, stops the running assistant (unsent text in its input box is lost) and runs the assistant's own login in the pane (`claude auth login`, `codex login`, `opencode auth login`, `grok login --device-auth`). When the login ends, the assistant restarts by itself. Grok uses a device code: the terminal prints a URL and a code. If Grok Build is already signed in, nothing is run again and its terminal just opens. Check sign-in re-runs the check.
- **How sign-in is checked.** Claude Code: `claude auth status`. Codex CLI: `codex login status`. OpenCode: `~/.local/share/opencode/auth.json`. Grok Build: `~/.grok/auth.json`. The app shows only a state word, never account details. OpenCode and Grok Build are checked by file, so an expired login can still read Signed in. A check that takes more than 5 seconds shows Unknown.
- **Theme.** Black (default) or White.
- **Font size.** Small (10), Medium (12) or Large (14).
- **Keep Mac awake.** On by default.

Theme and font size preview as you click. Theme, font size, keep awake and snippets take effect when you press Save changes, with no restart. Cancel discards your draft, including deleted, reordered or reset snippets. A changed assistant or changed Global instructions applies after Restart Assistant.

To switch assistants: pick one in General, press Save changes, then press Restart Assistant twice when the assistant is idle.

### Global

One box for standing instructions that every new assistant session starts with. Write your conventions once, for example "use the base pipe", "report review findings by severity" or "keep code comments to one sentence".

- Up to 16,384 bytes of text. It can be empty.
- It is added to the assistant's instructions when a session starts, so press Restart Assistant after you save.
- It cannot change the assistant's permissions or the RAI tools' safety rules.
- Do not put secrets in it. It is stored as plain text in `assistant.json`. Claude Code, OpenCode and Grok Build read it from a private, owner-only session file. Codex CLI receives it, together with RAI-Studio's built-in instructions, on its command line, where other programs on your Mac can see it.
- Every assistant also gets RAI-Studio's own built-in instructions for using the RAI tools, even when this box is empty.

### Snippets

Up to five buttons that appear above the terminal. A click **types** the text into the assistant's input box. Nothing is sent until you press Enter.

| Default button | Text |
|---|---|
| Explain code | Explain what this code does. |
| Debug | Find the cause of this error and suggest a fix. |
| Review code | Check this code for bugs and suggest improvements. |
| Writing review | Make this writing clearer without changing its meaning. |
| Analysis review | Check the analysis and flag unsupported conclusions. |

- A name is 1 to 48 characters. A prompt is one line of up to 300 characters. Names must differ.
- Use **+** to add, **-** to delete (second click: "Confirm delete"), Move up and Move down to reorder, and Reset defaults (second click: "Confirm reset defaults") to restore the five above. Zero snippets is allowed. These changes are a draft until you press Save changes.
- If the assistant is busy, the text waits in a "Queued draft" box (Undo staging, Clear) and is typed in when the assistant is idle. It is still never sent.
- A status line in Settings > Snippets checks prompts that start with a skill name for your saved assistant. For Claude Code (`/name`) and Codex CLI (`$name`) it says whether a skill file was found in the project folder or your home folder; for Claude Code it also counts the skills that ship with RAI-Studio, so `/rai-audit` reads as found. In Grok Build and OpenCode only `/rai-audit` is checked, and it reads as found because RAI-Studio registers it for the session. The line cannot confirm that the assistant loads the skill. For Codex CLI it suggests "Run the RAI audit" in place of `/rai-audit`, which Codex rejects. Any other OpenCode snippet gets "ask its native skill tool by name", and any other Grok Build snippet gets "inserted as plain text". RAI-Studio never installs skills in your folders.
- Writing review and Analysis review are plain prompts. They do not start `/rai-audit`. The assistant's built-in instructions describe them as suggestion-only and observational, but the button types only the sentence above. The assistant cannot see which button produced the text, so it may or may not apply those instructions, and a renamed or edited snippet gets no such guidance. Nothing locks the tools.

Ideas for your own snippets (keep each on one line): "Summarize my objects and flag anything odd.", "Show me the code you would run before you run it.", or `/rai-audit` in Claude Code, Grok Build or OpenCode (in Codex CLI, "Run the RAI audit").

## The RAI tools

The RAI tools are an MCP connector that each assistant loads for its session. In Claude Code they appear as `mcp__rai_studio_session_<random>__run_r` and so on; the random part changes each launch. There are 20 tools in four groups.

**See your session (read only)**

| Tool | What it does |
|---|---|
| get_environment_summary | Lists the first 100 objects in your global environment (sorted by name, capital letters first; dot-names hidden) with their class. For up to 20 named objects it gives dimensions, column names and classes (first 40 columns) and missing-value counts over the first 1,000 rows. It never returns cell values, but it does return names, which can be sample or patient IDs, and they go to your AI provider. |
| get_plot_history | Lists up to 100 Plots pane entries and which have a rendered image. |
| get_plot_image | Returns the already-rendered Plots pane PNG (up to 4 MB) for the active plot or a history entry. It never redraws. |
| list_notebook_outputs | Lists cached chunk output images of an open R Markdown document (up to 250). Images only, not text or tables. |
| get_notebook_output_image | Returns one cached image. Refuses if the document changed since the list. |
| get_viewer_state | Says whether the Viewer pane is active and its kind. No address and no content. |
| get_debug_info | For a finished run: error detail, warnings and summaries of up to 20 named objects. No live traceback. |

**Read and edit code**

| Tool | What it does |
|---|---|
| get_active_document_context | Which editor tab is focused: an opaque id, unsaved flag and size. No path and no text. |
| list_open_documents | The open code tabs the tools may read (R, R Markdown and other code types). Open data or config tabs such as CSV or JSON are not listed. |
| read_open_document | Reads the live editor text, unsaved changes included, in 64 KB pages. |
| edit_document | Edits an open code file: one exact text replacement, or the whole buffer. |
| get_project_context | The project folder name and the working directory relative to it. With no project open it only reports that none is open. |
| read_project_file | Reads a UTF-8 text file in the open project (up to 10 MB, 64 KB pages), data files like CSV included. Needs an open project. It is not blocked in `data` or `raw` folders, and what it reads goes to your AI provider. |
| write_project_file | Overwrites an existing code file that is not open. It cannot create files and it makes no backup copy. Needs an open project. |

**Run R**

| Tool | What it does |
|---|---|
| run_r | Proposes one R statement. If it passes the checks below, it runs in your real Console. |
| get_run_result | Reads a run's status, output and errors. It never re-runs code. |
| monitor_console_run | Watches a run the assistant started with run_r, every 5 seconds, up to 2 hours per call, and never interrupts R. No RAI tool can interrupt, restart or kill R. |
| authorize_existing_derived_binding | Lets the assistant rebind one existing plot list, helper function or output-path variable, for plain reassignment only. Automatic, no prompt. Data frames stay protected. |

**Audit:** `get_audit_workflow` and `audit_session`. See /rai-audit below.

<details>
<summary><strong>What run_r accepts</strong> (rules, limits, what is refused, what is logged)</summary>

The code appears in your Console exactly as run, followed by its real output, and the objects it makes are in your live session.

- **One top-level R statement per call**, up to 8,000 bytes. Several steps go in one `{ }` block.
- **One run at a time.** A second, different run is refused with "a console run is already in progress".
- **Output is trimmed** to 200 lines (up to 1,000 on request) and 8,000 characters per stream. A finished result is kept for up to 30 minutes, and only the 20 most recent runs are kept.
- **Original data is guarded.** Before a run, the code is checked and refused if it would change, replace or remove an object that already existed in your session, or overwrite or remove an existing file. Exceptions: objects the assistant created in an earlier run (but not an object it loaded straight from a file with a reader such as `read.csv()`, which stays protected), and a plot list, helper function or output-path variable the assistant marked with authorize_existing_derived_binding. Results go to new object names and new file paths. A write is refused when any folder in the destination's full path (even above your project) is named `raw`, `data`, `ref`, `reference`, `references` or `environment`. The check reads the code before it runs and cannot see everything R can do (for example reference objects or code inside package functions), so it is a guard, not a guarantee. Back up raw data.
- **Only listed functions run,** plus helper functions defined inside the same statement or created earlier by the assistant, which are inspected first. The list covers basics (arithmetic, `c`, `list`, `data.frame`, `head`, `summary`, `str`, `merge`, `aggregate`, `lm`, `glm`, `mean`, `sd`, `cor`, `lapply`, `sapply` and similar) and file readers and writers with a literal path. Many everyday functions are not on it (for example `exists()`, `as.Date()` and `Sys.sleep()`), so expect refusals. Ask the assistant for another way, or run that step yourself.
- **Packages.** `pkg::fn()` calls into other installed packages (for example `DESeq2::DESeq()`, `limma::eBayes()`, `ggplot2::ggplot()`) are accepted after a name and argument check. If the package is already loaded and that function's code is already in memory, its body is scanned too. Functions from base, stats, utils, graphics and the file-format packages follow the list.
- **Refused:** anything not on the list, with the message `refused: autonomous callee has no approved effect contract`. Examples: `library()`, `plot()`, `t.test()`, `table()`, `stats::t.test()` and `base::table()`. Also always refused: package installs, `source()`, `setwd()`, `options()`, `system()`, `eval()`, `parse()`, `get()`, `do.call()`, file deletes and renames, `sink()`, rendering with `rmarkdown::render`, `knitr::knit`, `knitr::purl`, `knitr::spin`, `knitr::knit2html` or `quarto::quarto_render`, and packages that control processes or the IDE. Run those yourself in the Console and ask the assistant to read the result.
- **Secrets are refused:** SSH and cloud credentials, password stores, browser data, Keychains, git config, shell startup files, history files, private keys, `.Renviron`, `.Rprofile`, `.env`, the assistants' own login folders, any folder named `secret` or `secrets`, and environment variables whose names contain KEY, TOKEN, SECRET, PASSWORD, AUTH and similar. The list is a block list, not a guarantee.
- **The network is not blocked.** The assistant is told to use it only when you ask.
- **Plots are yours to draw.** `plot()` is refused, so you run the plotting code in the Console. Then the assistant reads the figure with get_plot_history and get_plot_image. It is told the image is downscaled and not to judge small text from it.
- **Runs and edits are logged** to `~/.raistudio/trace/rai-trace-YYYYMMDD.jsonl` (one file per UTC day). Each run is logged with its exact code, and so is each proposal refused by the original-data or secrets checks. A proposal rejected earlier (several statements, over 8,000 bytes, not valid R, or a form such as `eval`, `parse`, `get` or `do.call`) is not logged. Each `edit_document` edit logs its old and new text; `write_project_file` logs only the path and checksums. Console output is not stored, but the first line of an R error message and the names of objects and files a run touched are. Reads through read_open_document and read_project_file are not logged; files that run_r code reads are. If the log cannot be written (full disk, unwritable `~/.raistudio`), the run is refused. RAI-Studio never deletes these files, and they can hold sensitive text.

</details>

<details>
<summary><strong>What edit_document and write_project_file accept</strong> (file types, folder rule, saving, backups)</summary>

- **Code files only:** R, Rmd, qmd, Rnw, Rd, Python, shell, SQL, CSS, Markdown, C, C++, Java and similar, plus DESCRIPTION, NAMESPACE, Makefile and Dockerfile. Data and config files are refused (csv, tsv, txt, json, xml, yaml, html, tex, rds, xlsx, images and many more).
- **Folder rule:** if any folder in the file's full path is named `data`, `raw`, `raw_data`, `rawdata`, `raw-data`, `data-raw`, `reference`, `references` or `extdata` (any capitals), even a script there is refused. This includes folders above your project: a project stored under `~/data/myproject` gets every RAI edit and file write refused. Files under `.git`, `renv`, `packrat`, `.ssh` and similar folders are refused too, and so is a path with a non-ASCII character.
- **Read the whole file first.** The assistant must read it through in 64 KB pages. Then it sends one exact replacement (the old text must occur exactly once) or the whole new buffer. In an `.Rmd` it must also send the text just before and after. One replacement is limited to 32,768 bytes and its context to 2,048.
- **Your changes win.** If the file has unsaved changes of yours, the edit is refused ("pre-existing human dirtiness: save or discard it before an automatic edit"). If you type after the assistant read, or the file changed on disk since, the edit is refused as stale. Read-only tabs, hard-linked files and names with a colon or a trailing dot or space are refused too.
- **Saved at once, with a backup.** A named, saved file in UTF-8 with LF line endings is written to disk, and a copy of the old file goes to the session scratch folder first (the edit result reports it as `backup_path`). If the backup fails, the edit is refused. No setting turns the automatic save off. A file with any carriage return, another encoding, or an untitled file changes in the editor only (`Edit applied; file not saved: <reason>`). Only `saved: true` means it reached disk.
- **Undo restores the editor only,** not a file already saved. The scratch folder is not a permanent history, so keep your project under version control.
- **write_project_file is different:** it works on a file that is not open, and it keeps no backup. Only the path and the old and new checksums go to the trace log.
- The assistant's own file tools (for example Claude Code's) are not covered by any of these rules.

</details>

## /rai-audit

**What it is.** A step-by-step audit of the focused script or notebook together with the objects, figures and tables in your live R session. It looks for mistakes that give a wrong number without any error: silent coercion, filters applied twice, degenerate model fits, captions that disagree with the data. The audit tools only track progress and cannot run R or edit files.

**Before you start.** R must be idle, a code document must be open and focused, and a project must be open. A rendered notebook is not required. The checks that read values (data, provenance, arithmetic and tables) run R and need your explicit permission; without it those phases are reported as not covered. The RAI tools are pre-approved in Claude Code and Codex CLI, so this permission is an instruction to the assistant, not a lock. Grok Build and OpenCode apply their own approval rules and may still ask before a tool call.

**Keep still while it runs.** Do not edit, save, open or close any file, switch editor tabs, restart R or type in the Console. Any of these ends the audit, and the assistant has to start over. At most 8 audits can start in one assistant session (completed, canceled and ended audits all count), so restart the assistant if you reach the limit.

**How to start.**

- **Claude Code:** type `/rai-audit` and press Enter. RAI-Studio loads the skill for that session only; Claude Code lists it as `/rai-audit:rai-audit` and completes your typing to it. If a `SKILL.md` already exists in `~/.claude/skills/rai-audit/` (or under `$CLAUDE_CONFIG_DIR/skills/rai-audit/`), RAI-Studio does not load its own copy and your skill answers `/rai-audit`.
- **Grok Build:** type `/rai-audit`. RAI-Studio puts the skill in the session folder it makes for Grok, so nothing is written to your project or home folder. If you already have a `rai-audit` skill in a folder Grok reads, such as `~/.grok/skills` or `~/.agents/skills`, RAI-Studio does not add its own.
- **OpenCode:** type `/rai-audit`. RAI-Studio adds it as a command in the session's inline configuration, so nothing is written to your project or home folder. If you already have a `rai-audit` command, yours stays. OpenCode 2 is started with `--standalone` when your OpenCode has that flag, so that it reads this session's configuration instead of the shared background service.
- **Codex CLI:** Codex rejects any command it does not know, and RAI-Studio cannot add one for a single session without writing to your Codex folders. Write "Run the RAI audit" and press Enter. The assistant's instructions tell it to load the audit workflow and start the audit.

**It is observational by design.** The skill tells the assistant that starting `/rai-audit` does not authorize running chunks, refreshing caches or editing source, and that a fix or a run needs a separate request from you. The skill also tells the assistant to ask before any choice that can change a scientific result (cohort rules, transformations, thresholds, models, missing-data handling, multiple-testing policy, interpretation). These are instructions, not locks: the assistant's own file and shell tools are outside every RAI rule.

**The 13 phases, in order**

| # | Phase | What it checks |
|---|---|---|
| 0 | Reachability | The R session is reachable and idle. |
| 1 | Source | The code in the live editor and on disk, and how loops and helpers batch their work. |
| 2 | IDE | The project, the document and its unsaved state. |
| 3 | Metadata | Objects in the session: names, binding kinds and classes for the first 100, the total count and whether the list was cut off. No values are read. |
| 4 | Data | Types, missing values, ranges, factor levels, keys, dates, encoding. |
| 5 | Provenance | Whether each object matches its source, caches, and corrected versus raw data. |
| 6 | Arithmetic | Denominators, pooled totals, joins, probabilities, degenerate fits. |
| 7 | Figures | Plots pane figures and cached notebook images, one representative per code path. |
| 8 | Tables | Row counts, headers, covariates and denominators. Displayed cell values only if you separately ask. |
| 9 | Claims | What captions, subtitles and prose say against what the session shows. |
| 10 | Review | The code through six lenses: silent wrong numbers, statistical validity, state and data flow, reproducibility and raw input and output, simplification, figures and presentation. |
| 11 | Fixes | Only if you ask: edit the shared source, then restart the audit and re-check. |
| 12 | Report | All findings, clean checks and anything skipped. |

<details>
<summary><strong>Examples of what it checks</strong> (source, data, provenance, arithmetic, figures and tables, claims)</summary>

- *Source:* chunk headers with `eval=` that silently skip a chunk, duplicate `eval=` options (knitr and RStudio disagree), error handlers that nobody hears, tables keyed on the first non-NULL fit, a suffix pattern that also matches a pooled column, a model refit inside a figure chunk, a filter applied twice.
- *Data:* class, NA count and unique count per column, strings like `<5` that turn a number column into text, ages or proportions out of range, unused factor levels, duplicated IDs, joins that grew the row count, trailing spaces, bad dates.
- *Provenance:* a corrected matrix that is identical to its input, success flags that nobody verified, a cache that was recomputed instead of loaded.
- *Arithmetic:* pooled cohort versus the sum of its parts, proportions that do not sum to 1, a hazard ratio from an arm with zero events, one percentage computed twice with different denominators, a QC metric that can only come out one way.
- *Figures and tables:* axis labels that name a different variable than the one mapped, rows dropped silently, empty panels, color scales that clamp a degenerate estimate into the strongest color, a pooled row that flattens its parts on a shared axis, rounding that crosses a p-value threshold, a constant label column.
- *Claims:* a caption such as "adjusted for age, sex and stage" against the coefficient names in the stored fit.

</details>

**The report.** It appears in the chat. There is no report file. Each finding has a status (FIXED, FLAGGED, OPEN or CONFIRMED), the file and line or the live object, and the exact evidence. Clean checks and skipped or partial coverage are listed too. A finished audit does not prove the analysis is clean: the tools say plainly that coverage is bounded.

**Limits.** Checkpoints live in memory and are lost if the connection restarts. Images are reviewed from a downscaled PNG, and cached notebook images are historical, not proof of a current run. Unit tests cover the audit tracker, its evidence rules and its launch wiring. No end-to-end test runs `/rai-audit` in this beta.

## The four assistants

| | Claude Code | Codex CLI | OpenCode | Grok Build |
|---|---|---|---|---|
| Program | `claude` | `codex` | `opencode` | `grok` |
| Starts in | project folder | project folder | project folder | a session folder with a `project` link to your project |
| `/rai-audit` command | yes | no (write "Run the RAI audit") | yes | yes |
| RAI tools pre-approved by RAI-Studio | yes | yes | no (its own rules decide) | no (its own rules decide) |

The project folder is the open RStudio project, or the R working directory when no project is open. That is normally your home folder in a fresh session, and the assistant's own tools can then read all of it. The read_project_file and write_project_file tools and the audit still need an open project.

RAI-Studio does not write to your assistants' own config files. It passes its wiring at launch: Claude Code gets an extra config file, Codex CLI gets command-line overrides, OpenCode gets one environment variable and, when its version supports the flag, `--standalone`, and Grok Build gets a config and the audit skill inside its session folder under `~/.raistudio/grok-sessions`. If you already set `OPENCODE_CONFIG_CONTENT` and RAI-Studio cannot merge with it, OpenCode starts without the RAI tools and the terminal prints a notice that begins with [RAI] RAI MCP wiring skipped. The assistants still write to their own folders themselves. For example, Grok Build records its trust of RAI-Studio's session folder in `~/.grok/trusted_folders.toml`, and that entry stays there if you remove RAI-Studio.

You choose the model and reasoning effort inside each assistant. RAI-Studio does not show or set them.

## A first session

1. Open your project and the R script or R Markdown file you want to work on.
2. Open the assistant pane if it is closed (Ctrl+Cmd+I toggles it, so pressing it on an open pane hides it). Check that the assistant is signed in.
3. Ask in the terminal, or click a snippet and press Enter. For example: "Summarize the data frames in my session."
4. The assistant reads your environment and the open file. When it runs R, the code and output appear in your Console.
5. When it edits an open file with the RAI edit tool, the change appears in the editor. A saved file in UTF-8 with LF line endings is also written to disk at once, after a backup copy. Other files change in the editor only, and you save them yourself. The assistant's built-in instructions also tell it to use its own file tools for source edits and full rewrites. Those write straight to disk and are not covered by the RAI rules, the backup or the trace log.
6. Review the change with the editor's Undo (editor only), your version control, or the trace log.
7. To draw a figure, run the plot code yourself, then ask the assistant to review it.
8. After you open another project, press Reset Assistant.

## Tips

- **Set Global instructions once** with your habits: pipe style, comment style, how to report findings, "ask before changing a threshold".
- **Keep raw data in a folder named `raw` or `data`** and write results to new names. The RAI edit and write tools refuse to touch files there, and run_r refuses code that writes there (a guard, not a guarantee). The RAI tools can still read those files, and what they read goes to your AI provider. The assistant's own tools can still write there, so keep a backup.
- **Use version control.** Edits to saved files hit the disk at once.
- **For long jobs,** have the assistant start the job with run_r and then ask it to monitor that run. It cannot watch code you typed into the Console yourself. To stop a runaway run, press Stop in the Console; no RAI tool can.
- **For R Markdown,** run the chunks yourself. The assistant sees plots from inline chunks only as cached images. If you ask it to run a document chunk by chunk, it goes through run_r, so chunks with `library()` or plotting calls are refused. Run those yourself.
- **Install packages yourself** in the Console. Installs are refused through the RAI tools.
- **Voice input.** RAI-Studio is signed with the microphone entitlement, so voice features of the assistant programs, such as Claude Code's voice input, can use your microphone after you allow access when macOS asks the first time. You can change this in System Settings > Privacy & Security > Microphone (System Preferences > Security & Privacy on macOS 12).

## If something goes wrong

| What you see | What to do |
|---|---|
| "claude not found on PATH. Install it or pick another provider in Settings." | Install the program from the link or command above, or pick another assistant and press Save changes. Then press Restart terminal or Reset Assistant. Restart Assistant stays off until an assistant is running. If the program is installed and you still see this message, it may have failed to start; look in `~/.raistudio/bridge-<port>.log`. |
| State "Sign in needed" | Press Sign in. |
| State "Unknown" | Press Check sign-in. |
| `refused: autonomous callee has no approved effect contract` | The function is not on the run_r list. Run it in the Console and ask the assistant to read the result. |
| "a console run is already in progress" | Wait for the current run, then ask again. |
| "pre-existing human dirtiness: save or discard it before an automatic edit" | Save or discard your changes in that file. |
| "refused: only code files are editable; data, environment/profile and unknown files are read-only" | The file is data or config, or a folder in its path (even above your project) is named `data`, `raw` or similar. Edit it yourself. |
| `Edit applied; file not saved: <reason>` | If the reason is an untitled file, CRLF or another encoding, save it yourself. If it says "inspect disk", look at the file on disk before you save or retry. |
| "Node.js or the RAI Assistant bridge could not be found. See setup docs." (it may end with a detail in parentheses) | Close the pane and open it again, or quit and reopen RAI-Studio. If it stays, another program may be using the pane's local port (quit it), or the app is damaged (drag RAI-Studio from the disk image to Applications again). `~/.raistudio/bridge-<port>.log` shows why. There are no separate setup docs: these notes are them. |
| "Claude Code exited (code N). Reconnecting for a fresh session…" | The name changes with the assistant. The banner says it is reconnecting, but a new session starts only after your next key press (that key press does not reach the assistant). Or press Reset Assistant. |
| The assistant works in the wrong folder | Press Reset Assistant. |

## Known limits in this beta

- **No sandbox.** Assistants can read anything you can, and their own tools are not limited by the RAI tool rules. Keep sensitive files out of reach and back up raw data.
- **No approval prompts from RAI-Studio for the RAI tools.** RAI-Studio pre-approves them for Claude Code and Codex CLI at launch, so they run without asking unless your own assistant settings say otherwise. For OpenCode and Grok Build, RAI-Studio adds no approval setting for the RAI tools, so their own prompts may still appear. (RAI-Studio does start Grok Build with `--trust` for its own session folder, so Grok does not ask about trusting that folder.)
- **Local server.** The assistant pane talks to a server on 127.0.0.1. Any program or user account on the same Mac can reach it, and with that can type into the assistant's terminal. Use RAI-Studio on a Mac you do not share.
- **Your data goes to your provider.** What the assistant reads, including files, plots and Console output, is sent to its AI provider.
- **Tested only on Apple silicon running macOS 27.** The Intel half is built and signed but has not been run. Intel Macs older than macOS 15 may not render R Markdown or Quarto documents. macOS 12 is the build target.
- **Assistant testing.** Claude Code has end-to-end tests with a stand-in program that calls the RAI tools. Grok Build has end-to-end tests of launch, saving Grok as the assistant, and opening the terminal with an existing login, using a stand-in that only records how it was launched. The device-code sign-in is not covered end to end. For Codex CLI and OpenCode, tests check the launch command and environment and start the RAI connector from that launch to list tools and call one audit tool. No end-to-end test drives the real Codex CLI or OpenCode. Expect rough edges.
- **Updates.** The app does not check for updates. Help > Check for Updates shows the address of the Releases page.
- **Branding.** The app icon and splash screen use the RStudio logo, and some dialogs, error messages and help links still say RStudio. The default CRAN mirror is the one RStudio ships with. RStudio is a trademark of Posit Software, PBC. RAI-Studio is not made, endorsed or supported by Posit, so please do not contact Posit for support.
- Posit Assistant is off by default, GitHub Copilot is not included, and the interface is in English.
- Two RAI-Studio program files (rsession and rsession-arm64), the bundled OpenSSL library and the Apple silicon Pandoc contain folder paths from the machine that built them. They are plain text and do not change how the app runs.

## Files and folders

<details>
<summary><strong>Where RAI-Studio keeps things</strong></summary>

- `~/.raistudio/assistant.json`: all Settings, including Global instructions and snippets. If it cannot be read, a copy of the original is kept as `assistant.json.recovery-<hash>`.
- `~/.raistudio/trace/`: the daily run and edit log.
- `~/.raistudio/bridge-<port>.log`, `.port` and `terminal-<port>.tty`: per RAI-Studio window.
- `~/.raistudio/grok-sessions/`: Grok Build session folders.
- Short-lived session files in `~/.raistudio` (owner-only; they include a session token and a copy of your Global instructions): removed when the assistant is restarted or reset, otherwise at the next launch after you quit or crash.
- The session scratch folder: pre-edit backups named `rai-pre-edit-XXXXXX`.
- Your assistants' own folders (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.grok`): RAI-Studio does not write to them, and the RAI tools refuse to read or write them. The assistants themselves still do.

</details>

## Release files

Each release page carries:

- `RAI-Studio-0.1.63-beta-universal.dmg`: signed with a Developer ID and notarized by Apple, for Apple silicon and Intel.
- `RAI-Studio-0.1.63-beta-source.tar.gz`: the matching source (AGPL-3.0).
- `SHA256SUMS`

Report problems at https://github.com/NamStacks/RAI-Studio/issues.

## Privacy

RAI-Studio has no accounts or servers of its own. We found no code in it, or in the RStudio code it is built on, that sends usage statistics or crash reports. The bundled Quarto can add Google Analytics or Plausible to a website you build, but only when you turn that on in your own project. Your assistant sends what it reads, including files, plots and console output, to its own AI provider. RAI-Studio keeps a local log of the R code the assistant ran and of its edits in `~/.raistudio/trace`, and it never deletes it for you. Features inherited from RStudio contact their own services. Package installs go to your CRAN mirror. If a package source in `options(repos)` is a Package Manager repository (a URL ending in a snapshot date or `latest`), the vulnerability check runs at every session start and after package changes, and sends the names and versions of your installed packages to it; a plain CRAN mirror URL avoids this. Citation lookups in the visual editor go to Crossref, PubMed and similar services, and these requests and R's package downloads identify themselves as RStudio. Formatting with Air downloads that program from GitHub. If you turn on Posit Assistant, it downloads from `cdn.posit.co` and then talks to Posit's AI service. The update check and GitHub Copilot are described above.

## License and source

RAI-Studio is based on RStudio and is licensed under the GNU Affero General Public License version 3 (see `LICENSE`). Third-party components keep their own licenses (see `source/NOTICE`).

The source for this release is in `source/` at tag `v0.1.63-beta` and in `RAI-Studio-0.1.63-beta-source.tar.gz` on the release page. See `SOURCE.md` for what it contains and what was left out.

RStudio is a trademark of Posit Software, PBC. This project uses the name to say which software RAI-Studio is based on and to describe features it inherits from that software.

## Versions

Beta tags are `v<build>-beta`. `<build>` is the RAI-Studio developer build number, which is the version in the app's Info.plist and in Finder. Every beta therefore maps to exactly one developer build. The About box shows the same number and the commit of the source that was built. The checksum of each disk image is in `SHA256SUMS` on its release page. The commit shown in the About box is the one the tag points to. `main` can be newer when only the documentation changed.
