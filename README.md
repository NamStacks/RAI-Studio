# RAI-Studio

RAI-Studio is RStudio with a built-in terminal for your coding assistant. It is an independent fork of the open-source RStudio IDE. Open an R project, start the RAI Assistant pane, and work with Claude Code, Codex, OpenCode or Grok Build next to your console and editor.

**Beta (version 0.1.62).** Mac only. Expect rough edges, and please report them.

## What you get

- **Four assistants, one pane.** Claude Code, Codex CLI, OpenCode and Grok Build. You install and sign in to the ones you use. RAI-Studio runs them for you. They are third-party products, and RAI-Studio is not affiliated with their vendors.
- **A real terminal.** The pane runs the assistant's own command-line program, not a chat imitation, so you get its own interface and commands.
- **Your project folder.** Assistants start in the folder of the RStudio project you have open (the R working directory when no project is open) and use their own tools to read and change files there. Grok Build reaches your project through a link in its own session folder.
- **Connected to your R session.** The RAI Assistant gives your assistant a set of RStudio tools. It can see your objects and plots, read and edit your open code files, and run a limited set of safety-checked R commands in your console.

## Settings

Open Settings with the gear icon in the RAI Assistant pane toolbar. It has three tabs.

- **General.** Choose the assistant and see whether it is signed in. Pick a Black or White terminal and a text size. Keep your Mac and display awake while an assistant session is open (on by default).
- **Global.** Standing instructions for every project. Write your conventions and preferences once, for example "use the base pipe", "report review findings by severity" or "keep code comments to one sentence". Every new assistant session starts with them. After you save, press Restart Assistant to apply them. They cannot change an assistant's permission settings.
- **Snippets.** Up to five one-line prompts that appear as buttons above the terminal. Clicking one types its text into the assistant's input box. Nothing is sent until you press Enter. The defaults are Explain code, Debug, Review code, Writing review and Analysis review, and you can rename, edit, reorder or replace them.

To switch assistants, pick one in General, press Save changes, then press Restart Assistant.

## Install

1. Install R (tested with R 4.6.0) and the assistants you want to use. RAI-Studio does not include them.
2. Download `RAI-Studio-0.1.62-beta-universal.dmg` from the latest release, open it, and drag RAI-Studio to Applications. The app is signed with a Developer ID and notarized by Apple.
3. Open an R project, click RAI Assistant in the toolbar, open Settings (the gear icon in the pane) and choose your assistant.

Claude Code's voice input (`/voice`) can use your microphone after you allow access when macOS asks.

## Things to know in this beta

- **Mac only.** The app is built for Apple silicon and Intel, with macOS 12 as the build target. It has only been tested on Apple silicon running macOS 27. On Intel Macs older than macOS 15, R Markdown and Quarto rendering may not work.
- **Switching projects.** A running assistant keeps working in the folder of the project it started in. After you open a different project, press Reset Assistant in the pane toolbar to start a fresh assistant in the new project.
- **No sandbox.** Assistants are not confined to your project folder, and their own file tools can read anything you can. The RStudio tools refuse a list of known secret locations (SSH and cloud credentials, shell startup files, `.env` and `.Renviron` files, the assistants' own login files) and R code that reads secret environment variables. The list is a block list, not a guarantee: a path built in code, another program, or an assistant's own tools is not covered. Keep sensitive files out of reach and keep backups of raw data. A project stored inside a folder with a protected name, such as `secrets`, is refused by the RStudio tools until you move it.
- **No approval prompts for the RStudio tools.** When the assistant edits an open code file or runs R through the RStudio tools, it does so without asking you first. An edit to a saved file is written to disk at once, a copy from before the edit goes to the session scratch folder, and editor Undo alone does not restore the saved file. Keep project files under version control or back them up. The tools refuse to edit data files directly.
- **Local server.** The assistant pane talks to a server that listens on 127.0.0.1 only. Any program, and any other user account, on the same Mac can reach it, so use RAI-Studio on a Mac you do not share.
- **Limited R through RStudio.** Many common functions, such as `library()`, `plot()`, `t.test()` and `table()`, are refused when the assistant runs R through the RStudio tools, and so are functions that start programs or load native code. Network calls are not blocked. For everything else the assistant uses its own tools.
- **Models.** You choose the model inside each assistant, not in Settings.
- **Updates.** The app does not check for updates in the background. Help > Check for Updates shows the address of the Releases page of this project.
- **Light testing on some assistants.** Each assistant starts and connects in the pane. Deeper testing used stand-ins for most of them, so expect rough edges.
- **Features that are off or missing.** Posit Assistant is off by default. GitHub Copilot is not included. The interface is in English.
- **RStudio and Posit labels.** Some dialogs, error messages and help links still say RStudio, and the default CRAN mirror is the one RStudio ships with. RAI-Studio is not made, endorsed or supported by Posit. Please do not contact Posit for support.

## Privacy

RAI-Studio has no accounts or servers of its own. We found no code in it, or in the RStudio code it is built on, that sends usage statistics or crash reports. The bundled Quarto can add Google Analytics or Plausible to a website you build, but only when you turn that on in your own project. Your assistant sends what it reads, including files, plots and console output, to its own AI provider. RAI-Studio keeps a local log of the R code the assistant ran and the edits it made to your open documents in `~/.raistudio`, and it never deletes it for you. Features inherited from RStudio contact their own services. Package installs go to your CRAN mirror. If a package source in `options(repos)` is a Package Manager repository (a URL ending in a snapshot date or `latest`), the vulnerability check runs at every session start and after package changes, and sends the names and versions of your installed packages to it; a plain CRAN mirror URL avoids this. Citation lookups in the visual editor go to Crossref, PubMed and similar services, and these requests and R's package downloads identify themselves as RStudio. Formatting with Air downloads that program from GitHub. If you turn on Posit Assistant, it downloads from `cdn.posit.co` and then talks to Posit's AI service. The update check and GitHub Copilot are described above.

## License and source

RAI-Studio is based on RStudio and is licensed under the GNU Affero General Public License version 3 (see `LICENSE`). Third-party components keep their own licenses (see `source/NOTICE`).

The source for this release is in `source/` at tag `v0.1.62-beta` and in `RAI-Studio-0.1.62-beta-source.tar.gz` on the release page. See `SOURCE.md` for what it contains and what was left out.

RStudio is a trademark of Posit Software, PBC. This project uses the name to say which software RAI-Studio is based on and to describe features it inherits from that software.

## Versions

Beta tags are `v<build>-beta`. `<build>` is the RAI-Studio developer build number, which is the version in the app's Info.plist and in Finder. Every beta therefore maps to exactly one developer build. The About box shows the same number and the commit of the source that was built. The checksum of each disk image is in `SHA256SUMS` on its release page.
