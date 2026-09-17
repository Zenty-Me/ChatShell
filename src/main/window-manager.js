'use strict';

const path = require('path');
const { BaseWindow, WebContentsView, Menu, shell, app, nativeTheme, screen } = require('electron');
const { PATHS } = require('./paths');
const { log } = require('./log');
const injection = require('./injection');
const uaPolicy = require('./useragent');

/** 自定义标题栏的高度（省下来的垂直空间就是这里） */
const CHROME_HEIGHT = 40;

/**
 * 判定「实测尺寸 vs 请求尺寸」的容差。
 * 分数 DPI 缩放下 OS 会把窗口尺寸舍入到整数物理像素，折算回 DIP 会差 1~3px；
 * 超过这个值就认为用户真的手动缩放过。
 */
const SIZE_TOLERANCE = 6;

/** 只有这些域名算「站内」，其它一律丢系统浏览器 */
function isInternalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'deepseek.com' || host.endsWith('.deepseek.com');
  } catch (_) {
    return false;
  }
}

function isHttpUrl(rawUrl) {
  return /^https?:/i.test(String(rawUrl || ''));
}

/** View 的可见性切换，setVisible 不存在时退化为「挪到屏幕外」 */
function setViewVisible(view, visible) {
  try {
    if (typeof view.setVisible === 'function') {
      view.setVisible(visible);
      return;
    }
  } catch (_) {
    /* 落到下面的兜底 */
  }
  try {
    if (!visible) view.setBounds({ x: -20000, y: -20000, width: 100, height: 100 });
  } catch (_) {
    /* ignore */
  }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

/** canGoBack/goBack 在 Electron 44 已废弃，统一走 navigationHistory，老版本自动降级 */
function history(wc) {
  try {
    const h = wc.navigationHistory;
    if (h && typeof h.canGoBack === 'function') {
      return {
        canGoBack: () => h.canGoBack(),
        canGoForward: () => h.canGoForward(),
        goBack: () => h.goBack(),
        goForward: () => h.goForward(),
      };
    }
  } catch (_) {
    /* 降级 */
  }
  return {
    canGoBack: () => {
      try {
        return wc.canGoBack();
      } catch (_) {
        return false;
      }
    },
    canGoForward: () => {
      try {
        return wc.canGoForward();
      } catch (_) {
        return false;
      }
    },
    goBack: () => wc.goBack(),
    goForward: () => wc.goForward(),
  };
}

/**
 * UA 策略见 src/main/useragent.js：
 * 默认 'chrome' 模式抹掉 Electron/<app> 两个 token（DeepSeek 边缘节点就是靠这个
 * 返回 429 拦截页的），并做 Chrome 的 UA 缩减，最终与真实 Chrome 逐字节一致。
 */
function resolveUserAgent(configStore) {
  return uaPolicy.resolveUserAgent(configStore);
}

/* ========================================================================== */
/*                              单个窗口                                       */
/* ========================================================================== */

class AppWindow {
  constructor(manager, index) {
    this.manager = manager;
    this.ctx = manager.ctx;
    this.index = index;
    this.tabs = [];
    this.activeTabId = null;
    this.tabSeq = 0;
    this.quittingSelf = false;
    this.lastNormalBounds = null;
    this.requestedSize = null; // 我们主动请求的尺寸（用于区分「用户缩放」与「OS 舍入」）
    this.geometryReady = false; // 窗口刚创建时的 resize/move 是程序行为，不该落盘
    this.suppressPersist = false; // 自检合成交互期间临时关闭落盘
    this.preExpandPosition = null;
    this._saveState = debounce(() => this.persistBounds(), 500);

    const cfg = this.ctx.config;
    const site = cfg.get('site');
    const siteName = site.name || 'AI';
    const w = cfg.get('window');
    const size = this.currentSize(w);
    const spot = this.resolvePosition(w, size);

    this.win = new BaseWindow({
      width: size.width,
      height: size.height,
      x: spot.x,
      y: spot.y,
      // 允许缩得比紧凑默认值更小（小窗口场景下 480 还嫌宽）
      minWidth: 320,
      minHeight: 280,
      frame: false, // 无边框，标题栏我们自己画
      show: false,
      title: siteName,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#ffffff',
    });

    // 置顶：小窗口要「唤出即用」，不能被别的窗口盖住
    if (cfg.get('alwaysOnTop')) {
      try {
        this.win.setAlwaysOnTop(true, 'floating');
      } catch (err) {
        log.warn(`设置置顶失败: ${err.message}`);
      }
    }

    this.createChromeView();
    this.bindWindowEvents();
    this.createTab(site.home || 'https://chat.deepseek.com/', { activate: true });

    if (w.maximized) this.win.maximize();
    this.requestedSize = { width: size.width, height: size.height };
    this.layout();
    log.info(
      `窗口已创建: ${size.width}×${size.height} @ (${spot.x}, ${spot.y})  ` +
        `${w.compact !== false ? '紧凑' : '展开'} / 置顶=${!!cfg.get('alwaysOnTop')}`
    );
  }

  /** 当前档位对应的尺寸 */
  currentSize(w = this.ctx.config.get('window')) {
    const compact = w.compact !== false;
    const size = compact ? w.compactSize : w.expandedSize;
    const fallback = compact ? { width: 480, height: 700 } : { width: 1180, height: 820 };
    const width = Math.max(320, Math.round(Number(size && size.width) || fallback.width));
    const height = Math.max(280, Math.round(Number(size && size.height) || fallback.height));
    return { width, height, compact };
  }

  /**
   * 摆放位置。
   * 用户还没拖过（x/y 为 null）时自动停在「鼠标所在屏幕的上方居中」——
   * 热键唤出就能直接看到，不用去找窗口。拖动过之后就一直记住实际坐标。
   */
  resolvePosition(w, size) {
    if (Number.isInteger(w.x) && Number.isInteger(w.y)) return { x: w.x, y: w.y };
    try {
      const pt = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(pt).workArea;
      const width = Math.min(size.width, area.width);
      const height = Math.min(size.height, area.height);
      return {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + Math.max(32, area.height * 0.07)),
      };
    } catch (_) {
      return { x: undefined, y: undefined };
    }
  }

  /* ------------------------------ 顶部自定义标题栏 ------------------------------ */

  createChromeView() {
    this.chromeView = new WebContentsView({
      webPreferences: {
        preload: path.join(PATHS.preload, 'chrome-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.win.contentView.addChildView(this.chromeView);
    try {
      this.chromeView.setBackgroundColor('#00000000');
    } catch (_) {
      /* ignore */
    }
    this.chromeView.webContents.loadFile(path.join(PATHS.renderer, 'chrome.html'));
    this.chromeView.webContents.on('did-finish-load', () => {
      this.syncWindow();
      this.syncTabs();
    });
  }

  /* -------------------------------- 会话 Tab -------------------------------- */

  createTab(url, { activate = true, background = false } = {}) {
    const cfg = this.ctx.config;
    const site = cfg.get('site');
    const target = url || site.home;

    const view = new WebContentsView({
      webPreferences: {
        // ★ 登录态持久化的唯一开关：persist: 前缀 + 全程不清理存储
        partition: site.partition,
        // site-preload 用了第三方依赖（turndown），sandbox 下只能加载打包后的单文件 bundle
        preload: path.join(PATHS.dist, 'preload', 'site-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        zoomFactor: Number(cfg.get('zoomFactor')) || 1,
      },
    });

    const tab = {
      id: ++this.tabSeq,
      title: '新会话',
      url: target,
      loading: false,
      failed: false,
      failedUrl: '',
      view,
      active: false,
    };
    view._dsTabId = tab.id;

    this.win.contentView.addChildView(view);
    this.tabs.push(tab);
    this.bindSiteEvents(tab);
    this.applyUserAgent(view.webContents);

    view.webContents.loadURL(target).catch((err) => {
      log.warn(`站点加载失败(忽略): ${err.message}`);
    });

    if (activate) this.activateTab(tab.id);
    else {
      setViewVisible(view, false);
      this.layout();
    }
    this.syncTabs();
    return tab;
  }

  applyUserAgent(webContents) {
    const ua = resolveUserAgent(this.ctx.config);
    if (!ua) return; // 'default' 模式：保持 Electron 原生 UA
    try {
      webContents.setUserAgent(ua);
    } catch (err) {
      log.warn(`覆盖 UA 失败: ${err.message}`);
    }
  }

  activateTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    for (const t of this.tabs) {
      t.active = t.id === tabId;
      setViewVisible(t.view, t.active);
    }
    this.activeTabId = tabId;
    this.layout();
    this.syncTabs();
  }

  closeTab(tabId) {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const [tab] = this.tabs.splice(idx, 1);
    // 记一下，Ctrl+Shift+T 能把它找回来
    if (!this._closedStack) this._closedStack = [];
    if (tab.url && isHttpUrl(tab.url)) {
      this._closedStack.push(tab.url);
      if (this._closedStack.length > 10) this._closedStack.shift();
    }
    try {
      if (!tab.view.webContents.isDestroyed()) {
        this.win.contentView.removeChildView(tab.view);
        tab.view.webContents.close();
      }
    } catch (err) {
      log.warn(`关闭 Tab 出错(忽略): ${err.message}`);
    }
    if (this.activeTabId === tabId) {
      const next = this.tabs[idx] || this.tabs[idx - 1];
      if (next) this.activateTab(next.id);
      else {
        this.activeTabId = null;
        if (this.tabs.length === 0) {
          if (this.ctx.config.get('hideToTrayOnClose')) this.win.hide();
          else this.win.close();
          return;
        }
      }
    }
    this.layout();
    this.syncTabs();
  }

  getActiveTab() {
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  }

  cycleTab(delta) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const next = (i + delta + this.tabs.length) % this.tabs.length;
    this.activateTab(this.tabs[next].id);
  }

  /* ------------------------------ 站点页事件 ------------------------------ */

  bindSiteEvents(tab) {
    const wc = tab.view.webContents;
    const cfg = this.ctx.config;

    wc.on('page-title-updated', (event, title) => {
      if (tab.failed) return;
      const siteName = this.ctx.config.get('site').name || 'AI';
      // 站点标题通常是「会话名 - 站点名」，把后缀去掉只留会话名
      const cleaned = String(title || '')
        .replace(/^\s*[-–|]\s*/, '')
        .replace(/\s*[-–|]\s*[^-–|]{0,24}$/, '')
        .trim();
      tab.title = cleaned || siteName;
      this.syncTabs();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.syncTabs();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.syncTabs();
    });

    const onNavigated = (_e, url) => {
      if (isHttpUrl(url)) tab.url = url;
      this.syncTabs();
    };
    wc.on('did-navigate', onNavigated);
    wc.on('did-navigate-in-page', onNavigated);

    // 注入层：每次导航后重放（insertCSS 是按 document 生效的）
    wc.on('did-finish-load', () => {
      try {
        injection.applyTo(wc, cfg);
      } catch (err) {
        log.warn(`注入失败(不影响使用): ${err.message}`);
      }
      this.syncTabs();
    });

    // ★ 外链一定要拦，否则站内点个链接就弹出没有地址栏的裸窗口
    wc.setWindowOpenHandler(({ url }) => {
      if (isInternalUrl(url)) {
        this.createTab(url, { activate: true });
      } else if (isHttpUrl(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      if (isInternalUrl(url) || url.startsWith('file:')) return;
      event.preventDefault();
      if (isHttpUrl(url)) shell.openExternal(url).catch(() => {});
      else log.info(`已拦截非 http(s) 跳转: ${url}`);
    });

    wc.on('context-menu', (_event, params) => this.showContextMenu(tab, params));

    wc.on('before-input-event', (event, input) => this.handleKey(event, input, tab));

    wc.on('did-fail-load', (_event, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = 用户主动中止
      log.warn(`页面加载失败 ${code} ${desc} ${failedUrl}`);
      tab.failed = true;
      tab.failedUrl = failedUrl || tab.url;
      tab.title = '加载失败';
      wc.loadFile(path.join(PATHS.renderer, 'error.html'), {
        query: { url: tab.failedUrl, code: String(code), desc: String(desc) },
      }).catch(() => {});
      this.syncTabs();
    });

    wc.on('render-process-gone', (_event, details) => {
      log.error(`渲染进程异常退出: ${details.reason}`);
      tab.title = '页面已崩溃';
      this.syncTabs();
    });

    // preload 就绪后会主动要一次配置，避免「push 早于监听」的竞态
    wc.on('ipc-message', (_event, channel) => {
      if (channel === 'cs:ready') injection.replay(wc, cfg);
    });

    wc.on('zoom-changed', () => {
      this.setZoom(wc.getZoomFactor());
    });
  }

  /* ---------------------------- 站内快捷键 ---------------------------- */

  handleKey(event, input, tab) {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();

    const stop = (fn) => {
      event.preventDefault();
      fn();
    };

    // 注意：这里只处理带修饰键的组合，绝不碰裸 Enter，
    // 中文输入法组字状态下的 Enter 由站点自己处理（preload 里也有 isComposing 保护）
    if (mod && !input.shift && key === 't') return stop(() => this.createTab(null, { activate: true }));
    if (mod && !input.shift && key === 'w') return stop(() => this.closeTab(tab.id));
    if (mod && input.shift && key === 't') return stop(() => this.reopenLastClosed());
    if (mod && key === 'tab') return stop(() => this.cycleTab(input.shift ? -1 : 1));
    if (mod && !input.shift && key === 'r') return stop(() => tab.view.webContents.reload());
    if (mod && input.shift && key === 'r') return stop(() => tab.view.webContents.reloadIgnoringCache());
    if (mod && input.shift && key === 'i') return stop(() => tab.view.webContents.toggleDevTools());
    if (key === 'f5') return stop(() => tab.view.webContents.reload());
    if (key === 'f12') return stop(() => tab.view.webContents.toggleDevTools());
    if (mod && input.shift && key === 'n') {
      return stop(() => this.manager.create()); // 新窗口，同一 partition 共享登录态
    }
    if (key === 'escape') {
      return stop(() => tab.view.webContents.stop());
    }
  }

  reopenLastClosed() {
    if (!this._closedStack) this._closedStack = [];
    const url = this._closedStack.pop();
    this.createTab(url || null, { activate: true });
  }

  /* ---------------------------- 右键菜单 ---------------------------- */

  showContextMenu(tab, params) {
    const wc = tab.view.webContents;
    const template = [];

    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' }
      );
    } else if (params.selectionText) {
      template.push(
        { role: 'copy', label: '复制' },
        {
          label: '复制为纯文本',
          click: () => {
            const text = wc.getSelectedText();
            if (text) require('electron').clipboard.writeText(text);
          },
        },
        { type: 'separator' }
      );
    }

    template.push(
      {
        label: '新建会话',
        click: () => this.createTab(null, { activate: true }),
      },
      {
        label: '复制页面地址',
        click: () => require('electron').clipboard.writeText(tab.url || ''),
      },
      { type: 'separator' },
      {
        label: '复制最新回复为 Markdown',
        click: () => this.sendToTab(tab, 'cs:copy-latest-markdown'),
      },
      { type: 'separator' },
      { label: '后退', enabled: history(wc).canGoBack(), click: () => history(wc).goBack() },
      { label: '前进', enabled: history(wc).canGoForward(), click: () => history(wc).goForward() },
      { label: '刷新', click: () => wc.reload() },
      { type: 'separator' },
      {
        label: '选择器自检（站点改版后用这个）',
        click: () => this.manager.diagnoseActive(this),
      },
      { label: '开发者工具', click: () => wc.toggleDevTools() }
    );

    try {
      Menu.buildFromTemplate(template).popup({ window: this.win });
    } catch (_) {
      Menu.buildFromTemplate(template).popup();
    }
  }

  /* ---------------------------- 布局 ---------------------------- */

  layout() {
    if (!this.win || this.win.isDestroyed()) return;
    let width = 0;
    let height = 0;
    try {
      const b = this.win.getContentBounds();
      width = Math.max(0, Math.round(b.width));
      height = Math.max(0, Math.round(b.height));
    } catch (_) {
      return;
    }

    try {
      if (this.chromeView && !this.chromeView.webContents.isDestroyed()) {
        this.chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });
      }
    } catch (_) {
      /* ignore */
    }

    const siteHeight = Math.max(0, height - CHROME_HEIGHT);
    for (const tab of this.tabs) {
      try {
        if (tab.view.webContents.isDestroyed()) continue;
        if (tab.active) tab.view.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: siteHeight });
      } catch (_) {
        /* ignore */
      }
    }
  }

  bindWindowEvents() {
    this.win.on('resize', () => {
      this.layout();
      // 创建/首次显示期间的 resize 是程序行为，落盘只会把 OS 舍入误差固化，
      // 所以等窗口「站稳」之后再开始记录几何变化（见 markGeometryReady）
      if (this.geometryReady) this._saveState();
    });
    this.win.on('move', () => {
      if (this.geometryReady) this._saveState();
    });
    this.win.on('maximize', () => {
      this.layout();
      this.syncWindow();
    });
    this.win.on('unmaximize', () => {
      this.layout();
      this.syncWindow();
    });
    this.win.on('focus', () => {
      this.manager.lastFocused = this;
      this.syncWindow();
    });
    this.win.on('blur', () => this.syncWindow());

    this.win.on('close', (event) => {
      if (this.ctx.quitting || this.quittingSelf) return;
      if (this.ctx.config.get('hideToTrayOnClose')) {
        event.preventDefault();
        this.win.hide();
      }
    });

    this.win.on('closed', () => {
      this.manager.forget(this);
    });
  }

  /**
   * 尺寸按当前档位分开记：紧凑档和展开档互不覆盖，来回切换不会丢尺寸。
   *
   * ★ 这里有个必须绕开的坑：分数 DPI 缩放（比如 175%）下，`getBounds()` 返回的
   *   尺寸会比请求值大 1~3px（实测请求 480×700 → 读到 482×703）。如果把这个
   *   被舍入的值存进配置，下次启动又拿它去建窗口，就会再被撑大一点点 ——
   *   几次启动下来窗口就肉眼可见地变大了（棘轮效应）。
   *
   *   所以：只有当「实测值」和「我们请求的值」差得够远时，才认为用户真的手动
   *   缩放过窗口，此时才落盘；否则一律落盘「请求值」，让尺寸保持稳定。
   */
  persistBounds() {
    try {
      // 自检会合成拖拽/切档位来验证功能，那些几何变化不该写进用户配置
      if (this.suppressPersist) return;
      if (this.win.isDestroyed() || this.win.isMinimized()) return;
      const compact = this.ctx.config.get('window').compact !== false;
      const maximized = this.win.isMaximized();
      if (!maximized) this.lastNormalBounds = { ...this.win.getBounds() };
      const b = maximized && this.lastNormalBounds ? this.lastNormalBounds : this.win.getBounds();

      const req = this.requestedSize;
      let width = b.width;
      let height = b.height;
      const withinTolerance =
        req &&
        Math.abs(b.width - req.width) <= SIZE_TOLERANCE &&
        Math.abs(b.height - req.height) <= SIZE_TOLERANCE;
      if (withinTolerance) {
        // 只是 OS 的舍入误差，存请求值，别把误差固化下来
        width = req.width;
        height = req.height;
      } else {
        // 用户真的缩放过，以实测值为准
        this.requestedSize = { width, height };
      }

      const patch = { window: { x: b.x, y: b.y, maximized } };
      patch.window[compact ? 'compactSize' : 'expandedSize'] = { width, height };
      this.ctx.config.patch(patch);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * 窗口「站稳」之后才开始记录几何变化。
   * 创建和首次 show 期间 Windows 会发若干次 resize/move（含 DPI 舍入），
   * 那时落盘会把舍入误差固化成新的「默认尺寸」，导致每次启动窗口都变大一点。
   */
  markGeometryReady() {
    this.geometryReady = true;
    this.requestedSize = this.requestedSize || this.currentSize();
  }

  /* ---------------------------- 与标题栏通信 ---------------------------- */

  sendToChrome(channel, payload) {
    try {
      if (this.chromeView && !this.chromeView.webContents.isDestroyed()) {
        this.chromeView.webContents.send(channel, payload);
      }
    } catch (_) {
      /* ignore */
    }
  }

  sendToTab(tab, channel, payload) {
    try {
      const wc = tab.view.webContents;
      if (!wc.isDestroyed()) wc.send(channel, payload);
    } catch (_) {
      /* ignore */
    }
  }

  tabSnapshot() {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.title || this.ctx.config.get('site').name || 'AI',
      url: t.url,
      active: t.active,
      loading: !!t.loading,
      failed: !!t.failed,
      canGoBack: history(t.view.webContents).canGoBack(),
      canGoForward: history(t.view.webContents).canGoForward(),
    }));
  }

  syncTabs() {
    this.sendToChrome('chrome:tabs', { tabs: this.tabSnapshot(), windowId: this.index });
  }

  syncWindow() {
    let maximized = false;
    let focused = false;
    let alwaysOnTop = false;
    try {
      maximized = this.win.isMaximized();
      focused = this.win.isFocused();
      alwaysOnTop = this.win.isAlwaysOnTop();
    } catch (_) {
      /* ignore */
    }
    this.sendToChrome('chrome:window-state', {
      maximized,
      focused,
      alwaysOnTop,
      compact: this.ctx.config.get('window').compact !== false,
      windowId: this.index,
      zoomFactor: Number(this.ctx.config.get('zoomFactor')) || 1,
      theme: this.ctx.theme(),
    });
  }

  refreshInjection() {
    for (const tab of this.tabs) {
      try {
        injection.applyTo(tab.view.webContents, this.ctx.config);
      } catch (_) {
        /* ignore */
      }
    }
  }

  applyZoom(factor) {
    const f = Math.min(3, Math.max(0.5, Number(factor) || 1));
    this.ctx.config.set('zoomFactor', f);
    for (const tab of this.tabs) {
      try {
        tab.view.webContents.setZoomFactor(f);
      } catch (_) {
        /* ignore */
      }
    }
    this.syncWindow();
    return f;
  }

  /* ---------------------------- 窗口动作 ---------------------------- */

  show() {
    try {
      if (this.win.isMinimized()) this.win.restore();
      // 热键唤出必须是「小窗口」：如果之前被最大化了，先还原回紧凑尺寸
      if (this.ctx.config.get('window').compact !== false && this.win.isMaximized()) {
        this.win.unmaximize();
      }
      this.win.show();
      this.win.focus();
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * 紧凑 ⇄ 展开。
   * 两档尺寸分别记在 window.compactSize / window.expandedSize，来回切不丢尺寸。
   * 展开时如果会被屏幕右边切掉，位置会被向内收；所以收起时会还原展开前的坐标，
   * 否则反复切换会让窗口一路往左漂。
   */
  toggleCompact() {
    const cfg = this.ctx.config;
    const fromCompact = cfg.get('window').compact !== false;
    const next = !fromCompact;

    // 1) 先把当前尺寸存进「当前档」（用请求值口径，见 persistBounds 的说明）
    this.persistBounds();
    if (this.win.isMaximized()) this.win.unmaximize();

    const cur = this.win.getBounds();
    if (fromCompact) {
      // 紧凑 → 展开：记住紧凑形态的坐标，稍后收起时还原
      this.preExpandPosition = { x: cur.x, y: cur.y };
    }

    // 2) 先更新档位，后面 resize 触发 persistBounds 时才会写进正确的档
    cfg.set('window', { ...cfg.get('window'), compact: next });

    const target = this.currentSize();
    let x = cur.x;
    let y = cur.y;
    if (!next && this.preExpandPosition) {
      // 展开 → 紧凑：回到展开前的原位，避免漂移
      x = this.preExpandPosition.x;
      y = this.preExpandPosition.y;
    }

    try {
      const area = screen.getDisplayNearestPoint({ x, y }).workArea;
      const width = Math.min(target.width, area.width);
      const height = Math.min(target.height, area.height);
      x = Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width));
      y = Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height));
      this.requestedSize = { width, height };
      this.win.setBounds({ x, y, width, height });
    } catch (err) {
      log.warn(`切换窗口尺寸失败: ${err.message}`);
    }

    this.layout();
    this.syncWindow();
    if (this.ctx.palette) this.ctx.palette.close(); // 调色板位置跟着变，先收起
    if (this.ctx.tray) this.ctx.tray.rebuild();
    log.info(`窗口切换为${next ? '紧凑' : '展开'}模式: ${target.width}×${target.height} @ (${x}, ${y})`);
    return next;
  }

  hide() {
    try {
      this.win.hide();
    } catch (_) {
      /* ignore */
    }
  }

  toggleVisible() {
    let visible = false;
    let focused = false;
    try {
      visible = this.win.isVisible();
      focused = this.win.isFocused();
    } catch (_) {
      /* ignore */
    }
    if (visible && focused) this.hide();
    else this.show();
  }

  toggleAlwaysOnTop() {
    const next = !this.win.isAlwaysOnTop();
    this.win.setAlwaysOnTop(next, 'floating');
    this.ctx.config.set('alwaysOnTop', next);
    this.syncWindow();
    return next;
  }

  navigateInActive(action) {
    const tab = this.getActiveTab();
    if (!tab) return;
    const wc = tab.view.webContents;
    const h = history(wc);
    try {
      if (action === 'back' && h.canGoBack()) h.goBack();
      if (action === 'forward' && h.canGoForward()) h.goForward();
      if (action === 'reload') wc.reload();
      if (action === 'home') wc.loadURL(this.ctx.config.get('site').home);
    } catch (_) {
      /* ignore */
    }
  }

  destroy() {
    this.quittingSelf = true;
    try {
      this.persistBounds();
    } catch (_) {
      /* ignore */
    }
    for (const tab of [...this.tabs]) {
      try {
        this.win.contentView.removeChildView(tab.view);
        tab.view.webContents.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.tabs = [];
    try {
      this.win.destroy();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ========================================================================== */
/*                            窗口管理器                                       */
/* ========================================================================== */

class WindowManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.windows = [];
    this.lastFocused = null;
    this.seq = 0;
  }

  create() {
    const win = new AppWindow(this, ++this.seq);
    this.windows.push(win);
    this.lastFocused = win;

    if (!this.ctx.config.get('startMinimized')) win.show();
    else win.hide();

    // 等窗口站稳再开始记录几何变化（见 markGeometryReady 的说明）
    setTimeout(() => {
      if (win.win && !win.win.isDestroyed()) win.markGeometryReady();
    }, 900);

    // 首次启动时把注入配置的「偏好」应用到新窗口（登录态验证模式打完日志再说）
    if (this.ctx.isVerify) {
      log.verify(`窗口已创建，partition=${this.ctx.config.get('site').partition}`);
    }
    return win;
  }

  forget(win) {
    this.windows = this.windows.filter((w) => w !== win);
    if (this.lastFocused === win) this.lastFocused = this.windows[this.windows.length - 1] || null;
  }

  count() {
    return this.windows.length;
  }

  /** 由标题栏 webContents 反查窗口（拖拽、窗口动作等 IPC 需要） */
  findByWebContents(wc) {
    return this.windows.find((w) => w.chromeView && !w.chromeView.webContents.isDestroyed() && w.chromeView.webContents === wc) || null;
  }

  all() {
    return this.windows.slice();
  }

  allTabs() {
    const out = [];
    for (const w of this.windows) {
      for (const t of w.tabs) out.push({ ...t, active: t.active, win: w });
    }
    return out;
  }

  /** 当前应该被操作的窗口：优先最后聚焦的，其次最后一个 */
  target() {
    const win = this.windows.find((w) => w === this.lastFocused) || this.windows[this.windows.length - 1] || null;
    return win;
  }

  focusLast() {
    const win = this.target();
    if (win) win.show();
    else this.create();
  }

  toggleVisible() {
    const win = this.target();
    if (win) win.toggleVisible();
    else this.create();
  }

  /** 把一段文本送进当前会话输入框（Prompt 库、托盘快捷片段都走这里） */
  sendPrompt(text, { submit = true } = {}) {
    const win = this.target();
    if (!win) return false;
    let tab = win.getActiveTab();
    if (!tab) {
      tab = win.createTab(null, { activate: true });
    }
    win.show();
    win.sendToTab(tab, 'cs:prompt', { text, submit });
    return true;
  }

  setZoomOnAll(factor) {
    for (const w of this.windows) w.applyZoom(factor);
  }

  async diagnoseActive(win) {
    const target = win || this.target();
    if (!target) return null;
    const tab = target.getActiveTab();
    if (!tab) return null;
    const report = await injection.diagnose(tab.view.webContents);
    const total = Object.keys(report.groups || {}).length;
    const ok = Object.values(report.groups || {}).filter((g) => g.matched).length;
    log.info(`选择器自检: ${ok}/${total} 组命中`);
    return report;
  }

  quit() {
    this.ctx.quitting = true;
    for (const w of [...this.windows]) w.destroy();
    app.quit();
  }
}

module.exports = { WindowManager, AppWindow, isInternalUrl, CHROME_HEIGHT };
