#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ═══════════════════════════════════════════════════════════════════════
# Constellation Engine — One-Click Deploy
# 解压后在新机器上运行此脚本，自动完成所有配置
# 用法: ./deploy.sh [--target /path/to/install]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Where am I? ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR"  # deploy.sh sits in the extracted root
TARGET_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --target) TARGET_DIR="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Default: install to ~/constellation-engine
if [ -z "$TARGET_DIR" ]; then
    TARGET_DIR="$HOME/constellation-engine"
fi

echo "╔══════════════════════════════════════════════════╗"
echo "║   Constellation Engine — Auto Deploy             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  Source:  $SOURCE_DIR"
echo "  Target:  $TARGET_DIR"
echo ""

# ─── 1. Check prerequisites ─────────────────────────────────────────────
echo "🔍 [1/7] Checking prerequisites..."

MISSING=()

if ! command -v node &>/dev/null; then
    MISSING+=("node (>= 22.0)")
elif [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 22 ]]; then
    MISSING+=("node >= 22.0 (found $(node -v))")
fi

if ! command -v npm &>/dev/null; then
    MISSING+=("npm")
fi

if ! command -v sqlite3 &>/dev/null; then
    echo "  ⚠ sqlite3 not found (recommended but not required)"
fi

if [ ${#MISSING[@]} -gt 0 ]; then
    echo ""
    echo "❌ Missing prerequisites:"
    for M in "${MISSING[@]}"; do
        echo "   - $M"
    done
    echo ""
    echo "Install Node.js 22+: https://nodejs.org/ or 'nvm install 22'"
    exit 1
fi

echo "  ✅ Node.js $(node -v)"
echo "  ✅ npm $(npm -v)"

# ─── 2. Copy files to target ────────────────────────────────────────────
echo "📂 [2/7] Installing to $TARGET_DIR..."

if [ "$SOURCE_DIR" != "$TARGET_DIR" ]; then
    mkdir -p "$TARGET_DIR"
    # rsync everything from extracted dir to target
    rsync -a --info=stats0 "$SOURCE_DIR/" "$TARGET_DIR/"
    echo "  ✅ Files copied"
else
    echo "  ✅ Already in place (source = target)"
fi

cd "$TARGET_DIR"

# ─── 3. npm install ─────────────────────────────────────────────────────
echo "📦 [3/7] Installing dependencies (npm install)..."
npm install --production 2>&1 | tail -3
echo "  ✅ Dependencies installed"

# ─── 4. Create necessary directories ────────────────────────────────────
echo "📁 [4/7] Creating directories..."

DIRS=(
    logs
    data/diary
    data/logs
    data/scribe
    data/memory
    data/omega
    data/sessions
    engine-output/diary
    engine-output/essays
    engine-output/tech-log
    engine-output/milestones
    engine-output/origin-logs/sessions
    engine-output/origin-logs/gems
    engine-output/exploration/human-observation
    engine-output/exploration/constellation-research
    engine-output/exploration/news
    engine-output/exploration/dreams
    engine-output/exploration/reading
    engine-output/exploration/curiosity
    engine-output/exploration/introspection
    engine-output/exploration/dream-collide
    engine-output/book
    engine-output/architecture-research
    engine-output/optimization-log
    engine-output/knowledge
    engine-output/reflections
    engine-output/cognitive-states
    engine-inbox
    engine-inbox/external-analysis
    workspace
)

for D in "${DIRS[@]}"; do
    mkdir -p "$TARGET_DIR/$D"
done
echo "  ✅ Directories ready"

# ─── 5. Set permissions ─────────────────────────────────────────────────
echo "🔑 [5/7] Setting permissions..."

chmod +x "$TARGET_DIR/start.sh" 2>/dev/null || true
chmod +x "$TARGET_DIR/scripts/"*.sh 2>/dev/null || true
echo "  ✅ Permissions set"

# ─── 6. Update paths in start.sh ────────────────────────────────────────
echo "🔧 [6/7] Updating paths..."

# Replace hardcoded engine path in start.sh if different from original
if [ "$TARGET_DIR" != "$HOME/constellation-engine" ]; then
    sed -i "s|cd $HOME/constellation-engine|cd ${TARGET_DIR}|g" "$TARGET_DIR/start.sh" 2>/dev/null || true
    echo "  ✅ Paths updated to $TARGET_DIR"
else
    echo "  ✅ Paths already correct"
fi

# ─── 7. Verify database ─────────────────────────────────────────────────
echo "🗃️  [7/7] Verifying database..."

if [ -f "$TARGET_DIR/constellation.db" ]; then
    if command -v sqlite3 &>/dev/null; then
        NODE_COUNT=$(sqlite3 "$TARGET_DIR/constellation.db" "SELECT COUNT(*) FROM nodes WHERE state='active';" 2>/dev/null || echo "?")
        EDGE_COUNT=$(sqlite3 "$TARGET_DIR/constellation.db" "SELECT COUNT(*) FROM edges WHERE state='active';" 2>/dev/null || echo "?")
        echo "  ✅ constellation.db: ${NODE_COUNT} active nodes, ${EDGE_COUNT} active edges"
    else
        DB_SIZE=$(du -sh "$TARGET_DIR/constellation.db" | cut -f1)
        echo "  ✅ constellation.db exists (${DB_SIZE})"
    fi
else
    echo "  ⚠ constellation.db not found — will be created on first run"
fi

# ─── 8. Deploy Desktop Relay to Windows side ──────────────────────────────
RELAY_SOURCE="${TARGET_DIR}/desktop-relay"
RELAY_TARGET="/mnt/c/constellation-relay"

if [ -d "$RELAY_SOURCE/src" ]; then
    echo "🖥️  [8/8] Deploying Desktop Relay to Windows..."
    mkdir -p "$RELAY_TARGET"
    rsync -a --info=stats0 "$RELAY_SOURCE/" "$RELAY_TARGET/"

    # Check if Windows Node.js exists
    WIN_NODE="/mnt/c/Program Files/nodejs/node.exe"
    if [ -f "$WIN_NODE" ]; then
        echo "  ✅ Windows Node.js found: $("$WIN_NODE" -v 2>/dev/null || echo 'unknown')"
        echo "  📦 Installing relay dependencies..."
        cd "$RELAY_TARGET"
        "$WIN_NODE" "/mnt/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" install --production 2>&1 | tail -3
        cd "$TARGET_DIR"
        echo "  ✅ Desktop Relay deployed to C:\\constellation-relay\\"
    else
        echo "  ⚠ Windows Node.js not found. Install it, then run:"
        echo "    cd C:\\constellation-relay && npm install"
    fi
else
    echo "  ℹ Desktop Relay not included in this pack (skipping)"
fi

# ─── Done ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "✅ Deployment complete!"
echo ""
echo "  To start the engine:"
echo "    cd $TARGET_DIR && ./start.sh"
echo ""
echo "  To start Desktop Relay (Windows PowerShell):"
echo "    cd C:\\constellation-relay && node src\\index.js"
echo "    Or double-click: C:\\constellation-relay\\start-relay.bat"
echo ""
echo "  Optional: Setup system crontab for maintenance tasks:"
echo "    crontab -e"
echo "    # Add these lines (LLM tasks are handled by Croner in-process):"
echo "    0  5 * * * ${TARGET_DIR}/scripts/backup.sh"
echo "    0  * * * * ${TARGET_DIR}/scripts/auto-snapshot.sh"
echo "    0  4 * * * ${TARGET_DIR}/scripts/rotate-logs.sh"
echo ""
echo "  Config: $TARGET_DIR/config.json"
echo "  Star map: $TARGET_DIR/constellation.db"
echo "  Desktop Relay: C:\\constellation-relay\\"
echo "═══════════════════════════════════════════════════"
