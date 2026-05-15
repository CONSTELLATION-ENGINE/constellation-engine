// SPDX-License-Identifier: AGPL-3.0-or-later
// Sentinel detection per Planning §22.1 + §23.3.
//
// Two-tier persistence:
//   - `.onboarding-complete` file = boot-time fast-path cache (this module's job)
//   - `onboarding_progress` SQLite table = single source of truth (engine-side)
//
// On each boot:
//   1. If sentinel file exists → trust it; skip onboarding (fast path).
//   2. If sentinel file missing → load onboarding wizard.
//   3. Engine boot will reconcile sentinel ↔ SQL on its own (future work in Day 4).
//
// Sentinel write happens at Stage 10 completion (or skip).
//
// Path resolution: the launcher (main.js) calls setRoot() with the writable
// engine directory after app.whenReady(). Before setRoot() is called, paths
// fall back to the dev-mode repo layout so unit tests / scripts still work.

const fs = require('node:fs');
const path = require('node:path');

let rootDir = path.resolve(__dirname, '..', '..');
let sentinelPath = path.join(rootDir, 'data', '.onboarding-complete');
let inconsistentPath = path.join(rootDir, 'data', '.config-inconsistent');

function setRoot(dir) {
  rootDir = dir;
  sentinelPath = path.join(rootDir, 'data', '.onboarding-complete');
  inconsistentPath = path.join(rootDir, 'data', '.config-inconsistent');
}

function isOnboardingComplete() {
  try {
    return fs.existsSync(sentinelPath);
  } catch {
    return false;
  }
}

// Read the app_version field written into the sentinel at completion. Used by
// the launcher to detect install/upgrade transitions: if the recorded version
// differs from the currently-running app.getVersion(), force the wizard back
// open (with a Skip button for users whose data is already populated).
// Returns the version string, or null if missing/unparsable.
function getCompletedVersion() {
  try {
    const raw = fs.readFileSync(sentinelPath, 'utf-8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj.app_version === 'string') ? obj.app_version : null;
  } catch {
    return null;
  }
}

function isConfigInconsistent() {
  try {
    return fs.existsSync(inconsistentPath);
  } catch {
    return false;
  }
}

function readInconsistencyReason() {
  try {
    return fs.readFileSync(inconsistentPath, 'utf-8');
  } catch {
    return null;
  }
}

// Stage 10 (or skip) writes the sentinel atomically.
function writeOnboardingComplete(payload = {}) {
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  const tmp = sentinelPath + '.tmp';
  const body = JSON.stringify({
    completed_at: new Date().toISOString(),
    ...payload,
  }, null, 2);
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, sentinelPath);
}

// Splash "Reset Setup" path — drop the launcher sentinel so the next boot
// re-opens the wizard. ENOENT is fine (idempotent).
function clearOnboardingComplete() {
  try { fs.unlinkSync(sentinelPath); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  setRoot,
  isOnboardingComplete,
  isConfigInconsistent,
  readInconsistencyReason,
  writeOnboardingComplete,
  clearOnboardingComplete,
  getCompletedVersion,
  get SENTINEL_PATH() { return sentinelPath; },
  get INCONSISTENT_PATH() { return inconsistentPath; },
};
