// SPDX-License-Identifier: AGPL-3.0-or-later
// Stage 0 — environment probe.
//
// Runs before engine spawn. Validates:
//   - Node.js version (engines.node from root package.json, currently >=22)
//   - Default port 18800 is free (per existing main.js DEFAULT_PORT)
//   - Disk space ≥ 4 GB free in repo root
//   - RAM ≥ 4 GB total
//
// Returns { ok: bool, checks: [{name, ok, detail}], blockers: [string] }.
// UI surfaces each check + per-blocker remediation.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PORT = parseInt(process.env.CONSTELLATION_PORT || '18800', 10);
const REQUIRED_DISK_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const REQUIRED_RAM_BYTES = 4 * 1024 * 1024 * 1024;  // 4 GB

function readEnginesNode() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    return pkg.engines && pkg.engines.node ? pkg.engines.node : '>=20.0.0';
  } catch {
    return '>=20.0.0';
  }
}

function parseRequiredMajor(spec) {
  const m = String(spec).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 20;
}

function checkNodeVersion() {
  const requiredSpec = readEnginesNode();
  const requiredMajor = parseRequiredMajor(requiredSpec);
  const actual = process.versions.node;
  const actualMajor = parseInt(actual.split('.')[0], 10);
  const ok = actualMajor >= requiredMajor;
  return {
    name: 'node_version',
    ok,
    detail: { required: requiredSpec, actual, actualMajor, requiredMajor },
    remediation: ok ? null : `Install Node.js ${requiredSpec}. You have v${actual}. Visit https://nodejs.org/ to download.`,
  };
}

function probePort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', (err) => resolve({ ok: false, code: err.code }))
      .once('listening', () => tester.close(() => resolve({ ok: true })))
      .listen(port, '127.0.0.1');
  });
}

// Probe DEFAULT_PORT first; if busy, walk forward up to PORT_PROBE_RANGE ports
// and return the first free one. The launcher then boots the engine on that
// chosen port. Only a hard blocker if the entire range is occupied.
const PORT_PROBE_RANGE = 10;

async function checkPort() {
  const tried = [];
  for (let i = 0; i < PORT_PROBE_RANGE; i++) {
    const port = DEFAULT_PORT + i;
    const result = await probePort(port);
    tried.push({ port, ok: result.ok, code: result.code });
    if (result.ok) {
      return {
        name: 'port_available',
        ok: true,
        detail: {
          port,
          requested: DEFAULT_PORT,
          shifted: port !== DEFAULT_PORT,
          tried,
        },
        remediation: null,
      };
    }
  }
  return {
    name: 'port_available',
    ok: false,
    detail: { port: DEFAULT_PORT, range: PORT_PROBE_RANGE, tried },
    remediation:
      `Ports ${DEFAULT_PORT}–${DEFAULT_PORT + PORT_PROBE_RANGE - 1} are all in use. ` +
      `Close one of the processes using them, or set CONSTELLATION_PORT to another value before launching.`,
  };
}

// Cross-platform disk-free-bytes. Uses `fs.statfs` (Node 18.15+) when available;
// falls back to `df -k` on POSIX, `wmic` on Windows.
function getDiskFreeBytes(dirPath) {
  return new Promise((resolve) => {
    if (typeof fs.statfs === 'function') {
      fs.statfs(dirPath, (err, stats) => {
        if (err) return resolve(null);
        resolve(stats.bavail * stats.bsize);
      });
      return;
    }
    if (process.platform === 'win32') {
      const drive = path.parse(dirPath).root.replace(/\\$/, '');
      execFile('wmic', ['logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'FreeSpace'], { timeout: 5_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = stdout.match(/(\d+)/);
        resolve(m ? parseInt(m[1], 10) : null);
      });
    } else {
      execFile('df', ['-Pk', dirPath], { timeout: 5_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const lines = stdout.trim().split('\n');
        if (lines.length < 2) return resolve(null);
        const cols = lines[lines.length - 1].split(/\s+/);
        const availKB = parseInt(cols[3], 10);
        resolve(Number.isFinite(availKB) ? availKB * 1024 : null);
      });
    }
  });
}

async function checkDiskSpace() {
  const free = await getDiskFreeBytes(REPO_ROOT);
  if (free === null) {
    return {
      name: 'disk_space',
      ok: true,
      detail: { warning: 'could not determine free disk space' },
      remediation: null,
    };
  }
  const ok = free >= REQUIRED_DISK_BYTES;
  return {
    name: 'disk_space',
    ok,
    detail: { freeBytes: free, freeGB: +(free / 1e9).toFixed(2), requiredGB: 4 },
    remediation: ok ? null :
      `Need at least 4 GB free at ${REPO_ROOT}. You have ${(free / 1e9).toFixed(2)} GB. ` +
      `Free up space, then relaunch.`,
  };
}

function checkRam() {
  const total = os.totalmem();
  const ok = total >= REQUIRED_RAM_BYTES;
  return {
    name: 'ram',
    ok,
    detail: { totalBytes: total, totalGB: +(total / 1e9).toFixed(2), requiredGB: 4 },
    remediation: ok ? null :
      `Need at least 4 GB total RAM. You have ${(total / 1e9).toFixed(2)} GB. ` +
      `The engine may run but with degraded performance.`,
  };
}

async function runAllChecks() {
  const checks = await Promise.all([
    Promise.resolve(checkNodeVersion()),
    checkPort(),
    checkDiskSpace(),
    Promise.resolve(checkRam()),
  ]);
  const blockers = checks.filter(c => !c.ok && c.name !== 'ram').map(c => c.remediation);
  // RAM is a warning, not a blocker — engine will still try to start.
  const warnings = checks.filter(c => !c.ok && c.name === 'ram').map(c => c.remediation);
  return {
    ok: blockers.length === 0,
    checks,
    blockers,
    warnings,
  };
}

module.exports = {
  runAllChecks,
  checkNodeVersion,
  checkPort,
  checkDiskSpace,
  checkRam,
  getDiskFreeBytes,
  REQUIRED_DISK_BYTES,
  REQUIRED_RAM_BYTES,
  DEFAULT_PORT,
};
