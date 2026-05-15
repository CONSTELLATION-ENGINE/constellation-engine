#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Constellation Engine Full Architecture Backup
# 全架构备份到 F: 盘（USB）— 完整镜像，不漏任何文件
# 系统级运行，不消耗 LLM tokens
# 每天 05:00 自动执行（via system crontab）
# 备份上限 30 份，超过自动删除最旧的

# Only check undefined variables, NOT set -e (which aborts on any error)
set -u

ENGINE_ROOT="$HOME/constellation-engine"
BACKUP_ROOT="/mnt/f/Constellation engine"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M")
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
LOG_FILE="${BACKUP_ROOT}/backup.log"
LOCAL_LOG="${ENGINE_ROOT}/logs/backup.log"
MAX_BACKUPS=30
ERRORS=0

# Helper: log to both local and F drive (tolerant of F drive I/O issues)
log() {
    echo "$1" >> "$LOCAL_LOG" 2>/dev/null
    echo "$1" >> "$LOG_FILE" 2>/dev/null
}

# ─── Pre-flight ──────────────────────────────────────────────────────────

# Check if F: is mounted
if ! mountpoint -q /mnt/f 2>/dev/null; then
    log "[$(date)] F: drive not mounted. Attempting mount..."
    if ! sudo mount -t drvfs F: /mnt/f 2>/dev/null; then
        log "[$(date)] FATAL: Cannot mount F: drive. Backup aborted."
        exit 1
    fi
fi

log "[$(date)] Starting full architecture backup to ${BACKUP_DIR}..."
mkdir -p "$BACKUP_DIR" || { log "[$(date)] FATAL: Cannot create backup dir. Aborting."; exit 1; }

# ─── 1. 星图数据库（最重要，用 sqlite3 .backup 保证一致性） ──────────────

log "  [1] Backing up constellation DB (sqlite3 .backup)..."
if ! sqlite3 "${ENGINE_ROOT}/constellation.db" ".backup '${BACKUP_DIR}/constellation.db'" 2>> "$LOCAL_LOG"; then
    log "  sqlite3 .backup failed, falling back to raw copy..."
    cp "${ENGINE_ROOT}/constellation.db" "${BACKUP_DIR}/" 2>> "$LOCAL_LOG" || true
    cp "${ENGINE_ROOT}/constellation.db-wal" "${BACKUP_DIR}/" 2>/dev/null || true
    cp "${ENGINE_ROOT}/constellation.db-shm" "${BACKUP_DIR}/" 2>/dev/null || true
    ERRORS=$((ERRORS + 1))
fi

# ─── 1b. conversations.db, cron.db, sessions.db ────────────────────────

for DB_NAME in conversations.db cron.db sessions.db mimir_diary.db; do
    if [ -f "${ENGINE_ROOT}/${DB_NAME}" ]; then
        log "  [1b] Backing up ${DB_NAME} (sqlite3 .backup)..."
        if ! sqlite3 "${ENGINE_ROOT}/${DB_NAME}" ".backup '${BACKUP_DIR}/${DB_NAME}'" 2>> "$LOCAL_LOG"; then
            log "  sqlite3 .backup failed for ${DB_NAME}, falling back to raw copy..."
            cp "${ENGINE_ROOT}/${DB_NAME}" "${BACKUP_DIR}/" 2>> "$LOCAL_LOG" || true
            ERRORS=$((ERRORS + 1))
        fi
    fi
done

# ─── 2. rsync 完整镜像（排除不需要的目录和数据库文件） ─────────────────

log "  [2] Syncing full architecture (rsync)..."
rsync -a --info=stats0 --no-links \
    --exclude='node_modules' \
    --exclude='venv' \
    --exclude='snapshots' \
    --exclude='.git' \
    --exclude='constellation.db' \
    --exclude='constellation.db-wal' \
    --exclude='constellation.db-shm' \
    --exclude='constellation.db-journal' \
    --exclude='constellation.db.bak' \
    --exclude='constellation.db.bak-wal' \
    --exclude='constellation.db.bak-shm' \
    --exclude='cron.db' \
    --exclude='cron.db-wal' \
    --exclude='cron.db-shm' \
    --exclude='sessions.db' \
    --exclude='sessions.db-wal' \
    --exclude='sessions.db-shm' \
    --exclude='conversations.db' \
    --exclude='conversations.db-wal' \
    --exclude='conversations.db-shm' \
    --exclude='mimir_diary.db' \
    --exclude='mimir_diary.db-wal' \
    --exclude='mimir_diary.db-shm' \
    "${ENGINE_ROOT}/" "${BACKUP_DIR}/" 2>> "$LOCAL_LOG" || {
    log "  rsync had errors (likely non-critical symlink/permission issues)"
    ERRORS=$((ERRORS + 1))
}

# ─── Update latest pointer ──────────────────────────────────────────────

echo "$BACKUP_DIR" > "${BACKUP_ROOT}/LATEST.txt" 2>/dev/null || true

# ─── Calculate backup size ──────────────────────────────────────────────

BACKUP_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo "unknown")

# ─── Cleanup: keep only last MAX_BACKUPS ────────────────────────────────

BACKUP_COUNT=$(ls -d "${BACKUP_ROOT}"/20* 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
    EXCESS=$((BACKUP_COUNT - MAX_BACKUPS))
    log "  Cleaning old backups (keeping last ${MAX_BACKUPS}, removing ${EXCESS})..."
    ls -d "${BACKUP_ROOT}"/20* | head -n "$EXCESS" | xargs rm -rf 2>/dev/null || true
fi

FINAL_COUNT=$(ls -d "${BACKUP_ROOT}"/20* 2>/dev/null | wc -l)

# ─── Final status ───────────────────────────────────────────────────────

if [ "$ERRORS" -eq 0 ]; then
    log "[$(date)] ✅ Backup complete. Size: ${BACKUP_SIZE}, Backups: ${FINAL_COUNT}/${MAX_BACKUPS}"
else
    log "[$(date)] ⚠️ Backup complete with ${ERRORS} error(s). Size: ${BACKUP_SIZE}, Backups: ${FINAL_COUNT}/${MAX_BACKUPS}"
fi
