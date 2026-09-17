'use strict';

const path = require('path');
const fs = require('fs');
const { Tray, Menu, nativeImage, app, dialog, shell, clipboard } = require('electron');
const { PATHS } = require('./paths');
const { log } = require('./log');
const { BRAND } = require('./branding');

/** 生成 / 读取托盘图标；找不到就用代码画一个，绝不让 Tray 构造失败 */
function loadTrayIcon() {
  const candidates = [
    path.join(PATHS.root, 'build', 'icon.png'),
    path.join(PATHS.root, 'build', 'tray.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
      }
    } catch (_) {
      /* 试下一个 */
    }
  }
  // 兜底：16x16 纯色方块（brand 蓝 #4D6BFE）
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0xfe; // B
    buf[i * 4 + 1] = 0x6b; // G
    buf[i * 4 + 2] = 0x4d; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function applyAutoLaunch(enabled) {
  try {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    const opts = { openAtLogin: !!enabled, path: process.execPath, args: [] };
    if (!app.isPackaged) {
      opts.args = [path.resolve(path.join(__dirname, '..', '..'))];
    } else {
      opts.args = ['--hidden'];
    }
    app.setLoginItemSettings(opts);
    log.info(`开机自启: ${enabled ? '已开启' : '已关闭'}`);
  } catch (err) {
    log.warn(`设置开机自启失败: ${err.message}`);
  }
}

function readAutoLaunch() {
  try {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
}

class TrayController {
  constructor(ctx) {
    this.ctx = ctx;
    this.tray = null;
  }

  /** 托盘常驻 = 关掉窗口也不退出，配合全局热键才有「一键呼出」的意义 */
  get keepAlive() {
    return this.ctx.config.get('hideToTrayOnClose') !== false;
  }

  init() {
    try {
      this.tray = new Tray(loadTrayIcon());
    } catch (err) {
      log.error(`托盘创建失败（应用仍可使用，但无法常驻）: ${err.message}`);
      return;
    }
    this.tray.setToolTip(BRAND.name);
    this.tray.on('click', () => this.ctx.windows.toggleVisible());
    this.tray.on('double-click', () => this.ctx.windows.focusLast());
    this.rebuild();

    // 首次运行把「开机自启」落到系统里（纯诊断运行不写注册表）
    if (this.ctx.config.get('autoLaunch') && !this.ctx.isSelfCheck && !this.ctx.isVerify) applyAutoLaunch(true);
  }

  promptItems() {
    const items = this.ctx.prompts.get('items', []) || [];
    if (!items.length) return [{ label: '（Prompt 库为空）', enabled: false }];
    return items.slice(0, 20).map((p) => ({
      label: p.title || String(p.text || '').slice(0, 20),
      click: () => this.ctx.windows.sendPrompt(p.text || p.title, { submit: true }),
    }));
  }

  toggleInject(key, label) {
    const inj = { ...(this.ctx.config.get('injection') || {}) };
    inj[key] = !inj[key];
    this.ctx.config.set('injection', inj);
    for (const w of this.ctx.windows.all()) w.refreshInjection();
    log.info(`注入开关 ${label}: ${inj[key] ? '开' : '关'}`);
    this.rebuild();
  }

  buildTemplate() {
    const cfg = this.ctx.config;
    const inj = cfg.get('injection') || {};
    const hotkey = this.ctx.shortcuts ? this.ctx.shortcuts.activeAccelerator : cfg.get('hotkey');
    const quickAskKey = this.ctx.shortcuts ? this.ctx.shortcuts.activeQuickAskAccelerator : cfg.get('quickAskHotkey');
    const win = this.ctx.windows.target();

    return [
      { label: `显示 / 隐藏　${hotkey ? `(${hotkey})` : ''}`, click: () => this.ctx.windows.toggleVisible() },
      {
        label: `快捷问答　${quickAskKey ? `(${quickAskKey})` : ''}`,
        click: () => this.ctx.openQuickAsk(),
      },
      { type: 'separator' },
      { label: '新建会话', click: () => this.newTab() },
      { label: '新建窗口（共享登录态）', click: () => this.ctx.windows.create() },
      { type: 'separator' },
      { label: 'Prompt 模板', submenu: this.promptItems() },
      {
        label: '编辑 Prompt 库…',
        click: () => shell.openPath(PATHS.promptsFile),
      },
      { type: 'separator' },
      {
        label: '紧凑小窗口',
        type: 'checkbox',
        checked: cfg.get('window').compact !== false,
        click: () => {
          const target = this.ctx.windows.target();
          if (target) target.toggleCompact();
          this.rebuild();
        },
      },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: !!(win && win.win.isAlwaysOnTop()),
        click: () => {
          const target = this.ctx.windows.target();
          if (target) target.toggleAlwaysOnTop();
          this.rebuild();
        },
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: readAutoLaunch(),
        click: (item) => {
          cfg.set('autoLaunch', item.checked);
          applyAutoLaunch(item.checked);
          this.rebuild();
        },
      },
      {
        label: '关闭窗口时收进托盘',
        type: 'checkbox',
        checked: cfg.get('hideToTrayOnClose') !== false,
        click: (item) => {
          cfg.set('hideToTrayOnClose', item.checked);
          this.rebuild();
        },
      },
      {
        label: '缩放',
        submenu: [1, 1.1, 1.25, 1.5, 2].map((f) => ({
          label: `${Math.round(f * 100)}%`,
          type: 'radio',
          checked: Math.abs((cfg.get('zoomFactor') || 1) - f) < 0.01,
          click: () => {
            this.ctx.windows.setZoomOnAll(f);
            this.rebuild();
          },
        })),
      },
      { type: 'separator' },
      {
        label: '注入（站点改造）',
        submenu: [
          {
            label: '总开关',
            type: 'checkbox',
            checked: inj.enabled !== false,
            click: () => this.toggleInject('enabled', '总开关'),
          },
          { type: 'separator' },
          {
            label: '紧凑模式（省垂直空间）',
            type: 'checkbox',
            checked: inj.compact !== false,
            click: () => this.toggleInject('compact', '紧凑模式'),
          },
          {
            label: '隐藏无关元素（下载 App / 公告）',
            type: 'checkbox',
            checked: inj.hideExtras !== false,
            click: () => this.toggleInject('hideExtras', '隐藏无关元素'),
          },
          {
            label: '隐藏左侧栏',
            type: 'checkbox',
            checked: inj.hideSidebar === true,
            click: () => this.toggleInject('hideSidebar', '隐藏左侧栏'),
          },
          {
            label: 'Ctrl+Enter 发送',
            type: 'checkbox',
            checked: inj.ctrlEnterToSend !== false,
            click: () => this.toggleInject('ctrlEnterToSend', 'Ctrl+Enter 发送'),
          },
          {
            label: '页内悬浮条（MD / 新的 / 重载）',
            type: 'checkbox',
            checked: inj.copyButtons === true,
            click: () => this.toggleInject('copyButtons', '页内悬浮条'),
          },
        ],
      },
      {
        label: '选择器自检（站点改版后点这里）',
        click: () => this.ctx.diagnose(),
      },
      { type: 'separator' },
      {
        label: '验证登录态是否持久化',
        click: () => this.ctx.verifyLoginNow(),
      },
      { label: '打开数据目录', click: () => shell.openPath(PATHS.userData) },
      { label: '打开注入配置 selectors.json', click: () => shell.openPath(path.join(PATHS.inject, 'selectors.json')) },
      { label: '打开日志', click: () => shell.openPath(PATHS.loginLog) },
      {
        label: '关于',
        click: () => {
          const hotkey = this.ctx.shortcuts ? this.ctx.shortcuts.activeAccelerator : cfg.get('hotkey');
          const ua = cfg.get('userAgent') || '(Chromium 默认)';
          const text = [
            `${BRAND.name} ${app.getVersion()}　${BRAND.tagline}`,
            `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
            '',
            `登录态 partition: ${cfg.get('site').partition}`,
            `呼出热键: ${hotkey || '(未注册)'}`,
            `快捷问答: ${quickAskKey || '(未注册)'}`,
            `UA: ${ua}`,
            '',
            '快捷键：Ctrl+T 新会话 / Ctrl+W 关会话 / Ctrl+Tab 切换 / Ctrl+R 刷新 / Ctrl+Shift+N 新窗口',
          ].join('\n');
          dialog.showMessageBox({ type: 'info', title: '关于', message: BRAND.name, detail: text, buttons: ['好'] });
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => this.ctx.windows.quit() },
    ];
  }

  newTab() {
    const win = this.ctx.windows.target() || this.ctx.windows.create();
    win.createTab(null, { activate: true });
    win.show();
  }

  rebuild() {
    if (!this.tray) return;
    try {
      this.tray.setContextMenu(Menu.buildFromTemplate(this.buildTemplate()));
    } catch (err) {
      log.warn(`托盘菜单重建失败: ${err.message}`);
    }
  }

  notify(title, content) {
    if (!this.tray) return;
    try {
      this.tray.displayBalloon({ title, content });
    } catch (_) {
      /* Windows 之外会失败，忽略 */
    }
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayController, applyAutoLaunch, loadTrayIcon };
