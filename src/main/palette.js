'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { PATHS } = require('./paths');
const { log } = require('./log');
const { CHROME_HEIGHT } = require('./window-manager');

const PALETTE_WIDTH = 480;
const PALETTE_HEIGHT = 520;

/**
 * Prompt 调色板。
 * 标题栏只有 40px 高，放不下下拉面板，所以单独开一个无边框小窗挂在标题栏下方——
 * 这样它就能有自己的滚动区、搜索框和编辑表单。
 */
class PaletteWindow {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = null;
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const dark = this.ctx.theme() === 'dark';
    this.win = new BrowserWindow({
      width: PALETTE_WIDTH,
      height: PALETTE_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: dark ? '#202124' : '#ffffff',
      webPreferences: {
        preload: path.join(PATHS.preload, 'palette-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.win.loadFile(path.join(PATHS.renderer, 'palette.html'));
    this.win.on('blur', () => this.close());
    this.win.on('closed', () => {
      this.win = null;
    });
    return this.win;
  }

  position() {
    const host = this.ctx.windows.target();
    let x;
    let y;
    try {
      const b = host ? host.win.getBounds() : screen.getPrimaryDisplay().workArea;
      x = Math.round(b.x + b.width - PALETTE_WIDTH - 16);
      y = Math.round(b.y + CHROME_HEIGHT + 8);
    } catch (_) {
      const wa = screen.getPrimaryDisplay().workArea;
      x = wa.x + wa.width - PALETTE_WIDTH - 16;
      y = wa.y + 64;
    }
    // 别跑到屏幕外
    const area = screen.getDisplayNearestPoint({ x, y }).workArea;
    x = Math.min(Math.max(x, area.x + 8), area.x + area.width - PALETTE_WIDTH - 8);
    y = Math.min(Math.max(y, area.y + 8), area.y + area.height - PALETTE_HEIGHT - 8);
    return { x, y };
  }

  toggle() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.close();
      return;
    }
    this.open();
  }

  open() {
    const win = this.ensure();
    const { x, y } = this.position();
    win.setBounds({ x, y, width: PALETTE_WIDTH, height: PALETTE_HEIGHT });
    win.showInactive();
    win.show();
    win.focus();
    try {
      win.webContents.send('palette:reset');
    } catch (_) {
      /* ignore */
    }
    log.info('Prompt 调色板已打开');
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { PaletteWindow };
