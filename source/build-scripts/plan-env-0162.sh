#!/bin/bash
# Build environment for dev build 0.1.62.
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export ELECTRON_CACHE=$STAGE/release-minimal-20261004T033801Z/cache/electron
export GIT_CEILING_DIRECTORIES=$STAGE
export GWT_MAIN_MODULE=RStudioDesktop
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export LANG=C.UTF-8
export LOGNAME=$USER
export MACOSX_DEPLOYMENT_TARGET=12.0
export RSTUDIO_TOOLS_ROOT=$STAGE/deps/arm64
export RSTUDIO_VERSION_MAJOR=0
export RSTUDIO_VERSION_MINOR=1
export RSTUDIO_VERSION_PATCH=62
export RSTUDIO_VERSION_SUFFIX=''
export SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk
export SHELL=/bin/zsh
export USER=$USER
export YARN_CACHE_FOLDER=$STAGE/release-minimal-20261004T033801Z/cache/yarn
export npm_config_cache=$STAGE/release-minimal-20261004T033801Z/cache/npm
export npm_config_devdir=$STAGE/release-minimal-20261004T033801Z/cache/node-gyp
export npm_config_globalconfig=$STAGE/build-home/nonexistent-global-npmrc
export npm_config_logs_dir=$STAGE/npm-logs
export npm_config_offline=true
export npm_config_userconfig=$STAGE/build-home/nonexistent-npmrc
export PATH=/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export HOME=$STAGE/build-home
export TMPDIR=$STAGE/build-home/tmp
