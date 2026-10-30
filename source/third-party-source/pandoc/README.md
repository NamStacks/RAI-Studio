# Pandoc 3.8.3 in RAI-Studio

Pandoc is copyright John MacFarlane and contributors and is licensed under the GNU General Public License version 2 or later. RAI-Studio ships it inside Quarto, under `Contents/Resources/app/quarto/bin/tools`.

The Intel build in `x86_64/pandoc` is the unmodified Pandoc 3.8.3 release.

The Apple silicon build in `aarch64/pandoc` was built from the Pandoc 3.8.3 source and has one change: when the environment variable `PANDOC_SERVER_HOST` is set, the Pandoc server binds only to `127.0.0.1` or `::1` and refuses any other value. Unset, it behaves as upstream. The change is the file `pandoc-server-loopback.patch` in this folder, which applies to `server/PandocCLI/Server.hs`.

The unmodified upstream source is at https://github.com/jgm/pandoc/tree/3.8.3 and https://hackage.haskell.org/package/pandoc-3.8.3.

For three years from the release date of RAI-Studio 0.1.63 Beta, anyone who asks in an issue at https://github.com/NamStacks/RAI-Studio/issues can get the complete corresponding source of the Apple silicon build, including the build inputs, on a medium customarily used for software interchange.
