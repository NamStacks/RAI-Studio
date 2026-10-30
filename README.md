<div align="center">

# RAI-Studio

An independent fork of RStudio with an AI assistant that can read your R session and run code in your Console.

Use Claude Code, Codex CLI, OpenCode or Grok Build. Mac only. Public beta, so expect rough edges.

[![Download](https://img.shields.io/github/v/release/NamStacks/RAI-Studio?include_prereleases&label=download&color=2ea44f)](https://github.com/NamStacks/RAI-Studio/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[Install](#install) | [Safety](#safety) | [Privacy](#privacy) | [Full guide](https://github.com/NamStacks/RAI-Studio/releases/tag/v0.1.64-beta) | [Report a problem](https://github.com/NamStacks/RAI-Studio/issues)

</div>

<table align="center"><tr><td width="760">

https://github.com/user-attachments/assets/5bf8fa2e-502b-481c-b9f7-ae9d9f56b242

</td></tr></table>

<p align="center">A mock-up of how the RAI Assistant works in RAI-Studio.</p>

## What it does

- **Four assistants in one pane.** Claude Code, Codex CLI, OpenCode and Grok Build run in a real terminal next to your editor and Console. You pick the model inside each one.
- **A live link to your R session.** The assistant can see your objects, plots and open files, edit code, and run R in your Console, where the code and its output show up. It does this through RAI-Studio's own tools, called the RAI tools.
- **Safety checks.** Before R code runs, the RAI tools check it, refuse to overwrite objects or files that already existed, and log every run. They are a guard, not a guarantee. See [Safety](#safety).
- **/rai-audit.** An audit of a notebook and your live session that looks for wrong numbers that raise no error.

## Install

Tested only on Apple silicon Macs running macOS 27. The Intel version is built and signed but has not been run, and Intel Macs older than macOS 15 may not render R Markdown or Quarto documents. The interface is in English.

1. **Install R** from [CRAN](https://cran.r-project.org/). RAI-Studio does not include it (tested with R 4.6.0).
2. **Install at least one assistant.** RAI-Studio does not include them. You sign in with your own subscription (API keys are not supported).
   - [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)
   - [Codex CLI](https://github.com/openai/codex#installation)
   - [OpenCode](https://opencode.ai/docs/)
   - Grok Build: paste `curl -fsSL https://x.ai/cli/install.sh | bash` into the Terminal app
3. **Download the .dmg file** (about 790 MB) from the [latest release](https://github.com/NamStacks/RAI-Studio/releases/latest), open it and drag RAI-Studio to Applications. It is signed with a Developer ID and notarized by Apple. To check the download, run `shasum -a 256` on the .dmg file and compare the result with the SHA256SUMS file on the release page.
4. **Open RAI-Studio and your R project.** Open the assistant pane with the **RAI Assistant** toolbar button, **View > Show RAI Assistant** or **Ctrl+Cmd+I**. The shortcut shows or hides the pane.
5. **Sign in.** Click the gear in the pane toolbar, pick your assistant and press **Sign in**. Claude Code is the default.

The app does not check for updates. **Help > Check for Updates** shows the address of the [Releases page](https://github.com/NamStacks/RAI-Studio/releases).

## Use it

1. Open your project and the R script or R Markdown file you want to work on.
2. Ask in the pane's terminal, or click a snippet button and press Enter. For example: "Summarize the data frames in my session."
3. The assistant reads your session, runs R in your Console and can edit your open files.
4. The assistant can run only approved R functions, plus checked calls into functions of installed packages. If a step is refused, such as `library()`, `plot()` or a package install, run it yourself in the Console and ask the assistant to read the result.
5. After you open another project, press **Reset Assistant** in the pane toolbar. This starts a fresh conversation, and the current one is lost.

### Settings

Click the gear in the pane toolbar.

- **General:** pick your assistant, sign in, and choose the theme, the font size and whether to keep your Mac awake while an assistant runs, even when it sits idle (on by default, so it uses battery; turn it off if you leave your Mac unattended).
- **Global:** instructions every new session starts with, such as "use the base pipe". Do not put secrets in it. It is stored as plain text, and Codex CLI receives it in a way that other programs on your Mac can see.
- **Snippets:** up to five buttons that type a prompt for you. Nothing is sent until you press Enter.

Press **Save changes** to keep your edits. After you change the assistant or the Global instructions, press **Restart Assistant** (top right of the terminal, click twice) when the assistant is idle. This ends the current conversation.

### Audit a notebook

`/rai-audit` checks the open script or notebook together with the objects, figures and tables in your live R session. It looks for mistakes that give a wrong number without any error, such as a filter applied twice or a caption that does not match the model.

- In Claude Code, Grok Build and OpenCode, type `/rai-audit`. In Codex CLI, write "Run the RAI audit".
- R must be idle, and a project must be open with a code file in the front tab. The checks that read values run R, so the assistant is told to ask your permission first. While it runs, do not edit, save, open or close files, switch tabs, restart R or type in the Console, or the audit stops and has to start over.
- The report appears in the chat, with the evidence for each finding. The assistant is told to report first and to fix things only if you ask. These are instructions, not locks, and a finished audit does not prove your analysis is clean.

The [full guide](https://github.com/NamStacks/RAI-Studio/releases/tag/v0.1.64-beta) covers every RAI tool, every setting, the audit phases and the known limits.

## Safety

- **No sandbox.** The assistants are not kept in a protected box. They can read anything you can, and their own tools are not limited by the RAI safety checks. Keep sensitive files out of reach.
- **No approval prompts from RAI-Studio.** It pre-approves the RAI tools for Claude Code and Codex CLI, so they run without asking unless your own assistant settings say otherwise. OpenCode and Grok Build use their own approval rules and may still ask.
- **Edits reach your disk.** An edit to a saved file is usually written to disk right away, after a backup copy in a temporary folder. The assistant is also told to use its own file tools for source edits and full rewrites. Those write straight to disk, with no backup and no log from RAI-Studio. One RAI tool, which overwrites a closed code file, also keeps no backup, and Undo does not bring back a saved file. Use version control (for example git).
- **Protect raw data.** Keep it in a folder named `raw` or `data`, write results to new names, and keep a backup. The RAI tools refuse to change files there (a guard, not a guarantee), but the assistants' own tools can. The RAI tools can still read those files, and what they read goes to your AI provider.
- **The network is not blocked.** The assistant is told to use it only when you ask.
- **Local helper program.** The pane talks to a helper program on your Mac. Any other program or user account on the same Mac can connect to it and type into the assistant's terminal. Use RAI-Studio on a Mac you do not share.

## Privacy

- RAI-Studio has no accounts or servers of its own. We found no code in it, or in the RStudio code it is built on, that sends usage statistics or crash reports. The bundled Quarto can add Google Analytics or Plausible to a website you build, but only when you turn that on in your own project.
- Your assistant sends what it reads, including files, plots and Console output, to its own AI provider.
- RAI-Studio keeps a local log of the R code the assistant ran and of its edits in `~/.raistudio/trace`. The log can hold sensitive text, and RAI-Studio never deletes it for you.
- Posit Assistant is off by default. If you turn it on, it downloads from `cdn.posit.co` and then talks to Posit's AI service. GitHub Copilot is not included.

<details>
<summary>Services that features inherited from RStudio contact (CRAN, Crossref, PubMed, GitHub, Package Manager)</summary>

- Package installs go to your CRAN mirror, and citation lookups in the visual editor go to services such as Crossref and PubMed. These requests and R's package downloads identify themselves as RStudio. Formatting with Air downloads that program from GitHub.
- If any package source in your R setup is a Package Manager server (an address ending in a snapshot date or `latest`), the names and versions of your installed packages are sent to it to check for known security problems, each time a session starts and after package changes. A plain CRAN mirror avoids this.

</details>

## If something goes wrong

| What you see | What to do |
|---|---|
| "claude not found on PATH. Install it or pick another provider in Settings." (the first word changes with the assistant) | Install that assistant, or pick another one in Settings and press Save changes. Then press Reset Assistant. |
| "Sign in needed" or "Unknown" in Settings | Press Sign in for "Sign in needed", or Check sign-in for "Unknown". |
| `refused: autonomous callee has no approved effect contract` | The RAI tools do not allow that R function. Run that step in the Console yourself and ask the assistant to read the result. |
| `Edit applied; file not saved: <reason>` | If the reason is an untitled file, CRLF (Windows line endings) or another encoding, the change is in the editor only, so save the file yourself. If it says "inspect disk", look at the file on disk before you save or retry. |
| "Node.js or the RAI Assistant bridge could not be found. See setup docs." | There are no separate setup docs. Close the pane and open it again, or quit and reopen RAI-Studio. If it stays, another program may be using the pane's local port (quit it), or the app is damaged (drag RAI-Studio from the disk image to Applications again). |

## License

RAI-Studio is an independent fork of the open-source RStudio IDE and is licensed under the GNU Affero General Public License version 3 (see [LICENSE](LICENSE)). Third-party components keep their own licenses (see [source/NOTICE](source/NOTICE)).

The source for this release is in [source/](source) at tag `v0.1.64-beta` and in the file RAI-Studio-0.1.64-beta-source.tar.gz on the release page. See [SOURCE.md](SOURCE.md) for what it contains and what was left out.

The app icon and splash screen use the RStudio logo, and some dialogs, error messages and help links still say RStudio. The default CRAN mirror is the one RStudio ships with. RStudio is a trademark of Posit Software, PBC. RAI-Studio is not made, endorsed or supported by Posit, so please do not contact Posit for support. This project uses the name to say which software RAI-Studio is based on and to describe features it inherits from that software.
