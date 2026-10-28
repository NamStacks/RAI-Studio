RAI-Studio
=============================================================================

RAI-Studio is a macOS fork of the RStudio IDE for the
[R programming language](https://www.r-project.org). It keeps the RStudio
workbench (console, source editor, plots, environment, help, and so on) and adds
the RAI Assistant pane. The pane runs a coding assistant command line tool next
to your R session. It supports Claude Code, Codex, OpenCode, and Grok Build.
You install and sign in to those tools yourself. RAI-Studio does not bundle them.
They are third-party products, and RAI-Studio is not affiliated with their vendors.

RAI-Studio is an independent project and is not affiliated with, endorsed by,
or sponsored by Posit Software, PBC. RAI-Studio is based on the RStudio open
source IDE from Posit Software, PBC and its contributors, and this project
would not exist without that work.

Known limits
-----------------------------------------------------------------------------

- macOS only. There are no Windows, Linux, or server builds of RAI-Studio.
- Tested on Apple silicon. The release is a universal build, but the Intel
  slice has not been run on Intel hardware.
- You need R installed on the machine.
- The RAI Assistant needs at least one of the supported command line tools
  installed and signed in.
- The RStudio tools edit open code files and run R without asking you first.
  An edit to a saved file is written to disk at once, a copy from before the
  edit goes to the session scratch folder, and editor Undo alone does not
  restore the saved file.
- The assistant pane talks to a server on 127.0.0.1 that any program or user
  account on the same Mac can reach. Use RAI-Studio on a Mac you do not share.

Getting the Code
-----------------------------------------------------------------------------

RAI-Studio is licensed under the AGPLv3, the terms of which are included in
the file COPYING. The source code for this version is at
[https://github.com/NamStacks/RAI-Studio/tree/v0.1.63-beta/source](https://github.com/NamStacks/RAI-Studio/tree/v0.1.63-beta/source).
The upstream RStudio repository is
[https://github.com/rstudio/rstudio](https://github.com/rstudio/rstudio).

Documentation
-----------------------------------------------------------------------------

See the following files included with the distribution:

- COPYING - RAI-Studio license (AGPLv3)
- NOTICE  - Additional open source software included with RAI-Studio
- SOURCE  - How to obtain the source code for RAI-Studio
- INSTALL - How to build RAI-Studio from source

Open the RAI Assistant pane with Ctrl+Cmd+I.

If you have a problem or want to share feedback, open an issue at
[https://github.com/NamStacks/RAI-Studio/issues](https://github.com/NamStacks/RAI-Studio/issues).
