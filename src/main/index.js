'use strict';

const { app, Menu, nativeTheme, dialog, session } = require('electron');

// ---------------------------------------------------------------------------
// 红线 2：不触发风控。
// 移除可能让 navigator.webdriver === true 的自动化开关；
// 全程不追加 --enable-automation、不改 UA、不注入 navigator.webdriver。
// ---------------------------------------------------------------------------
app.commandLine.removeSwitch('enable-automation');

const { BRAND, ensureUserData } = require('./branding');

// ★ 必须在 require('./paths') 之前跑：paths.js 在模块加载时就会去读 userData 路径，
//   而「改名后把老目录搬过来」这件事必须在那之前完成，否则登录态会指向一个空目录。
const userDataInfo = ensureUserData(app);

const { PATHS } = require('./paths');
const { configDefaults, promptDefaults } = require('./defaults');
const { JsonStore } = require('./store');
const { migrate } = require('./config-migrate');
const { log } = require('./log');
const { WindowManager } = require('./window-manager');
const { TrayController } = require('./tray');
const { ShortcutManager } = require('./shortcuts');
const { PaletteWindow } = require('./palette');
const { QuickAskWindow } = require('./quickask');
const { registerIpc } = require('./ipc');
const injection = require('./injection');
const verify = require('./verify');
const uaPolicy = require('./useragent');

const argv = process.argv.slice(1);
const isDev = argv.includes('--dev');
const isVerify = argv.includes('--verify-login');
const isSelfCheck = argv.includes('--self-check');
const isAskTest = argv.includes('--test-quickask');
// 深度探测：打开一个历史会话并 dump 回复的 DOM 结构（调站点解析逻辑时用）
const isChatProbe = argv.includes('--probe-chat');
const startHidden = argv.includes('--hidden'); // 开机自启时静默进托盘
const proxyFlag = (argv.find((a) => a.startsWith('--proxy=')) || '').slice('--proxy='.length).trim();
const uaModeFlag = (argv.find((a) => a.startsWith('--user-agent-mode=')) || '').slice('--user-agent-mode='.length).trim();

if (!app.requestSingleInstanceLock()) {
  // 单实例锁：第二次双击图标不是再开一个进程，而是把已有窗口拉出来
  if (isSelfCheck || isChatProbe) {
    // 诊断命令被已有实例吞掉是最令人困惑的情况（明明跑了却什么都没输出），
    // 所以这里明确报错并给不同退出码，而不是静默变成「把窗口拉出来」。
    log.warn('诊断命令被取消：已有一个实例在运行。请先从托盘菜单退出，或直接用托盘里的「选择器自检」。');
    process.exitCode = 2;
  }
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  const ctx = {
    isDev,
    isVerify,
    isSelfCheck,
    isChatProbe,
    proxyOverride: proxyFlag,
    quitting: false,
    config: null,
    prompts: null,
    windows: null,
    tray: null,
    shortcuts: null,
    palette: null,
    quickAsk: null,

    theme() {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    },

    state() {
      return {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        theme: this.theme(),
        configPath: PATHS.configFile,
        userData: PATHS.userData,
        partition: this.config.get('site').partition,
        hotkey: this.shortcuts ? this.shortcuts.activeAccelerator : null,
        injection: this.config.get('injection'),
      };
    },

    openPalette() {
      if (!this.palette) this.palette = new PaletteWindow(this);
      this.palette.toggle();
    },

    closePalette() {
      if (this.palette) this.palette.close();
    },

    openQuickAsk() {
      if (!this.quickAsk) this.quickAsk = new QuickAskWindow(this);
      this.quickAsk.toggle();
    },

    closeQuickAsk() {
      if (this.quickAsk) this.quickAsk.close();
    },

    replayInjection(webContents) {
      injection.replay(webContents, this.config);
    },

    async diagnose() {
      const report = await this.windows.diagnoseActive();
      if (!report) {
        dialog.showMessageBox({ type: 'warning', message: '没有可自检的页面', detail: '先打开一个会话再试。' });
        return null;
      }
      const groups = report.groups || {};
      const rows = Object.entries(groups).map(([name, g]) => {
        const hits = (g.rows || []).filter((r) => r.count > 0);
        return `${hits.length ? '✅' : '❌'} ${name}  ${hits.map((h) => `${h.selector}×${h.count}`).join(', ') || '全部未命中'}`;
      });
      const ok = Object.values(groups).filter((g) => g.matched).length;
      const detail = [
        `命中 ${ok}/${Object.keys(groups).length} 组选择器`,
        `navigator.webdriver = ${report.webdriver}（应为 false）`,
        '',
        ...rows,
        '',
        `完整报告：${PATHS.selectorReport}`,
      ].join('\n');
      log.info(detail);
      dialog.showMessageBox({ type: ok ? 'info' : 'warning', title: '选择器自检', message: '站点改造层自检结果', detail, buttons: ['好'] });
      return report;
    },

    async verifyLoginNow() {
      const info = await verify.runLoginVerification(this, 'manual');
      const detail = [
        `partition: ${info.partition}`,
        `cookie 总数: ${info.cookieTotal ?? 'n/a'}，deepseek 域: ${info.cookieDeepseek ?? 'n/a'}`,
        `疑似登录凭证: ${(info.suspectAuthCookies || []).join(', ') || '（无）'}`,
        `存储目录: ${info.storagePath}`,
        `localStorage: ${JSON.stringify(info.localStorage || {})}`,
        info.fatal ? `\n❌ ${info.fatal}` : '',
      ].join('\n');
      dialog.showMessageBox({
        type: info.fatal ? 'error' : 'info',
        title: '登录态验证',
        message: '登录态持久化检查',
        detail,
        buttons: ['好'],
      });
      return info;
    },
  };

  app.on('second-instance', () => {
    log.info('检测到第二次启动，把已有窗口拉出来');
    ctx.windows.focusLast();
  });

  app.on('before-quit', async (event) => {
    ctx.quitting = true;
    if (isVerify && !ctx._verifiedOnQuit) {
      ctx._verifiedOnQuit = true;
      event.preventDefault();
      await verify.runLoginVerification(ctx, 'quit').catch(() => {});
      ctx.windows.quit();
    }
  });

  app.on('window-all-closed', () => {
    // 托盘常驻模式下即使窗口没了也不退，热键还能把窗口唤回来
    if (process.platform !== 'darwin' && !(ctx.tray && ctx.tray.keepAlive)) app.quit();
  });

  app.on('activate', () => {
    if (ctx.windows && ctx.windows.count() === 0) ctx.windows.create();
  });

  app.on('will-quit', () => {
    if (ctx.shortcuts) ctx.shortcuts.dispose();
    if (ctx.palette) ctx.palette.destroy();
    if (ctx.quickAsk) ctx.quickAsk.destroy();
    if (ctx.tray) ctx.tray.destroy();
  });

  app.whenReady().then(async () => {
    ctx.config = new JsonStore(PATHS.configFile, configDefaults);
    ctx.prompts = new JsonStore(PATHS.promptsFile, promptDefaults);

    // 配置迁移必须在读取任何配置项之前跑完
    migrate(ctx.config);

    // 命令行临时覆盖 UA 模式，方便 A/B 对比（不写回配置文件）
    if (uaModeFlag === 'chrome' || uaModeFlag === 'default') {
      ctx.config.set('userAgentMode', uaModeFlag);
      log.info(`UA 模式被命令行覆盖为: ${uaModeFlag}`);
    }

    Menu.setApplicationMenu(null); // 无边框 + 自定义标题栏，原生菜单栏是多余的
    nativeTheme.themeSource = ctx.config.get('theme') || 'system';
    nativeTheme.on('updated', () => {
      for (const w of ctx.windows.all()) w.syncWindow();
    });

    await setupPartition(ctx);
    injection.init();
    log.info(`${BRAND.name} ${app.getVersion()} 启动 (electron ${process.versions.electron}, chromium ${process.versions.chrome})`);
    log.info(`数据目录: ${PATHS.userData}`);
    if (userDataInfo.migratedFrom) {
      log.info(`已把数据目录从「${userDataInfo.migratedFrom}」迁移到「${BRAND.name}」（登录态一并带过来了）`);
      log.info(`旧目录仍保留在 %APPDATA%/${userDataInfo.migratedFrom}，确认没问题后可以自行删除`);
    } else if (userDataInfo.error) {
      log.warn(`数据目录准备异常: ${userDataInfo.error}`);
    }

    ctx.windows = new WindowManager(ctx);
    registerIpc(ctx);

    const first = ctx.windows.create();
    if (startHidden || ctx.config.get('startMinimized')) first.hide();

    ctx.tray = new TrayController(ctx);
    ctx.tray.init();

    ctx.shortcuts = new ShortcutManager(ctx);
    ctx.shortcuts.init();

    if (isVerify) {
      verify.runLoginVerification(ctx, 'boot').then(() => {
        log.verify('提示：现在在弹出的窗口里完成登录，然后完全退出（托盘 → 退出），');
        log.verify('      再运行一次 npm run verify:login。cookie 数 > 0 就说明登录态留住了。');
      });
    }

    if (isSelfCheck) {
      require('./selfcheck').run(ctx);
    }

    if (isAskTest) {
      require('./selfcheck').runAskTest(ctx);
    }

    if (isChatProbe) {
      require('./selfcheck').runChatProbe(ctx);
    }

    // 防止误伤：任何 webview 标签都直接拒绝（我们用的是 WebContentsView，不需要它）
    app.on('web-contents-created', (_e, contents) => {
      contents.on('will-attach-webview', (event) => {
        event.preventDefault();
        log.warn('已阻止一次 webview 挂载');
      });
    });
  });
}

/**
 * partition 相关的一次性设置。
 *
 * ★ 这里刻意「什么都不清理」：
 *   - 不调 session.clearStorageData()
 *   - 不调 cookies.remove()
 *   - 不开无痕式逻辑
 *   这三件事任意一件都会让用户每次启动都要重新登录。
 */
async function setupPartition(ctx) {
  const partition = ctx.config.get('site').partition;
  if (!String(partition).startsWith('persist:')) {
    log.error(`partition "${partition}" 不是 persist: 前缀 —— 登录态不会落盘，请立刻改回 persist:deepseek`);
  }
  try {
    const ses = session.fromPartition(partition);
    const allowed = new Set([
      'clipboard-read',
      'clipboard-sanitized-write',
      'media',
      'notifications',
      'fullscreen',
      'pointerLock',
      'display-capture',
    ]);
    // 默认拒绝，只放行站点正常功能需要的几项（麦克风语音输入、剪贴板等）
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowed.has(permission));
    });

    // 代理：Chromium 默认不认 http_proxy 环境变量，公司网络下会莫名其妙加载失败
    const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY;
    const proxy = ctx.proxyOverride || String(ctx.config.get('proxy') || '').trim() || fromEnv;
    if (proxy) {
      const source = ctx.proxyOverride ? '命令行' : String(ctx.config.get('proxy') || '').trim() ? 'config.json' : '环境变量';
      await ses.setProxy({ proxyRules: proxy });
      log.info(`已应用代理(${source}): ${proxy}`);
    }

    // ★ UA：必须在创建任何窗口之前设置，否则第一次导航已经带着 Electron UA 出去了
    const ua = uaPolicy.applyGlobally(ctx.config, ses);
    const uaInfo = uaPolicy.describe(ctx.config);
    if (ua) {
      log.info(`UA 模式: ${uaInfo.mode}`);
      log.info(`生效 UA : ${ua}`);
      if (/Electron\/|DeepSeekDesktop\//i.test(ua)) {
        log.warn('生效 UA 里仍然带着 Electron/应用名 token，可能会被边缘节点判定为非标准浏览器');
      }
    } else {
      log.warn(`UA 模式: default —— 保留 Electron 原生 UA(${uaPolicy.resolveUserAgent ? '未修改' : ''})，DeepSeek 可能返回 429 拦截页`);
    }

    let storagePath = 'n/a';
    try {
      storagePath = typeof ses.getStoragePath === 'function' ? ses.getStoragePath() : 'n/a';
    } catch (_) {
      /* ignore */
    }
    log.info(`session 就绪: ${partition} → ${storagePath}`);
  } catch (err) {
    log.error(`session 初始化失败: ${err.message}`);
  }
}
