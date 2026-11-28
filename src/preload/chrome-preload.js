'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', {
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`,

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  fetchLyrics: (meta, options) => ipcRenderer.invoke('lyrics:fetch', meta, options),
  sendPlayerState: (state) => ipcRenderer.send('player:state', state),
  heartbeat: () => ipcRenderer.send('renderer:heartbeat'),
  reportPlayerStalled: () => ipcRenderer.send('renderer:player-stalled'),

  onCommand: (callback) => subscribe('app:command', callback),
  onSettingsChanged: (callback) => subscribe('settings:changed', callback),
  onGuestCrashed: (callback) => subscribe('guest:crashed', callback),
  onWindowResume: (callback) => subscribe('window:resume', callback),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onState: (callback) => subscribe('window:state', callback)
  },

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  confirmSignOut: () => ipcRenderer.invoke('app:confirm-signout'),
  copyDiagnostics: () => ipcRenderer.invoke('app:copy-diagnostics'),
  openAppData: () => ipcRenderer.invoke('app:open-user-data'),

  sleepTimer: {
    get: () => ipcRenderer.invoke('sleep-timer:get'),
    start: (minutes) => ipcRenderer.invoke('sleep-timer:start', minutes),
    cancel: () => ipcRenderer.invoke('sleep-timer:cancel'),
    onStatus: (callback) => subscribe('sleep-timer:status', callback)
  },

  browserSignIn: () => ipcRenderer.invoke('auth:browser-sign-in'),
  cancelBrowserSignIn: () => ipcRenderer.invoke('auth:browser-cancel'),
  onAuthStatus: (callback) => subscribe('auth:status', callback),

  discord: {
    getStatus: () => ipcRenderer.invoke('discord:status'),
    reconnect: () => ipcRenderer.invoke('discord:reconnect'),
    onStatus: (callback) => subscribe('discord:status', callback)
  },

  sponsorBlock: {
    getSegments: (videoId, categories) => ipcRenderer.invoke('sponsorblock:segments', videoId, categories)
  },

  downloads: {
    getStatus: () => ipcRenderer.invoke('downloads:status'),
    installTool: () => ipcRenderer.invoke('downloads:install-tool'),
    updateTool: () => ipcRenderer.invoke('downloads:update-tool'),
    chooseFolder: () => ipcRenderer.invoke('downloads:choose-folder'),
    start: (meta, options) => ipcRenderer.invoke('downloads:start', meta, options || {}),
    retry: (meta, options) => ipcRenderer.invoke('downloads:retry', meta, options || {}),
    startMany: (payload) => ipcRenderer.invoke('downloads:start-many', payload || {}),
    list: () => ipcRenderer.invoke('downloads:list'),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    remove: (id) => ipcRenderer.invoke('downloads:remove', id),
    openFolder: () => ipcRenderer.invoke('downloads:open-folder'),
    openLog: () => ipcRenderer.invoke('downloads:open-log'),
    reveal: (id) => ipcRenderer.invoke('downloads:reveal', id),
    onEvent: (callback) => subscribe('downloads:event', callback)
  },

  updater: {
    getStatus: () => ipcRenderer.invoke('updater:status'),
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback) => subscribe('update:status', callback)
  }
});
