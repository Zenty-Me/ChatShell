'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 快捷问答面板的桥。
 *
 * 通道约定：
 *   quickask:ask / close / copy              —— 面板 → 主进程的动作
 *   quickask:drag-start / drag-move / drag-end —— 拖动面板（用 send，拖动时每秒几十次）
 *   quickask:state / reset                   —— 主进程 push 下来的状态
 */
contextBridge.exposeInMainWorld('csQuickAsk', {
  ask: (text) => ipcRenderer.send('quickask:ask', { text }),
  close: () => ipcRenderer.send('quickask:close'),
  copy: () => ipcRenderer.send('quickask:copy'),
  newSession: () => ipcRenderer.send('quickask:new-session'),

  // 拖动：和标题栏一样由 JS 接管。不用 -webkit-app-region: drag ——
  // 拖拽区一旦盖住输入框，就会出现「点不进输入框」这类没法用脚本回归的问题。
  dragStart: (screenX, screenY) => ipcRenderer.send('quickask:drag-start', { screenX, screenY }),
  dragMove: (screenX, screenY) => ipcRenderer.send('quickask:drag-move', { screenX, screenY }),
  dragEnd: () => ipcRenderer.send('quickask:drag-end'),

  onState: (cb) => ipcRenderer.on('quickask:state', (_e, payload) => cb(payload)),
  onReset: (cb) => ipcRenderer.on('quickask:reset', () => cb()),
});
