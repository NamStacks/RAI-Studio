# Source for RAI-Studio 0.1.62 Beta

RAI-Studio is licensed under the GNU Affero General Public License version 3. This page says where the matching source is.

## Where

- Folder `source/` in this repository, tag `v0.1.62-beta`.
- Archive `RAI-Studio-0.1.62-beta-source.tar.gz`, attached to the same release as the disk image.

Both hold the same files. They contain the application source this beta was built from (RStudio with the RAI Assistant native module), the assistant bridge in `rai-chat-bridge/`, and the scripts that built the disk image in `build-scripts/`. The commit shown in the app's About box is the commit that tag points to.

## What is not here

- Internal planning notes, handoff notes, release scripts for older versions and the `.github` folder (CI files that name the upstream project) were left out. They are not needed to build the app. The omitted paths are listed in `source/OMITTED.txt`.
- Third-party components that are not part of this source tree (for example R, Node, Electron, Quarto and Pandoc, and the Boost and other libraries the build downloads) keep their own licenses and sources. See `source/NOTICE`. The licenses of Electron and Chromium are inside the app in `Contents/Resources`.

## Based on

RStudio 2026.08.0 "Yellow Yarrow", modified as RAI-Studio.

## Parts that are not built from this tree

The disk image was made by patching freshly built programs, the GWT client, the Electron bundles and the assistant bridge into a copy of the previous signed release, 0.1.61. That copy supplies Electron, its native modules, Node, the bridge's node_modules, Quarto and its tools, Pandoc and the shared libraries; the Electron and Chromium license files come from the Electron download. `source/NOTICE` lists the bundled components that it covers with their licenses and source locations, and it is not complete for every third-party file in the app. The Apple silicon Pandoc has one change, shown in `source/third-party-source/pandoc/`. The visual editor bundle is built from the snapshot of quarto-dev/quarto in `source/src/gwt/lib/quarto/`, without node_modules and build output. Build it from that snapshot and skip the clone-and-pull step of `source/dependencies/common/install-panmirror`, which would fetch a newer version.

## Build

The scripts in `source/build-scripts/` made this disk image. They patch the previous signed release with freshly built binaries, the GWT client and the Electron bundles, then sign and notarize it. `source/INSTALL` and `source/package/osx/` describe the stock build from scratch. Set `RAI_BRIDGE_SOURCE_DIR` to `source/rai-chat-bridge`.
