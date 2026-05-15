// SPDX-License-Identifier: AGPL-3.0-or-later
// Renderer-side bridge — exposes a small, intentional surface to the BrowserWindow.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('constellation', {
  status:           () => ipcRenderer.invoke('engine:status'),
  logs:             (opts) => ipcRenderer.invoke('engine:logs', opts || {}),
  openDashboard:    () => ipcRenderer.invoke('dashboard:open'),
  openExternal:     (url) => ipcRenderer.invoke('app:open-external', url),
  onLog:            (cb) => ipcRenderer.on('engine:log', (_e, line) => cb(line)),
  // Lifecycle controls (Library Sprint 1 — B3)
  engineStart:      () => ipcRenderer.invoke('engine:start'),
  engineStop:       () => ipcRenderer.invoke('engine:stop'),
  engineRestart:    () => ipcRenderer.invoke('engine:restart'),
  onEngineCrashed:  (cb) => ipcRenderer.on('engine:crashed', (_e, info) => cb(info)),
  // Debug bar (B6) — proxied HTTP to local engine; avoids renderer CORS.
  engineRequest:    (opts) => ipcRenderer.invoke('engine:request', opts || {}),
  // Log utilities
  saveLog:          () => ipcRenderer.invoke('engine:save-log'),
  // Onboarding wizard surface
  envCheck:         () => ipcRenderer.invoke('onboarding:env-check'),
  sentinelStatus:   () => ipcRenderer.invoke('onboarding:sentinel-status'),
  advanceToEngine:  () => ipcRenderer.invoke('onboarding:advance-to-engine'),
  finishOnboarding: () => ipcRenderer.invoke('onboarding:finish'),
  versionSkipOnboarding: () => ipcRenderer.invoke('onboarding:version-skip'),
  submitProfileSeed: (payload) => ipcRenderer.invoke('wizard:submit-profile-seed', payload || {}),
  requestNotificationPermission: () => ipcRenderer.invoke('onboarding:request-notification-permission'),
  setNotificationsOptIn: (enabled) => ipcRenderer.invoke('onboarding:set-notifications-opt-in', !!enabled),
  getTelegramLinkCode: () => ipcRenderer.invoke('onboarding:get-telegram-link-code'),
  telegramTestToken:  (payload) => ipcRenderer.invoke('onboarding:telegram-test-token', payload || {}),
  telegramFetchChatId:(payload) => ipcRenderer.invoke('onboarding:telegram-fetch-chatid', payload || {}),
  telegramSave:       (payload) => ipcRenderer.invoke('onboarding:telegram-save', payload || {}),
  // Stage 4: engine startup
  onEngineBootProgress: (cb) => ipcRenderer.on('engine:boot-progress', (_e, p) => cb(p)),
  engineRetry:      () => ipcRenderer.invoke('onboarding:engine-retry'),
  engineReset:      () => ipcRenderer.invoke('onboarding:engine-reset'),
  openEngineLogs:   () => ipcRenderer.invoke('onboarding:open-engine-logs'),
  reportIssue:      () => ipcRenderer.invoke('onboarding:report-issue'),
  // Stage 3: LLM configuration
  llmListProviders:  () => ipcRenderer.invoke('onboarding:llm-list-providers'),
  llmListModels:     (opts) => ipcRenderer.invoke('onboarding:llm-list-models', opts || {}),
  llmTestConnection: (opts) => ipcRenderer.invoke('onboarding:llm-test-connection', opts || {}),
  llmSaveConfig:     (payload) => ipcRenderer.invoke('onboarding:llm-save-config', payload || {}),
  // Wizard draft persistence (S6)
  wizardSaveDraft:   (draft) => ipcRenderer.invoke('wizard:save-draft', draft),
  wizardLoadDraft:   () => ipcRenderer.invoke('wizard:load-draft'),
  wizardClearDraft:  () => ipcRenderer.invoke('wizard:clear-draft'),
  // Permission disclosure (Stage 4.5 — Batch E)
  permissionStatus:       () => ipcRenderer.invoke('permission:status'),
  permissionAcknowledge:  () => ipcRenderer.invoke('permission:acknowledge'),
  permissionCancel:       () => ipcRenderer.invoke('permission:cancel'),
  permissionOpenFolder:   () => ipcRenderer.invoke('permission:open-engine-folder'),
  permissionOpenPolicy:   () => ipcRenderer.invoke('permission:open-policy'),
  // Stage 2: component download
  listComponents:        () => ipcRenderer.invoke('onboarding:list-components'),
  downloadStart:         (componentId, mirrorOverride) =>
                            ipcRenderer.invoke('onboarding:download-start', { componentId, mirrorOverride }),
  downloadCancel:        (componentId) =>
                            ipcRenderer.invoke('onboarding:download-cancel', { componentId }),
  isComponentInstalled:  (componentId) =>
                            ipcRenderer.invoke('onboarding:component-installed', { componentId }),
  onDownloadFileStart:     (cb) => ipcRenderer.on('download:file-start',     (_e, p) => cb(p)),
  onDownloadFileDone:      (cb) => ipcRenderer.on('download:file-done',      (_e, p) => cb(p)),
  onDownloadProgress:      (cb) => ipcRenderer.on('download:progress',       (_e, p) => cb(p)),
  onDownloadMirrorFail:    (cb) => ipcRenderer.on('download:mirror-fail',    (_e, p) => cb(p)),
  onDownloadComponentDone: (cb) => ipcRenderer.on('download:component-done', (_e, p) => cb(p)),
  onDownloadComponentFail: (cb) => ipcRenderer.on('download:component-fail', (_e, p) => cb(p)),
  onDownloadAborted:       (cb) => ipcRenderer.on('download:aborted',        (_e, p) => cb(p)),
  // Auto-update (Phase 2 — electron-updater)
  updateGetState:   () => ipcRenderer.invoke('update:get-state'),
  updateCheck:      () => ipcRenderer.invoke('update:check'),
  updateInstall:    () => ipcRenderer.invoke('update:install'),
  onUpdateState:    (cb) => ipcRenderer.on('update:state', (_e, s) => cb(s)),
  // Wizard Stage 10: Memory Import (agent-guided + heuristic routes)
  openImportPicker: () => ipcRenderer.invoke('wizard:open-import-picker'),
  openImportFiles:  () => ipcRenderer.invoke('wizard:open-import-files'),
  // P36: resolves a DOM File (from drag-drop or input) to its absolute path.
  // Required because Electron 32 dropped the `File.path` accessor.
  getPathForFile:   (file) => {
    try { return webUtils.getPathForFile(file); }
    catch { return ''; }
  },
  importPreview:    (opts) => ipcRenderer.invoke('wizard:import-preview', opts || {}),
  importRun:        (opts) => ipcRenderer.invoke('wizard:import-run', opts || {}),
  onImportProgress: (cb) => ipcRenderer.on('wizard:import-progress', (_e, p) => cb(p)),
  importReflection: (opts) => ipcRenderer.invoke('wizard:import-reflection', opts || {}),
  // Wizard Stage 11: Soul Core Refinement
  soulCoreDraft:    (opts) => ipcRenderer.invoke('wizard:soul-core-draft', opts || {}),
  soulCoreSave:     (opts) => ipcRenderer.invoke('wizard:soul-core-save', opts || {}),
});
