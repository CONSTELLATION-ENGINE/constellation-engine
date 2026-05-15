// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module time
 * @description Shared time helpers for storage (UTC) and display/prompting.
 * OSS-friendly: timezone is configurable; falls back to system tz, then UTC.
 */

export const NZ_TZ = 'UTC';

/**
 * Resolve the effective timezone.
 * Priority: explicit param → system tz (Intl) → 'UTC'.
 * Validates via Intl; if the requested tz is invalid, falls back.
 * @param {string} [tz]
 * @returns {string} IANA timezone name
 */
export function resolveTimezone(tz) {
  const candidates = [];
  if (tz && typeof tz === 'string') candidates.push(tz.trim());
  try {
    const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (sys) candidates.push(sys);
  } catch { /* ignore */ }
  candidates.push('UTC');
  for (const c of candidates) {
    if (!c) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: c });
      return c;
    } catch { /* invalid tz, try next */ }
  }
  return 'UTC';
}

export function nowUtcIso() {
  return new Date().toISOString();
}

export function parseDbDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) s = s + 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatNzDate(value, options = {}) {
  const d = parseDbDate(value);
  if (!d) return '';
  return d.toLocaleString('en-NZ', {
    timeZone: NZ_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...options,
  });
}

/**
 * Format a Date for LLM prompt injection in the given timezone.
 * Uses Intl with 'en-GB' for stable YYYY-style output and short tz name.
 * @param {Date} [date]
 * @param {string} [timezone]
 * @returns {string}
 */
export function formatPromptNow(date = new Date(), timezone) {
  const tz = resolveTimezone(timezone);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return fmt.format(date);
}

/**
 * Backward-compatible NZ formatter — delegates to formatPromptNow.
 * @param {Date} [date]
 * @returns {string}
 */
export function formatNzPromptNow(date = new Date()) {
  return formatPromptNow(date, NZ_TZ);
}

/**
 * Compact human duration: "7h12m", "3m", "45s", "2d4h".
 * @param {number} ms - duration in milliseconds
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin - totalHr * 60;
  if (totalHr < 24) return remMin ? `${totalHr}h${remMin}m` : `${totalHr}h`;
  const totalDay = Math.floor(totalHr / 24);
  const remHr = totalHr - totalDay * 24;
  return remHr ? `${totalDay}d${remHr}h` : `${totalDay}d`;
}

/**
 * Build the time-awareness block injected at the end of the prompt.
 * Always includes a `Now:` line; optionally a `Last turn:` line with gap
 * when a valid timestamp is provided.
 * @param {Object} [opts]
 * @param {Date|string|null} [opts.lastTurnAt] - timestamp of last assistant/user turn
 * @param {string} [opts.timezone] - IANA tz; resolved via resolveTimezone
 * @param {Date} [opts.now] - injected for testing
 * @returns {string}
 */
export function buildTimeContext({ lastTurnAt = null, timezone, now = new Date() } = {}) {
  const tz = resolveTimezone(timezone);
  const lines = [`Current time: ${formatPromptNow(now, tz)}`];
  const last = parseDbDate(lastTurnAt);
  if (last) {
    const gapMs = now.getTime() - last.getTime();
    if (gapMs >= 0) {
      const gap = formatDuration(gapMs) || '0s';
      lines.push(`Last turn: ${formatPromptNow(last, tz)} (${gap} ago)`);
    }
  }
  return lines.join('\n');
}
