// SPDX-License-Identifier: AGPL-3.0-or-later
// Lightweight singleton event bus for Live tab.
// Emitters call bus.emit(type, data); dashboard subscribes and forwards to SSE.
// Dual-consumed: CJS (engine.cjs) via require, ESM (agent-runtime.js) via default import.

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);

bus.safeEmit = function safeEmit(type, data) {
  try { bus.emit('live', { type, data: data || {} }); } catch {}
};

module.exports = bus;
module.exports.default = bus;
