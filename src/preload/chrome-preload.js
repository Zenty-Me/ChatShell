'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 自定义标题栏的桥。只暴露必要动作，不暴露 ipcRenderer 本体。
 *
 * 通道说明（注意别混）：
 *   chrome:window        —— invoke，向上请求一个「窗口动作」(minimize/maximize/close/...)
 *   chrome:window-state  —— 主进程 push 下来的窗口状态（是否最大化、置顶、紧凑档…）
 */
contextBridge.exposeInMainWorld('dsChrome', {
  windowAction: (action) => ipcRenderer.invoke('chrome:window', { action }),
  tabAction: (action, id) => ipcRenderer.invoke('chrome:tab', { action, id }),
  zoom: (delta, reset) => ipcRenderer.invoke('chrome:zoom', { delta, reset }),
  openPalette: () => ipcRenderer.invoke('chrome:palette'),
  diagnose: () => ipcRenderer.invoke('chrome:diagnose'),
  getState: () => ipcRenderer.invoke('chrome:state'),

  // 拖拽窗口（用 send 而不是 invoke：拖动时每秒几十次，不需要返回值）
  dragStart: (screenX, screenY) => ipcRenderer.send('chrome:drag-start', { screenX, screenY }),
  dragMove: (screenX, screenY) => ipcRenderer.send('chrome:drag-move', { screenX, screenY }),
  dragEnd: () => ipcRenderer.send('chrome:drag-end'),

  onTabs: (cb) => {
    ipcRenderer.on('chrome:tabs', (_e, payload) => cb(payload));
  },
  onWindow: (cb) => {
    ipcRenderer.on('chrome:window-state', (_e, payload) => cb(payload));
  },
});
