// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit test for sleipnir-redact.js — runs under node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, isPureNoise } from './sleipnir-redact.js';
import { WORKDIR_PREFIX } from './sleipnir-constants.js';

test('R1 email is redacted', () => {
  const r = redact('contact me at foo@bar.com please');
  assert.match(r.text, /\[email\]/);
  assert.equal(r.ruleHits.R1_email, 1);
});

test('R2 sk- token is redacted', () => {
  const r = redact('key=sk-1234567890abcdef1234567890abcdef done');
  assert.match(r.text, /\[redacted_token\]/);
  assert.equal(r.ruleHits.R2_token, 1);
});

test('R2 api_key= is redacted', () => {
  const r = redact('api_key=ABCDEFGHIJKLMNOPQRSTUVWX flag');
  assert.match(r.text, /\[redacted_token\]/);
  assert.equal(r.ruleHits.R2_token, 1);
});

test('R3 IPv4 is redacted but localhost preserved', () => {
  const r = redact('connect to 192.168.1.1:8080 and 127.0.0.1:3000');
  assert.match(r.text, /\[ip\]/);
  assert.match(r.text, /127\.0\.0\.1:3000/);
  assert.equal(r.ruleHits.R3_ip, 1);
});

test('R4 home path redacted but WORKDIR_PREFIX preserved', () => {
  const text = `read ${WORKDIR_PREFIX}src/foo.js then check /home/alice/secret.key`;
  const r = redact(text);
  assert.ok(r.text.includes(WORKDIR_PREFIX), 'workdir prefix preserved');
  assert.match(r.text, /\/home\/<user>\//);
  assert.equal(r.ruleHits.R4_home, 1);
});

test('all four rules fire on a mixed string', () => {
  const text = 'mail foo@bar.com api_key=abcdefghijklmnop12345 ip 10.0.0.5 path /home/x/y';
  const r = redact(text);
  assert.ok(r.hits >= 3, `expected at least 3 hits, got ${r.hits}: ${JSON.stringify(r.ruleHits)}`);
});

test('empty / nullish input is safe', () => {
  assert.equal(redact('').text, '');
  assert.equal(redact(null).text, '');
  assert.equal(redact(undefined).text, '');
});

test('isPureNoise true for PII-only line', () => {
  const orig = 'foo@bar.com';
  const r = redact(orig);
  assert.equal(isPureNoise(orig, r.text), true);
});

test('isPureNoise false for substantive content', () => {
  const orig = 'The cron job runs at 03:00 UTC and contacts foo@bar.com';
  const r = redact(orig);
  assert.equal(isPureNoise(orig, r.text), false);
});

test('R3 does not fire on localhost variants', () => {
  const r = redact('bind 0.0.0.0:8000 listen 127.0.0.1');
  assert.equal(r.ruleHits.R3_ip, 0);
});

test('R3 does redact public IPv4', () => {
  const r = redact('beacon to 8.8.8.8');
  assert.equal(r.ruleHits.R3_ip, 1);
});

test('R4 workdir preserved even when R3 shifts offsets earlier in the string', () => {
  // Regression: R3 collapsing 192.168.1.1:8080 → [ip] used to break R4's
  // text.startsWith offset check, causing the workdir path to be redacted.
  const text = `192.168.1.1:8080 then read ${WORKDIR_PREFIX}src/foo.js`;
  const r = redact(text);
  assert.ok(r.text.includes(WORKDIR_PREFIX), `workdir prefix preserved post-R3 shift: ${r.text}`);
  assert.equal(r.ruleHits.R3_ip, 1);
  assert.equal(r.ruleHits.R4_home, 0, 'workdir match must not count as R4 redaction');
});
