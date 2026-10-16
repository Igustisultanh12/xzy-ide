'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r || !r.ok) throw new Error((r && r.error) || 'Terjadi kesalahan');
  return r.data;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('xzy', {
  info: () => call('app:info'),
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    test: (patch) => call('settings:test', patch),
  },
  models: () => call('models:list'),
  workspace: {
    pick: () => call('workspace:pick'),
    open: (folder) => call('workspace:open', folder),
    current: () => call('workspace:current'),
    close: () => call('workspace:close'),
  },
  fs: {
    list: (rel) => call('fs:list', rel),
    read: (rel) => call('fs:read', rel),
    write: (rel, content) => call('fs:write', rel, content),
    create: (rel, isDir) => call('fs:create', rel, isDir),
    rename: (from, to) => call('fs:rename', from, to),
    remove: (rel) => call('fs:delete', rel),
    allFiles: () => call('fs:allFiles'),
    search: (q, opts) => call('fs:search', q, opts),
    reveal: (rel) => call('fs:reveal', rel),
    onChanged: (cb) => on('fs:changed', cb),
    pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : ''),
  },
  term: {
    create: (id, opts) => call('term:create', id, opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: (id) => call('term:kill', id),
    onData: (cb) => on('term:data', cb),
    onExit: (cb) => on('term:exit', cb),
  },
  agent: {
    list: () => call('agent:list'),
    create: (opts) => call('agent:create', opts),
    get: (id) => call('agent:get', id),
    send: (id, text, attachments, context) => call('agent:send', id, text, attachments, context),
    stop: (id) => call('agent:stop', id),
    permission: (id, requestId, decision) => call('agent:permission', id, requestId, decision),
    setMode: (id, mode) => call('agent:setMode', id, mode),
    setModel: (id, model) => call('agent:setModel', id, model),
    rename: (id, title) => call('agent:rename', id, title),
    undo: (id) => call('agent:undo', id),
    clear: (id) => call('agent:clear', id),
    remove: (id) => call('agent:delete', id),
    onEvent: (cb) => on('agent:event', cb),
  },
  ai: {
    inlineEdit: (req) => call('ai:inlineEdit', req),
  },
  git: {
    status: () => call('git:status'),
    headFile: (rel) => call('git:headFile', rel),
    commit: (message, all) => call('git:commit', message, all),
    run: (args) => call('git:run', args),
  },
  openExternal: (url) => call('shell:open', url),
  confirm: (message, detail) => call('dialog:confirm', message, detail),
  onMenu: (cb) => on('menu', cb),
});
