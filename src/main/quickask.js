'use strict';

const path = require('path');
const { BrowserWindow, screen, clipboard } = require('electron');
const { PATHS } = require('./paths');
const { log } = require('./log');
const injection = require('./injection');
const uaPolicy = require('./useragent');

const PANEL_WIDTH = 720;
const PANEL_HEIGHT = 480;
const WORKER_WIDTH = 900;
const WORKER_HEIGHT = 700;

function waitForLoad(webContents, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, 800);
    };
    try {
      if (!webContents.isLoading()) return finish();
      webContents.once('did-finish-load', finish);
      webContents.once('did-fail-load', finish);
    } catch (_) {
      return finish();
    }
    setTimeout(finish, timeoutMs);
  });
}

/**
 * 快捷问答面板（Cherry Studio 那种小助手）。
 *
 * 关键设计：**面板本身只是薄 UI，问题和答案仍然走已登录的站点页**。
 *   - 不引入 API key：复用网页版的登录态和额度
 *   - 读答案靠注入层读「渲染后的 DOM」，不碰网络层
 *   - 结果照常落在 DeepSeek 的会话历史里，不产生影子数据
 *
 * 数据流：
 *   面板输入 → 主进程 → 站点页 preload（填输入框 + 点发送）
 *   站点页 preload（盯着最新回复，文本停止变化即判定生成完毕）
 *     → 主进程 → 面板渲染
 */
class QuickAskWindow {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = null;
    this.worker = null;
    this._workerReady = null;
    this._reparkWorker = () => this.parkWorker();
    screen.on('display-added', this._reparkWorker);
    screen.on('display-removed', this._reparkWorker);
    screen.on('display-metrics-changed', this._reparkWorker);
    /**
     * 多轮对话状态。
     *
     * 面板开的那次会话一直保留到应用退出 —— 关掉面板再打开，之前的对话还在
     * （同一个会话有上下文记忆，而不是每次重置）。想重开就点面板上的「新会话」。
     */
    this.state = {
      phase: 'idle', // idle | sending | generating | done | error
      turns: [], // [{ q, a, reasoning, note }]
      note: '',
    };
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const dark = this.ctx.theme() === 'dark';

    this.win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      show: false,
      frame: false,
      transparent: true, // 圆角 + 投影靠 CSS，只能开透明
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      // ★ 关键：挂成主窗口的 owned window。
      // 面板和主窗口都是置顶窗口，位置又高度重叠（都在屏幕上方居中），
      // 不建立父子关系时 Windows 上「谁最后激活谁在上层」——结果就是
      // 用户点面板输入框，实际点到的是主窗口，主窗口抢走焦点，面板被 blur 关掉，
      // 表现出来就是「面板点不动」。owned window 永远绘制在 owner 之上，根除这个竞争。
      parent: this.ownerWindow() || undefined,
      webPreferences: {
        preload: path.join(PATHS.preload, 'quickask-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    // 面板渲染脚本的报错只在它自己的控制台里，转发到主日志 ——
    // 否则「面板点不动」这类问题查起来毫无线索。必须在 loadFile 之前挂上。
    this.win.webContents.on('console-message', (...args) => {
      try {
        const [first, second] = args;
        // Electron 44 是 (event, details)；老签名是 (event, level, message, line, source)
        const detail =
          second && typeof second === 'object' && 'message' in second
            ? second
            : first && typeof first === 'object' && 'message' in first
              ? first
              : null;
        if (!detail || !detail.message) return;
        if (detail.level === 3 || detail.level === 'error') {
          log.warn(`[面板控制台] ${detail.message} (line ${detail.lineNumber})`);
        }
      } catch (_) {
        /* ignore */
      }
    });

    this.win.loadFile(path.join(PATHS.renderer, 'quickask.html'), { query: { theme: dark ? 'dark' : 'light' } });
    // 失焦不立刻关：刚 show 出来的瞬间、系统弹窗、输入法候选框都会触发 blur，
    // 一关就等于「点不动」。延迟复查，确实不再持有焦点才收。
    this.win.on('blur', () => this.scheduleCloseOnBlur());
    this.win.on('closed', () => {
      this.win = null;
    });
    this.win.webContents.on('did-finish-load', () => {
      this.push();
      // 首次打开时，open() 里发的 quickask:reset 早于页面加载完成，会被丢掉 ——
      // 页面就绪后补一次，否则输入框拿不到焦点，「呼出即打字」就失效了。
      if (this.win && this.win.isVisible()) {
        try {
          this.win.webContents.send('quickask:reset');
        } catch (_) {
          /* ignore */
        }
      }
    });
    return this.win;
  }

  /** 主窗口的 BaseWindow —— 用作 parent，保证面板永远盖在主窗口之上 */
  ownerWindow() {
    try {
      const w = this.ctx.windows && this.ctx.windows.target();
      if (w && w.win && !w.win.isDestroyed()) return w.win;
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  scheduleCloseOnBlur() {
    clearTimeout(this._blurTimer);
    this._blurTimer = setTimeout(() => {
      try {
        if (this.win && !this.win.isDestroyed() && this.win.isVisible() && !this.win.isFocused()) {
          this.close();
        }
      } catch (_) {
        /* ignore */
      }
    }, 220);
  }

  /* ------------------------------ 拖动 ------------------------------ */

  beginDrag(screenX, screenY) {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      const b = this.win.getBounds();
      this._drag = {
        offsetX: Number(screenX || 0) - b.x,
        offsetY: Number(screenY || 0) - b.y,
        width: b.width,
        height: b.height,
      };
    } catch (_) {
      this._drag = null;
    }
  }

  dragMove(screenX, screenY) {
    if (!this._drag || !this.win || this.win.isDestroyed()) return;
    const x = Math.round(Number(screenX || 0) - this._drag.offsetX);
    const y = Math.round(Number(screenY || 0) - this._drag.offsetY);
    try {
      let width = this._drag.width;
      let height = this._drag.height;
      for (let i = 0; i < 3; i++) {
        this.win.setBounds({ x, y, width, height });
        const actual = this.win.getBounds();
        if (actual.width === this._drag.width && actual.height === this._drag.height) break;
        width += this._drag.width - actual.width;
        height += this._drag.height - actual.height;
      }
    } catch (_) {
      /* 拖太快偶尔会被系统拒绝，忽略即可 */
    }
  }

  endDrag() {
    this._drag = null;
  }

  /**
   * 定位：优先对齐主窗口的水平中心（视觉上像从主窗口弹出来的），
   * 垂直方向取屏幕中央偏上一点。
   *
   * 原来的算法和主窗口的「屏幕上方居中」几乎完全重合（实测重叠 67%），
   * 虽然现在有 parent 保证层级，但错开一点仍然更好用 —— 至少能同时看到主窗口。
   * 面板比主窗口宽，屏幕放不下时就向内收敛，绝不出屏。
   */
  position() {
    const clamp = (v, min, max) => Math.round(Math.min(Math.max(v, min), max));
    try {
      const pt = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(pt).workArea;
      const width = Math.min(PANEL_WIDTH, area.width - 32);
      const height = Math.min(PANEL_HEIGHT, area.height - 32);

      let centerX = area.x + area.width / 2;
      const owner = this.ownerBounds();
      if (owner) centerX = owner.x + owner.width / 2;

      return {
        x: clamp(centerX - width / 2, area.x, area.x + area.width - width),
        y: clamp(area.y + area.height * 0.32, area.y, area.y + area.height - height),
        width,
        height,
      };
    } catch (_) {
      return { width: PANEL_WIDTH, height: PANEL_HEIGHT };
    }
  }

  ownerBounds() {
    const owner = this.ownerWindow();
    try {
      return owner ? owner.getBounds() : null;
    } catch (_) {
      return null;
    }
  }

  toggle() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.close();
    else this.open();
  }

  open() {
    const win = this.ensure();
    // 主窗口可能被重建过，这里补一次 parent 绑定（setParentWindow 可重复调用）
    const owner = this.ownerWindow();
    if (owner) {
      try {
        win.setParentWindow(owner);
      } catch (_) {
        /* ignore */
      }
    }
    win.setBounds(this.position());
    win.setAlwaysOnTop(true, 'floating');
    win.show();
    win.focus();
    // 让渲染层把焦点落到输入框：能打字才叫「呼出即用」
    try {
      win.webContents.focus();
    } catch (_) {
      /* ignore */
    }
    try {
      win.webContents.send('quickask:reset');
    } catch (_) {
      /* ignore */
    }
    this.push();
    log.info('快捷问答面板已打开');
  }

  close() {
    clearTimeout(this._blurTimer);
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.push();
  }

  push() {
    try {
      if (this.win && !this.win.webContents.isDestroyed()) {
        this.win.webContents.send('quickask:state', this.state);
      }
    } catch (_) {
      /* ignore */
    }
  }

  /* --------------------------- 面板专属会话 --------------------------- */

  workerBounds() {
    const displays = screen.getAllDisplays();
    const left = displays.length ? Math.min(...displays.map((d) => d.bounds.x)) : 0;
    const top = displays.length ? Math.min(...displays.map((d) => d.bounds.y)) : 0;
    return { x: left - WORKER_WIDTH - 80, y: top, width: WORKER_WIDTH, height: WORKER_HEIGHT };
  }

  parkWorker() {
    if (!this.worker || this.worker.isDestroyed()) return;
    const wanted = this.workerBounds();
    const current = this.worker.getBounds();
    if (
      current.x !== wanted.x ||
      current.y !== wanted.y ||
      current.width !== wanted.width ||
      current.height !== wanted.height
    ) {
      this.worker.setBounds(wanted);
    }
  }

  async ensureWorker() {
    if (this.worker && !this.worker.isDestroyed() && !this.worker.webContents.isDestroyed()) {
      return this.worker.webContents;
    }
    if (this._workerReady) return this._workerReady;

    this._workerReady = this.createWorker().finally(() => {
      this._workerReady = null;
    });
    return this._workerReady;
  }

  async createWorker() {
    const site = this.ctx.config.get('site') || {};
    const bounds = this.workerBounds();
    const worker = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        partition: site.partition,
        preload: path.join(PATHS.dist, 'preload', 'site-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        zoomFactor: Number(this.ctx.config.get('zoomFactor')) || 1,
      },
    });
    this.worker = worker;

    const ua = uaPolicy.resolveUserAgent(this.ctx.config);
    if (ua) worker.webContents.setUserAgent(ua);

    worker.webContents.on('did-finish-load', () => injection.applyTo(worker.webContents, this.ctx.config));
    worker.webContents.on('render-process-gone', (_event, details) => {
      log.warn(`快捷问答后台页异常退出: ${details.reason}`);
      if (this.worker === worker) this.worker = null;
      this.setState({ phase: 'error', note: '后台会话已重置，请重新提问' });
      setImmediate(() => {
        if (!worker.isDestroyed()) worker.destroy();
      });
    });
    worker.on('move', () => setImmediate(() => this.parkWorker()));
    worker.on('closed', () => {
      if (this.worker === worker) this.worker = null;
    });

    const home = (this.ctx.config.get('site') || {}).home || 'https://chat.deepseek.com/';
    try {
      worker.loadURL(home).catch((err) => log.warn(`快捷问答后台页加载失败: ${err.message}`));
      worker.showInactive();
      this.parkWorker();
      await waitForLoad(worker.webContents);
    } catch (err) {
      log.warn(`创建快捷问答后台页失败: ${err.message}`);
      if (!worker.isDestroyed()) worker.destroy();
      return null;
    }
    log.info('快捷问答：已创建独立后台会话');
    return worker.webContents;
  }

  isWorkerSender(sender) {
    return !!this.worker && !this.worker.isDestroyed() && this.worker.webContents === sender;
  }

  /** 开新会话：清空上下文（复用同一个后台窗口，只是让它回到首页） */
  async newSession() {
    const webContents = await this.ensureWorker();
    if (!webContents) return false;
    try {
      webContents.send('cs:new-chat', {});
    } catch (err) {
      log.warn(`新建会话失败: ${err.message}`);
      return false;
    }
    this.state = { phase: 'idle', turns: [], note: '已开启新会话' };
    this.push();
    return true;
  }

  /* ------------------------------ 提问 ------------------------------ */

  /** 把问题投给面板自己的会话，然后开始盯回复 */
  async ask(text) {
    const question = String(text || '').trim();
    if (!question) return;
    if (this.state.phase === 'sending' || this.state.phase === 'generating') return;

    // 先记一轮新对话，答案留空后面增量填
    const turn = { q: question, a: '', reasoning: '', note: '' };
    this.state = {
      ...this.state,
      phase: 'sending',
      note: '正在发送…',
      turns: [...this.state.turns, turn],
    };
    this.push();

    const webContents = await this.ensureWorker();
    if (!webContents) {
      this.setState({ phase: 'error', note: '没能创建后台会话' });
      return;
    }
    clearTimeout(this._blurTimer);
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
    }

    try {
      webContents.send('cs:watch-answer', { on: true });
      webContents.send('cs:prompt', { text: question, submit: true });
    } catch (err) {
      this.setState({ phase: 'error', note: `投递失败: ${err.message}` });
      return;
    }
    log.info(`快捷问答已发送: ${question.slice(0, 40)}`);
  }

  /** 站点页 preload 回报的投递结果 */
  onPromptResult(info = {}) {
    const turns = this.state.turns.slice();
    const last = turns.length ? { ...turns[turns.length - 1] } : null;
    if (!last) return;
    if (info.ok) {
      last.note = '正在思考…';
      turns[turns.length - 1] = last;
      this.state = { ...this.state, phase: 'generating', turns, note: '正在思考…' };
    } else {
      last.note = info.reason || '发送失败';
      turns[turns.length - 1] = last;
      this.state = { ...this.state, phase: 'error', turns, note: last.note };
    }
    this.push();
  }

  /** 站点页 preload 回报的最新回复（增量刷新最后一轮） */
  onAnswer(info = {}) {
    const turns = this.state.turns.slice();
    const last = turns.length ? { ...turns[turns.length - 1] } : null;
    if (!last) return; // 没有对应的提问：多半是上一轮的超时回报晚到了，忽略

    last.a = info.content || '';
    last.reasoning = info.reasoning || '';

    if (!info.done) {
      last.note = last.a ? '正在回答…' : last.reasoning ? '正在思考…' : '等待回复…';
      turns[turns.length - 1] = last;
      this.state = { ...this.state, phase: 'generating', turns, note: last.note };
      this.push();
      return;
    }

    if (!info.gotSomething && !last.a && !last.reasoning) {
      last.note = info.timeout ? '等了 2 分钟没等到回复（页面可能被拦或没登录）' : '没读到回复内容';
      turns[turns.length - 1] = last;
      this.state = { ...this.state, phase: 'error', turns, note: last.note };
      this.push();
      return;
    }

    last.note = info.timeout ? '已超时，以下是目前读到的内容' : '';
    turns[turns.length - 1] = last;
    this.state = { ...this.state, phase: 'done', turns, note: last.note };
    this.push();
    log.info(
      `快捷问答收到回复: 正文 ${last.a.length} 字符 / 思考 ${last.reasoning.length} 字符`
    );
  }

  copyAnswer() {
    const turns = this.state.turns || [];
    const last = turns.length ? turns[turns.length - 1] : null;
    const text = last && (last.a || last.reasoning);
    if (!text) return false;
    try {
      clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  destroy() {
    clearTimeout(this._blurTimer);
    this._drag = null;
    screen.removeListener('display-added', this._reparkWorker);
    screen.removeListener('display-removed', this._reparkWorker);
    screen.removeListener('display-metrics-changed', this._reparkWorker);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    if (this.worker && !this.worker.isDestroyed()) this.worker.destroy();
    this.win = null;
    this.worker = null;
  }
}

module.exports = { QuickAskWindow };
