'use strict';

const { globalShortcut } = require('electron');
const { log } = require('./log');

/**
 * 全局热键。默认 Alt+Space（Spotlight 手感）。
 *
 * 注意：Windows 上 Alt+Space 默认是「窗口系统菜单」，注册经常失败。
 * 所以这里按 config.hotkeyFallbacks 顺序回退，并把最终生效的那个记下来，
 * 托盘菜单里会显示真实生效的组合键（不显示配置值，避免"我明明设了却没用"）。
 */
class ShortcutManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.activeAccelerator = null;
    this.activePromptAccelerator = null;
    this.activeQuickAskAccelerator = null;
  }

  init() {
    const cfg = this.ctx.config;
    const primary = cfg.get('hotkey') || 'Alt+Space';
    const fallbacks = cfg.get('hotkeyFallbacks') || [];
    this.activeAccelerator = this.registerFirst([primary, ...fallbacks], '呼出/隐藏', () =>
      this.ctx.windows.toggleVisible()
    );

    this.activePromptAccelerator = this.registerFirst(
      [cfg.get('promptHotkey') || 'Control+Alt+P'],
      'Prompt 调色板',
      () => this.ctx.openPalette()
    );

    this.activeQuickAskAccelerator = this.registerFirst(
      [cfg.get('quickAskHotkey') || 'Control+Shift+Space'],
      '快捷问答面板',
      () => this.ctx.openQuickAsk()
    );

    if (!this.activeAccelerator) {
      log.warn('所有呼出热键都被占用，请到 config.json 改 hotkey');
      if (this.ctx.tray) {
        this.ctx.tray.notify('热键注册失败', 'Alt+Space 被系统占用，请到托盘「关于」里查看或改 config.json');
      }
    } else {
      log.info(`呼出热键生效: ${this.activeAccelerator}`);
    }
    if (this.ctx.tray) this.ctx.tray.rebuild();
  }

  registerFirst(list, label, handler) {
    for (const acc of list) {
      if (!acc) continue;
      try {
        if (globalShortcut.isRegistered(acc)) {
          log.warn(`热键已被占用: ${acc}`);
          continue;
        }
        const ok = globalShortcut.register(acc, handler);
        if (ok) {
          if (acc !== list[0]) log.warn(`${label} 热键降级为 ${acc}`);
          return acc;
        }
        log.warn(`${label} 热键注册失败: ${acc}`);
      } catch (err) {
        log.warn(`${label} 热键异常 ${acc}: ${err.message}`);
      }
    }
    return null;
  }

  dispose() {
    try {
      globalShortcut.unregisterAll();
    } catch (_) {
      /* ignore */
    }
    this.activeAccelerator = null;
    this.activePromptAccelerator = null;
  }
}

module.exports = { ShortcutManager };
