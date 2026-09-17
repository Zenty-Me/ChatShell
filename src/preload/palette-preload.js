'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Prompt 调色板的桥 */
contextBridge.exposeInMainWorld('dsPalette', {
  list: (query) => ipcRenderer.invoke('palette:list', query),
  save: (item) => ipcRenderer.invoke('palette:save', item),
  remove: (id) => ipcRenderer.invoke('palette:delete', id),
  send: (text, submit) => ipcRenderer.invoke('palette:send', { text, submit }),
  close: () => ipcRenderer.invoke('palette:close'),

  onReset: (cb) => ipcRenderer.on('palette:reset', () => cb()),
});
