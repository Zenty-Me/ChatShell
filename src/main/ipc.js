'use strict';

const { ipcMain, shell, clipboard, app } = require('electron');
const { log } = require('./log');

/**
 * 所有 IPC 通道的唯一入口。
 * 命名约定：chrome:* 来自自定义标题栏；palette:* 来自 Prompt 调色板；cs:* 来自站点页 preload。
 * （cs = ChatShell 自己注入的前缀，刻意不用 ds-，避免和站点的 ds-button 等类名撞概念）
 */
function registerIpc(ctx) {
  const on = (channel, handler) => {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return await handler(event, payload);
      } catch (err) {
        log.warn(`IPC ${channel} 失败: ${err.message}`);
        return null;
      }
    });
  };

  /* ------------------------------ 标题栏 ------------------------------ */

  on('chrome:window', (_e, payload = {}) => {
    const win = ctx.windows.target();
    if (!win) return null;
    switch (payload.action) {
      case 'minimize':
        win.win.minimize();
        break;
      case 'toggle-maximize':
        if (win.win.isMaximized()) win.win.unmaximize();
        else win.win.maximize();
        break;
      case 'toggle-compact':
        return win.toggleCompact();
      case 'close':
        win.win.close();
        break;
      case 'toggle-pin':
        return win.toggleAlwaysOnTop();
      default:
        break;
    }
    return true;
  });

  on('chrome:tab', (_e, payload = {}) => {
    const win = ctx.windows.target();
    if (!win) return null;
    switch (payload.action) {
      case 'new':
        win.createTab(null, { activate: true });
        win.show();
        break;
      case 'close':
        win.closeTab(payload.id);
        break;
      case 'activate':
        win.activateTab(payload.id);
        break;
      case 'reload':
        win.navigateInActive('reload');
        break;
      case 'back':
        win.navigateInActive('back');
        break;
      case 'forward':
        win.navigateInActive('forward');
        break;
      case 'home':
        win.navigateInActive('home');
        break;
      case 'new-window':
        ctx.windows.create();
        break;
      default:
        break;
    }
    return true;
  });

  on('chrome:zoom', (_e, payload = {}) => {
    const win = ctx.windows.target();
    if (!win) return null;
    const current = Number(ctx.config.get('zoomFactor')) || 1;
    let next = current;
    if (payload.reset) next = 1;
    else next = current + (Number(payload.delta) || 0);
    return win.applyZoom(next);
  });

  on('chrome:palette', () => {
    ctx.openPalette();
    return true;
  });

  on('chrome:diagnose', async () => {
    const report = await ctx.diagnose();
    return report ? summarize(report) : null;
  });

  on('chrome:state', () => ctx.state());

  /* ---------------------------- Prompt 调色板 ---------------------------- */

  on('palette:list', (_e, query = '') => {
    const items = ctx.prompts.get('items', []) || [];
    const q = String(query || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) =>
        String(p.title || '').toLowerCase().includes(q) || String(p.text || '').toLowerCase().includes(q)
    );
  });

  on('palette:save', (_e, item = {}) => {
    const items = [...(ctx.prompts.get('items', []) || [])];
    const idx = items.findIndex((p) => p.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.push({ ...item, id: item.id || `p-${Date.now().toString(36)}` });
    ctx.prompts.set('items', items);
    if (ctx.tray) ctx.tray.rebuild(); // 托盘里的 Prompt 子菜单同步刷新
    return items;
  });

  on('palette:delete', (_e, id) => {
    const items = (ctx.prompts.get('items', []) || []).filter((p) => p.id !== id);
    ctx.prompts.set('items', items);
    if (ctx.tray) ctx.tray.rebuild();
    return items;
  });

  on('palette:send', (_e, payload = {}) => {
    ctx.closePalette();
    const win = ctx.windows.target();
    if (win) win.show();
    return ctx.windows.sendPrompt(payload.text || '', { submit: payload.submit !== false });
  });

  on('palette:close', () => {
    ctx.closePalette();
    return true;
  });

  /* ------------------------------ 标题栏拖拽 ------------------------------ */
  //
  // 为什么不用 CSS 的 -webkit-app-region: drag：
  // 那套依赖 Electron 对 WebContentsView 的拖拽区支持，行为不好验证也不好测。
  // 这里改成显式接管：标题栏按下时记下「鼠标屏幕坐标 → 窗口左上角」的偏移，
  // 移动时用 屏幕坐标 - 偏移 反算窗口位置。用偏移而不是增量，避免逐帧误差累积。
  // 渲染层用 pointer capture，鼠标移出标题栏也不会断。

  let drag = null;

  ipcMain.on('chrome:drag-start', (event, payload = {}) => {
    const win = ctx.windows.findByWebContents(event.sender);
    if (!win || win.win.isDestroyed()) return;
    // 最大化状态下 Windows 不允许 setPosition，先还原
    if (win.win.isMaximized()) win.win.unmaximize();
    const b = win.win.getBounds();
    drag = {
      win,
      sender: event.sender,
      offsetX: Number(payload.screenX || 0) - b.x,
      offsetY: Number(payload.screenY || 0) - b.y,
    };
  });

  ipcMain.on('chrome:drag-move', (event, payload = {}) => {
    if (!drag || drag.sender !== event.sender) return;
    const { win } = drag;
    if (!win || win.win.isDestroyed()) return;
    const x = Math.round(Number(payload.screenX || 0) - drag.offsetX);
    const y = Math.round(Number(payload.screenY || 0) - drag.offsetY);
    try {
      win.win.setPosition(x, y);
    } catch (_) {
      /* 拖太快偶尔会被系统拒绝，忽略即可 */
    }
  });

  ipcMain.on('chrome:drag-end', (event) => {
    if (!drag || drag.sender !== event.sender) return;
    const { win } = drag;
    drag = null;
    if (win && !win.win.isDestroyed()) win.persistBounds(); // 拖完记住位置
  });

  /* ---------------------------- 快捷问答面板 ---------------------------- */

  ipcMain.on('quickask:ask', (_e, payload = {}) => {
    if (!ctx.quickAsk) ctx.openQuickAsk();
    if (ctx.quickAsk) ctx.quickAsk.ask(payload.text);
  });

  ipcMain.on('quickask:close', () => {
    if (ctx.quickAsk) ctx.quickAsk.close();
  });

  ipcMain.on('quickask:copy', () => {
    if (ctx.quickAsk) ctx.quickAsk.copyAnswer();
  });

  // 面板上的「展开」：关掉面板，把主窗口拉出来（会话本来就在历史里）
  ipcMain.on('quickask:open-full', () => {
    if (ctx.quickAsk) ctx.quickAsk.close();
    ctx.windows.focusLast();
  });

  // 面板上的「新会话」：清空面板的对话，并让站点页开一个新对话
  ipcMain.on('quickask:new-session', () => {
    if (ctx.quickAsk) ctx.quickAsk.newSession();
  });

  // 拖动面板。和标题栏同样的做法：渲染层用 pointer capture，鼠标移出面板也不会断。
  ipcMain.on('quickask:drag-start', (_e, payload = {}) => {
    if (ctx.quickAsk) ctx.quickAsk.beginDrag(payload.screenX, payload.screenY);
  });
  ipcMain.on('quickask:drag-move', (_e, payload = {}) => {
    if (ctx.quickAsk) ctx.quickAsk.dragMove(payload.screenX, payload.screenY);
  });
  ipcMain.on('quickask:drag-end', () => {
    if (ctx.quickAsk) ctx.quickAsk.endDrag();
  });

  /* ---------------------------- 站点页 preload ---------------------------- */

  // 诊断：注入层回报「用真实解析逻辑读到的最新一轮回复」（npm run probe:chat 用）
  ipcMain.on('cs:debug-result', (_e, payload = {}) => {
    ctx.lastDebugResult = payload;
    log.info(`[解析自检] ${JSON.stringify(payload)}`);
  });

  ipcMain.on('cs:log', (_e, msg) => log.info(`[site] ${msg}`));

  ipcMain.on('cs:clipboard', (_e, text) => {
    try {
      clipboard.writeText(String(text || ''));
    } catch (err) {
      log.warn(`写剪贴板失败: ${err.message}`);
    }
  });

  ipcMain.on('cs:open-external', (_e, url) => {
    if (/^https?:/i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
  });

  ipcMain.on('cs:open-devtools', (event) => {
    try {
      event.sender.toggleDevTools();
    } catch (_) {
      /* ignore */
    }
  });

  // 站点页的注入层就绪后会 send 一次，让主进程补推配置（避免 push 早于监听）
  ipcMain.on('cs:ready', (event) => {
    ctx.replayInjection(event.sender);
  });

  // 快捷问答：投递结果 / 最新回复，转给面板
  ipcMain.on('cs:prompt-result', (_e, info = {}) => {
    if (ctx.quickAsk) ctx.quickAsk.onPromptResult(info);
  });

  ipcMain.on('cs:answer', (_e, info = {}) => {
    if (ctx.quickAsk) ctx.quickAsk.onAnswer(info);
  });

  // 站点页检测到风控拦截页。记日志 + 托盘气泡提醒，避免用户以为是壳坏了
  ipcMain.on('cs:blocked', (_event, info = {}) => {
    ctx.latestBlock = { ...info, at: new Date().toISOString() };
    log.warn(
      `站点返回风控拦截页: ${info.reason} | 元素数 ${info.elementCount} | UA=${info.ua} | ${String(
        info.snippet || ''
      ).slice(0, 120)}`
    );
    if (/Electron\/|DeepSeekDesktop\//i.test(String(info.ua || ''))) {
      log.warn('提示：UA 里仍带着 Electron/应用名 token —— 这就是被判定为非标准浏览器的直接依据');
    }
    if (ctx.tray && ctx.tray.notify) {
      ctx.tray.notify('站点返回了风控拦截页', '不是桌面壳的问题。详情见托盘「打开日志」。');
    }
  });
}

function summarize(report) {
  const groups = report.groups || {};
  const rows = Object.entries(groups).map(([name, g]) => {
    const hits = (g.rows || []).filter((r) => r.count > 0).map((r) => `${r.selector}(${r.count})`);
    return { name, ok: g.matched, hits };
  });
  return {
    url: report.url,
    title: report.title,
    webdriver: report.webdriver,
    ok: rows.filter((r) => r.ok).length,
    total: rows.length,
    rows,
    file: require('./paths').PATHS.selectorReport,
  };
}

module.exports = { registerIpc };
