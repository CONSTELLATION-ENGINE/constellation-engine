#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# build-platform.sh — cross-platform packager for Windows/Linux/Mac installers.
# Creates a staging clone with platform-specific prebuilt native binaries, then
# runs electron-builder against the staging clone so the artifacts ship Win/Mac/
# Linux native modules even when build host is Linux/WSL.
#
# Usage:
#   ./scripts/build-platform.sh win32 x64
#   ./scripts/build-platform.sh linux x64
#   ./scripts/build-platform.sh darwin x64
#   ./scripts/build-platform.sh darwin arm64

set -euo pipefail

PLATFORM="${1:-win32}"
ARCH="${2:-x64}"

OSS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="$HOME/constellation-build-staging/${PLATFORM}-${ARCH}"
OUT_DIR="$OSS_ROOT/dist/electron"

echo "==> OSS root: $OSS_ROOT"
echo "==> Staging:  $STAGING"
echo "==> Target:   $PLATFORM/$ARCH"

# 1. Fresh staging clone — exclude node_modules, dist, runtime data
echo "==> [1/6] Cloning OSS to staging (rsync, exclude heavy)..."
rm -rf "$STAGING"
mkdir -p "$STAGING"
rsync -a \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='electron/node_modules' \
  --exclude='electron/dist' \
  --exclude='models' \
  --exclude='.git' \
  --exclude='engine-output' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  --exclude='conversations.db' \
  --exclude='constellation.db' \
  --exclude='cron.db' \
  --exclude='identity/star-map.db' \
  "$OSS_ROOT/" "$STAGING/"

# [1.5/6] Overlay private dashboard bundle (B + stub plan, rev3).
# The public OSS source tree ships *stubs* for src/dashboard.js + src/dashboard-ui.js
# that keep the engine bootable headless. The official Electron installer needs
# the *full* obfuscated bundle, which lives in the private constellation-dashboard
# repo. Overlay the dist artifacts here, before npm install. Fail-closed:
# accidental releases can't silently ship stubs.
PRIVATE_DASHBOARD_DIR="${PRIVATE_DASHBOARD_DIR:-$HOME/constellation-dashboard/dist}"
if [[ -f "$PRIVATE_DASHBOARD_DIR/dashboard.js" && -f "$PRIVATE_DASHBOARD_DIR/dashboard-ui.js" ]]; then
  echo "==> [1.5/6] Overlaying private dashboard bundle from $PRIVATE_DASHBOARD_DIR"
  cp -f "$PRIVATE_DASHBOARD_DIR/dashboard.js"    "$STAGING/src/dashboard.js"
  cp -f "$PRIVATE_DASHBOARD_DIR/dashboard-ui.js" "$STAGING/src/dashboard-ui.js"
  echo "    overlay sizes: dashboard.js $(wc -c < "$STAGING/src/dashboard.js") bytes, dashboard-ui.js $(wc -c < "$STAGING/src/dashboard-ui.js") bytes"
elif [[ "${STUB_BUILD:-0}" == "1" ]]; then
  echo "==> [1.5/6] STUB_BUILD=1 — shipping public stub (headless build)"
else
  echo "==> [1.5/6] ERROR: no private bundle at $PRIVATE_DASHBOARD_DIR and STUB_BUILD!=1"
  echo "    Build the private bundle first:  cd ~/constellation-dashboard && npm run build"
  echo "    Or set STUB_BUILD=1 to ship a headless installer deliberately."
  exit 1
fi

# 2. Install OSS deps with cross-platform target — picks correct optionalDeps
#    (sqlite-vec-windows-x64, @napi-rs/canvas-win32-x64-msvc, @img/sharp-win32-x64, etc.)
echo "==> [2/6] npm install (production) for $PLATFORM/$ARCH..."
cd "$STAGING"
npm_config_target_platform="$PLATFORM" \
npm_config_target_arch="$ARCH" \
npm install \
  --platform="$PLATFORM" \
  --arch="$ARCH" \
  --no-audit --no-fund \
  --omit=dev \
  --include=optional

# 3. Force prebuild-install for better-sqlite3 — npm's --platform doesn't reach
#    install scripts, so we re-pull the prebuilt binary explicitly.
#    CRITICAL: must use runtime=electron + target=<electron-version> so we get
#    the Electron-ABI prebuild (e.g. 128 for Electron 32), not the stock Node
#    ABI (127 for Node 22). Mismatch crashes engine boot with NODE_MODULE_VERSION.
ELECTRON_VER=$(node -p "require('$OSS_ROOT/electron/package.json').devDependencies.electron.replace(/^[\^~]/,'')" 2>/dev/null || echo "32.3.3")
echo "==> [3/6] Pulling better-sqlite3 prebuilt for Electron $ELECTRON_VER on $PLATFORM/$ARCH..."
cd "$STAGING/node_modules/better-sqlite3"
rm -rf build/Release/better_sqlite3.node
npx -y prebuild-install \
  --platform="$PLATFORM" \
  --arch="$ARCH" \
  --runtime=electron \
  --target="$ELECTRON_VER" \
  --download-progress=false

# Sanity: verify it's the right ABI
BIN="$STAGING/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [[ -f "$BIN" ]]; then
  echo "    binary: $(file -b "$BIN")"
else
  echo "    !!! better_sqlite3.node missing after prebuild-install"
  exit 1
fi

# 3b. Force-install platform-specific optionalDependencies that npm --platform/--arch
#     fails to select. Map (platform,arch) → exact package names.
echo "==> [3b/6] Force-installing $PLATFORM/$ARCH-specific optional native packages..."
cd "$STAGING"

case "$PLATFORM-$ARCH" in
  win32-x64)
    CANVAS_PKG="@napi-rs/canvas-win32-x64-msvc"
    VEC_PKG="sqlite-vec-windows-x64"
    WRONG_VARIANTS="@napi-rs/canvas-linux-x64-gnu @napi-rs/canvas-darwin-x64 @napi-rs/canvas-darwin-arm64 sqlite-vec-linux-x64 sqlite-vec-darwin-x64 sqlite-vec-darwin-arm64"
    ;;
  linux-x64)
    CANVAS_PKG="@napi-rs/canvas-linux-x64-gnu"
    VEC_PKG="sqlite-vec-linux-x64"
    WRONG_VARIANTS="@napi-rs/canvas-win32-x64-msvc @napi-rs/canvas-darwin-x64 @napi-rs/canvas-darwin-arm64 sqlite-vec-windows-x64 sqlite-vec-darwin-x64 sqlite-vec-darwin-arm64"
    ;;
  darwin-x64)
    CANVAS_PKG="@napi-rs/canvas-darwin-x64"
    VEC_PKG="sqlite-vec-darwin-x64"
    WRONG_VARIANTS="@napi-rs/canvas-win32-x64-msvc @napi-rs/canvas-linux-x64-gnu @napi-rs/canvas-darwin-arm64 sqlite-vec-windows-x64 sqlite-vec-linux-x64 sqlite-vec-darwin-arm64"
    ;;
  darwin-arm64)
    CANVAS_PKG="@napi-rs/canvas-darwin-arm64"
    VEC_PKG="sqlite-vec-darwin-arm64"
    WRONG_VARIANTS="@napi-rs/canvas-win32-x64-msvc @napi-rs/canvas-linux-x64-gnu @napi-rs/canvas-darwin-x64 sqlite-vec-windows-x64 sqlite-vec-linux-x64 sqlite-vec-darwin-x64"
    ;;
  *)
    echo "    !!! Unsupported platform/arch combo: $PLATFORM-$ARCH"
    exit 1
    ;;
esac

# Look up the parent package versions so we install the matching variant version
CANVAS_PARENT_VER=$(node -p "require('$STAGING/node_modules/@napi-rs/canvas/package.json').version" 2>/dev/null || echo "")
VEC_PARENT_VER=$(node -p "require('$STAGING/node_modules/sqlite-vec/package.json').version" 2>/dev/null || echo "")

# Remove wrong-platform variants so they don't pollute the bundle
for w in $WRONG_VARIANTS; do
  if [[ -d "$STAGING/node_modules/$w" ]]; then
    echo "    removing wrong-platform variant: $w"
    rm -rf "$STAGING/node_modules/$w"
  fi
done

# Install correct platform variants (no-save so package.json stays clean)
EXTRA_PKGS=""
[[ -n "$CANVAS_PARENT_VER" ]] && EXTRA_PKGS="$EXTRA_PKGS ${CANVAS_PKG}@${CANVAS_PARENT_VER}"
[[ -n "$VEC_PARENT_VER" ]] && EXTRA_PKGS="$EXTRA_PKGS ${VEC_PKG}@${VEC_PARENT_VER}"

if [[ -n "$EXTRA_PKGS" ]]; then
  echo "    installing:$EXTRA_PKGS"
  # --force needed because each variant pkg has os/cpu fields that fail strict
  # platform checks when running on a different host. We're intentionally
  # cross-installing these — the target machine is what matters.
  npm install --no-save --no-audit --no-fund --force \
    --platform="$PLATFORM" --arch="$ARCH" $EXTRA_PKGS
fi

# Verify
for pkg in $CANVAS_PKG $VEC_PKG; do
  if [[ -d "$STAGING/node_modules/$pkg" ]]; then
    echo "    [ok] $pkg installed"
  else
    echo "    !!! $pkg missing after install"
    exit 1
  fi
done

# 4. Install Electron deps (host-side, runs on build machine, no cross-compile needed)
echo "==> [4/6] npm install electron-builder deps..."
cd "$STAGING/electron"
npm install --no-audit --no-fund

# 4b. FINAL cleanup of wrong-platform variants — npm install with --force above
#     re-pulls the host's variant alongside ours, so we delete them again here.
#     This MUST run after all npm installs and before electron-builder packs.
echo "==> [4b/6] Final wrong-platform variant scrub before packaging..."
for w in $WRONG_VARIANTS; do
  if [[ -d "$STAGING/node_modules/$w" ]]; then
    echo "    final remove: $w"
    rm -rf "$STAGING/node_modules/$w"
  fi
done

# 5. Run electron-builder
echo "==> [5/6] Running electron-builder for $PLATFORM..."
case "$PLATFORM" in
  win32)  npm run dist:win ;;
  linux)  npm run dist:linux ;;
  darwin) npm run dist:mac ;;
  *)      echo "Unknown platform: $PLATFORM"; exit 1 ;;
esac

# 6. Copy artifacts back to OSS dist/
APP_VERSION=$(node -p "require('$OSS_ROOT/electron/package.json').version" 2>/dev/null || echo "")
echo "==> [6/6] Cleaning prior-version artifacts (keeping $APP_VERSION) and copying to $OUT_DIR ..."
mkdir -p "$OUT_DIR"

# Purge any artifact whose filename doesn't contain the current version. Keeps
# sibling-platform artifacts of the SAME version intact during sequential 3-platform
# builds (Win → Mac → Linux), but wipes leftovers from older versions.
# Strip dashes from both sides before comparing — package.json has "0.3.0r7"
# but electron-builder emits "Constellation-0.3.0-r7.AppImage" (semver-normalized
# with a dash before the prerelease tag). Without normalization, sibling-platform
# artifacts get incorrectly purged across serial builds.
if [[ -n "$APP_VERSION" ]]; then
  APP_VERSION_NORM="${APP_VERSION//-/}"
  shopt -s nullglob
  for f in "$OUT_DIR"/Constellation*; do
    base="$(basename "$f")"
    base_norm="${base//-/}"
    if [[ "$base_norm" != *"$APP_VERSION_NORM"* ]]; then
      echo "    purge prior-version: $base"
      rm -f "$f"
    fi
  done
  shopt -u nullglob
fi

shopt -s nullglob
for f in "$STAGING/dist/electron"/*.{exe,AppImage,zip,dmg,deb,rpm,blockmap,yml,yaml}; do
  cp -v "$f" "$OUT_DIR/"
done
shopt -u nullglob

echo ""
echo "==> Build complete. Artifacts:"
ls -lh "$OUT_DIR" | grep -Ei '\.(exe|appimage|zip|dmg)$' || true
