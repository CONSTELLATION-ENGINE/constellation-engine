// SPDX-License-Identifier: AGPL-3.0-or-later
// Splash preload: exposes a tiny IPC bridge so the splash window can
// (a) receive `splash:error` events from main and (b) trigger a "Reset Setup"
// recovery action when the engine wedges before the wizard / library opens.
//
// The splash is intentionally minimal — no preload was wired originally, so
// errors from main.webContents.send('splash:error', …) silently dropped on the
// floor. This bridge lights up the existing message handler and adds a single
// recovery escape hatch.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onError: (cb) => {
    ipcRenderer.on('splash:error', (_evt, payload) => {
      try { cb(payload); } catch {}
    });
  },
  resetSetup: () => ipcRenderer.invoke('splash:reset-setup'),
});
