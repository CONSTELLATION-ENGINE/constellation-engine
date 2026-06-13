#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# oss-sync.sh — three-phase sync: rsync → scrub → atomic move

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OSS_DIR="$REPO_ROOT/constellation-engine-oss"
# Stage on the same filesystem as OSS_DIR so the final mv is a true atomic rename.
# (Cross-fs rename falls back to copy+unlink, which can leave a half-moved tree if interrupted.)
STAGING_DIR="$REPO_ROOT/.oss-staging-$$-$RANDOM"
SCRUB_SCRIPT="$OSS_DIR/scripts/oss-scrub.cjs"
SCRUB_RULES="$OSS_DIR/scripts/oss-scrub-rules.json"

MODE="${1:---dry-run}"
CHECK_ONLY=0
DRY_RUN=0
FORCE=0

case "$MODE" in
  --check)
    CHECK_ONLY=1
    ;;
  --dry-run)
    DRY_RUN=1
    ;;
  --force)
    FORCE=1
    ;;
  *)
    echo "Usage: $0 [--dry-run|--check|--force]"
    exit 1
    ;;
esac

echo "Phase 1: rsync curated paths to staging..."

mkdir -p "$STAGING_DIR"

# Curated allowlist — sync only these paths.
# NOTE: rsync's --include does NOT expand brace lists ({js,cjs,...}),
# so each file extension needs its own --include line.
#
# Pre-include excludes block backup/runtime junk that lives next to source:
# *.bak, *.backup, *.pre-*, *:Zone.Identifier (Windows ADS), *.db / *.db-*,
# *.test.js (tests not shipped to OSS users by default), *.test.cjs.
rsync -a \
  --exclude='*.bak' \
  --exclude='*.backup' \
  --exclude='*.pre-*' \
  --exclude='*:Zone.Identifier' \
  --exclude='*.db' \
  --exclude='*.db-*' \
  --exclude='*.log' \
  --include='src/' --include='src/***' \
  --include='engine.cjs' \
  --include='scripts/' \
  --include='scripts/migrations/' --include='scripts/migrations/***' \
  --include='scripts/mimir-js/' --include='scripts/mimir-js/***' \
  --include='scripts/tools/' \
  --include='scripts/tools/migrate_memory.py' \
  --include='scripts/tools/measure_import_pollution.py' \
  --include='scripts/tools/README-migrate-memory.md' \
  --include='scripts/*.cjs' \
  --include='scripts/*.js' \
  --include='scripts/*.py' \
  --include='scripts/*.sh' \
  --include='scripts/*.sql' \
  --include='schema.sql' \
  --include='config.example.json' \
  --exclude='package.json' \
  --include='package-lock.json' \
  --include='identity/' \
  --include='identity/WORKFLOW-CONTEXT-GATES.example.json' \
  --include='identity/*.template.md' \
  --include='identity/ENGINE-GUIDE.md' \
  --include='identity/SETUP.md' \
  --include='skills/' --include='skills/***' \
  --include='config/' --include='config/node_taxonomy.json' \
  --exclude='*' \
  "$REPO_ROOT/" "$STAGING_DIR/" 2>/dev/null || true

echo "Phase 2: apply oss-scrub.cjs transformations..."

if [ -f "$SCRUB_SCRIPT" ]; then
  node "$SCRUB_SCRIPT" "$STAGING_DIR" || {
    echo "Scrub failed. Check $SCRUB_RULES for violations."
    rm -rf "$STAGING_DIR"
    exit 1
  }
fi

echo "Phase 2.5: render identity/*.md from identity/*.template.md..."

# Hand-managed transforms (plan §4.3): copy templates to their rendered names.
# Placeholders ({{AGENT_NAME}}, {{USER_NAME}}, etc.) are LEFT INTACT — the
# first-run wizard fills them at install time.
# Templates live at identity/ root (no oss-template/ subdir) — the rendered
# *.md siblings are what gets bundled into the electron build.
for tpl in "$STAGING_DIR/identity"/*.template.md; do
  [ -f "$tpl" ] || continue
  base="$(basename "$tpl" .template.md)"
  cp "$tpl" "$STAGING_DIR/identity/$base.md"
done

echo "Phase 2.6: post-render assertions (identity render + denylist residue)..."

# Phase 2.6a: identity render assertion.
# Phase 2.5 must have rendered identity/SYSTEM_PREAMBLE.md from the root template, and
# the {{AGENT_NAME}} placeholder must survive (first-run wizard fills it).
ASSERTION_FAILURES=()
if [ ! -f "$STAGING_DIR/identity/SYSTEM_PREAMBLE.md" ]; then
  ASSERTION_FAILURES+=("identity/SYSTEM_PREAMBLE.md missing — Phase 2.5 render did not run or template absent")
elif ! grep -q '{{AGENT_NAME}}' "$STAGING_DIR/identity/SYSTEM_PREAMBLE.md"; then
  ASSERTION_FAILURES+=("identity/SYSTEM_PREAMBLE.md missing {{AGENT_NAME}} placeholder — template was pre-filled or scrubbed")
fi

# Phase 2.6b: denylist residue scan (defense-in-depth — rsync excludes already block these).
# These paths/patterns must NEVER reach a publish-ready staging tree.
DENYLIST_RESIDUE=$(
  find "$STAGING_DIR" \
    \( \
      \( -name '.env' -o -name '.env.local' -o -name '.env.production' \) \
      -o -name '*.db' -o -name '*.db-shm' -o -name '*.db-wal' \
      -o -name '*.bak' -o -name '*.backup' -o -name '*.pre-*' \
      -o -name '*:Zone.Identifier' \
      -o -path '*/secrets/*' \
      -o -path '*/engine-output/*' \
      -o -path '*/library/*' \
      -o -path '*/snapshots/*' \
      -o -path '*/data/*' \
      -o -path '*/logs/*' \
      -o -path '*/engine-inbox/*' \
      -o -path '*/identity/COGNITIVE_STATE.md' \
      -o -path '*/identity/tasks.json' \
    \) \
    -type f 2>/dev/null
)
if [ -n "$DENYLIST_RESIDUE" ]; then
  while IFS= read -r residue; do
    rel="${residue#$STAGING_DIR/}"
    ASSERTION_FAILURES+=("denylist residue: $rel — should be blocked by rsync allowlist/exclude")
  done <<< "$DENYLIST_RESIDUE"
fi

# Phase 2.6c: AGPL header presence sweep (defense-in-depth — oss-scrub.cjs already
# stamps each headerable file and asserts via positive_assertion `agpl_header_present`).
# This is a final check that no headerable source slipped through unstamped.
HEADERABLE_MISSING=$(
  find "$STAGING_DIR" \
    \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' \
       -o -name '*.py' -o -name '*.sh' -o -name '*.sql' \) \
    -type f \
    ! -path '*/node_modules/*' \
    ! -path '*/.git/*' \
    -exec grep -L 'SPDX-License-Identifier:[[:space:]]*AGPL-3.0-or-later' {} + 2>/dev/null
)
if [ -n "$HEADERABLE_MISSING" ]; then
  while IFS= read -r unstamped; do
    rel="${unstamped#$STAGING_DIR/}"
    ASSERTION_FAILURES+=("missing AGPL header: $rel — oss-scrub.cjs applyHeader() should have stamped it")
  done <<< "$HEADERABLE_MISSING"
fi

if [ ${#ASSERTION_FAILURES[@]} -gt 0 ]; then
  echo "❌ Phase 2.6 assertion failures:"
  for f in "${ASSERTION_FAILURES[@]}"; do
    echo "  $f"
  done
  rm -rf "$STAGING_DIR"
  exit 1
fi

if [ $CHECK_ONLY -eq 1 ]; then
  echo "✓ Check passed (--check mode). Staging cleaned up."
  rm -rf "$STAGING_DIR"
  exit 0
fi

if [ $DRY_RUN -eq 1 ]; then
  echo "Dry-run summary:"
  diff -r "$STAGING_DIR" "$OSS_DIR" --brief 2>/dev/null | head -20 || true
  rm -rf "$STAGING_DIR"
  exit 0
fi

# Phase 3: atomic move (only if not dry-run and not check-only)
echo "Phase 3: atomic move to constellation-engine-oss/..."

# Preserve oss-only paths (electron/, src/oss/, LICENSE, README, etc.)
# These exist only in OSS folder and must survive the atomic move.
if [ -f "$OSS_DIR/oss-only.txt" ]; then
  while IFS= read -r oss_path; do
    [ -z "$oss_path" ] && continue
    src_path="$STAGING_DIR/$oss_path"
    dst_path="$OSS_DIR/$oss_path"
    if [ -e "$dst_path" ]; then
      mkdir -p "$(dirname "$src_path")"
      # Clear any pre-existing staging copy so cp -r doesn't nest dir-into-dir.
      rm -rf "$src_path"
      cp -r "$dst_path" "$src_path" 2>/dev/null || true
    fi
  done < "$OSS_DIR/oss-only.txt"
fi

# Two-phase swap: rename old → backup, rename new → final, drop backup.
# This way an interrupted mv leaves either the old tree intact OR backup recoverable.
BACKUP_DIR="$OSS_DIR.bak-$$"
if [ -d "$OSS_DIR" ]; then
  mv "$OSS_DIR" "$BACKUP_DIR"
fi
if mv "$STAGING_DIR" "$OSS_DIR"; then
  rm -rf "$BACKUP_DIR" 2>/dev/null || true
else
  echo "❌ Final mv failed — rolling back from $BACKUP_DIR"
  [ -d "$BACKUP_DIR" ] && mv "$BACKUP_DIR" "$OSS_DIR"
  rm -rf "$STAGING_DIR" 2>/dev/null || true
  exit 1
fi

echo "✓ Sync complete. OSS folder updated."
