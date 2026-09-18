'use strict';

const fs = require('fs');
const path = require('path');
const { screen } = require('electron');
const { PATHS } = require('./paths');
const { log } = require('./log');
const injection = require('./injection');

/**
 * 非交互自检（npm run self-check）：
 * 打开窗口 → 等页面加载完 → 跑一遍选择器自检 → 打印报告 → 自动退出。
 *
 * 用途：站点一改版，先跑这个，一眼看出哪组选择器挂了，
 * 然后只改 src/inject/selectors.json，不用碰代码。
 */

function waitForLoad(webContents, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      resolve(why);
    };
    try {
      if (!webContents.isLoading()) return finish('已加载');
      webContents.once('did-finish-load', () => finish('did-finish-load'));
      webContents.once('did-fail-load', () => finish('did-fail-load'));
    } catch (_) {
      return finish('无法监听加载事件');
    }
    setTimeout(() => finish('超时'), timeoutMs);
  });
}

/**
 * 等 SPA 真正渲染完。
 *
 * `did-finish-load` 只代表 HTML 到了，此时 #root 还是空的（十几到一百多个元素），
 * 直接去查选择器必然全落空 —— 早先写死 sleep(1800) 就是这个毛病。
 *
 * 就绪判据不能只看元素总数：登录页只有 100 多个元素（不是聊天页的几千个），
 * 用总数当门槛会把登录页误判成"没渲染完"，白等满超时。
 * 真正的信号是 **#root 长出了子节点**（React 挂载完成）+ 页面有实际文案。
 */
async function waitForAppReady(webContents, timeoutMs = 45000) {
  const probe = `(() => {
    const root = document.querySelector('#root') || document.querySelector('#app');
    const text = document.body ? document.body.innerText : '';
    return {
      rootChildren: root ? root.children.length : 0,
      total: document.querySelectorAll('*').length,
      textLen: text.trim().length,
      hasComposer: document.querySelectorAll('textarea, [contenteditable="true"]').length > 0,
      blocked: /Rate Limit Reached|Request Blocked|Event ID|Too Many Requests|Access Denied/i.test(text)
    };
  })()`;

  const started = Date.now();
  let last = { rootChildren: 0, total: 0, textLen: 0, hasComposer: false, blocked: false };
  while (Date.now() - started < timeoutMs) {
    try {
      last = await webContents.executeJavaScript(probe, true);
    } catch (_) {
      /* 页面正在导航，下一轮再试 */
    }
    if (last && last.blocked) {
      return { ...last, ready: false, reason: '检测到拦截页', waitedMs: Date.now() - started };
    }
    // 注意：门槛要按「中文文本」来定。DeepSeek 空状态整页 innerText 只有 20 来个字符
    // （欢迎回来，随时开始吧 / 深度思考 / 智能搜索），用 40 当门槛会永远等不到。
    if (last && last.rootChildren > 0 && (last.textLen >= 10 || last.hasComposer)) {
      return { ...last, ready: true, reason: '应用已挂载', waitedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ...last, ready: false, reason: '等待渲染超时', waitedMs: Date.now() - started };
}

function format(report) {
  const lines = [];
  lines.push('========================= 选择器自检 =========================');
  lines.push(`页面            : ${report.title || '(无标题)'}`);
  lines.push(`地址            : ${report.url || '-'}`);

  if (report.blocked) {
    lines.push('');
    lines.push('  ⚠⚠⚠  检测到「风控拦截页」，本次选择器结果无效  ⚠⚠⚠');
    lines.push(`  命中特征      : ${report.blockedReason || '未知'}`);
    lines.push(`  页面内容片段  : ${String(report.blockedSnippet || '').slice(0, 160)}`);
    lines.push('  这不是站点改版，也别去改 selectors.json —— 先把拦截解决掉。');
    lines.push('  排查顺序：');
    lines.push('    1) 在普通 Chrome 里打开同一个地址，确认同一网络下能不能正常用');
    lines.push('    2) 看下面「生效 UA」里有没有 Electron/ 或应用名 token（有就是元凶）');
    lines.push('    3) 换个网络 / 等几分钟再试（短时间内反复重试会让限流更严重）');
    lines.push('');
  }

  if (report.selfHidden) {
    lines.push('');
    lines.push('  ⚠⚠⚠  注入层把页面自己隐藏了！（这就是白屏的原因）  ⚠⚠⚠');
    lines.push(`  具体表现      : ${(report.selfHiddenReasons || []).join('、')}`);
    lines.push(`  注入开关      : ${JSON.stringify(report.injectFlags || {})}`);
    lines.push('  说明：inject.css 里某条隐藏规则命中了 html/body 这类根节点。');
    lines.push('  排查：隐藏类规则必须用 data-* 开关 + :is(...) 包裹 + :not(html):not(body) 兜底，');
    lines.push('        并确认选择器不会匹配到开关属性值本身（例如 [class*="sidebar"] 会匹配类名 ds-hide-sidebar）。');
    lines.push('  应急：托盘菜单 → 注入 → 关掉「隐藏左侧栏 / 隐藏无关元素」。');
    lines.push('');
  }

  lines.push(`navigator.webdriver = ${report.webdriver}   <- 必须为 false（红线 2：不触发风控）`);
  lines.push(`生效 UA         : ${report.ua || '-'}`);
  if (report.uaBrands) lines.push(`UA Client Hints : ${report.uaBrands}`);
  if (/Electron\/|DeepSeekDesktop\//i.test(String(report.ua || ''))) {
    lines.push('  ⚠ UA 里带着 Electron/应用名 token，这是被边缘节点判定为「非标准浏览器」的直接依据。');
    lines.push('    把 config.json 的 userAgentMode 设成 "chrome"（默认已是），或看 src/main/useragent.js。');
  }
  lines.push(`元素总数        : ${report.elementCount ?? '-'}${report.blocked ? '   <- 正常应用页应该是几千' : ''}`);
  if (report.retried) lines.push('（检测到拦截后已自动重试 1 次，以上为重试后的结果）');

  if (report.pageKind === 'signin') {
    lines.push('');
    lines.push('  ℹ 当前停在「登录页」，不是聊天页。');
    lines.push('    composer / sendButton / assistantMessage 这几组本来就不该命中，');
    lines.push('    这不代表选择器过期。先在弹出的窗口里登录，再跑一次 npm run self-check。');
    lines.push('');
  }

  const groups = report.groups || {};
  const names = Object.keys(groups);
  const ok = names.filter((n) => groups[n].matched).length;
  const verdict =
    report.blocked || report.pageKind === 'signin' || report.selfHidden ? '（此数字不可信，见上方说明）' : '';
  lines.push(`命中            : ${ok}/${names.length} 组${verdict}`);
  lines.push('');

  for (const name of names) {
    const group = groups[name] || {};
    lines.push(`${group.matched ? '✅' : '❌'} ${name}`);
    for (const row of group.rows || []) {
      const mark = row.count > 0 ? '·' : ' ';
      const txt = row.matchedText ? `   → 命中文本「${row.matchedText}」` : '';
      const err = row.error ? `   ⚠ 无效选择器: ${row.error}` : '';
      lines.push(`     ${mark} ${String(row.count).padStart(3)} × ${row.selector}${txt}${err}`);
    }
  }
  lines.push('');
  lines.push('---- DOM 指纹（改 selectors.json 时照抄这里）----');
  lines.push(`页面标题        : ${report.title || '(无标题)'}`);
  lines.push(`元素总数        : ${report.elementCount ?? '-'}`);
  lines.push(`body 文本片段   : ${String(report.bodyText || '').replace(/\s+/g, ' ').slice(0, 180)}`);

  const probes = report.probes || {};
  const section = (title, rows, render) => {
    const list = rows || [];
    lines.push('');
    lines.push(`${title}（${list.length}）`);
    if (!list.length) lines.push('     （无）');
    for (const row of list.slice(0, 25)) lines.push(`     ${render(row)}`);
  };

  section('textarea', probes.textareas, (p) => `${p.id ? '#' + p.id : ''}${p.cls ? ' .' + p.cls.split(/\s+/).join('.') : ''}  placeholder="${p.placeholder}"`);
  section('contenteditable', probes.contentEditables, (p) => `${p.id ? '#' + p.id : ''}${p.cls ? ' .' + p.cls.split(/\s+/).join('.') : ''}  role=${p.role}`);
  section('可见按钮', probes.buttons, (p) => `aria="${p.aria}" title="${p.title}" text="${p.text}"${p.cls ? ' .' + p.cls.split(/\s+/).join('.') : ''}`);
  section('可见链接', probes.links, (p) => `href="${p.href}" text="${p.text}"${p.cls ? ' .' + p.cls.split(/\s+/).join('.') : ''}`);
  section(
    '高频 class token',
    probes.topClasses,
    (p) => `${String(p.count).padStart(4)} × ${p.name}`
  );

  lines.push('');
  lines.push(`报告 JSON  : ${PATHS.selectorReport}`);
  lines.push('==============================================================');
  return lines.join('\n');
}

async function run(ctx) {
  const win = ctx.windows.target();
  const tab = win && win.getActiveTab();
  if (!tab) {
    log.error('自检失败：没有可用的会话标签');
    return ctx.windows.quit();
  }
  const wc = tab.view.webContents;
  const why = await waitForLoad(wc);
  log.info(`自检：HTML 加载状态 = ${why}`);

  // 等 SPA 真正渲染出来再查选择器（did-finish-load 时 #root 还是空的）
  const ready = await waitForAppReady(wc);
  log.info(
    `自检：渲染等待 ${ready.waitedMs}ms → ${ready.reason}（#root 子节点 ${ready.rootChildren}，元素总数 ${ready.total}，输入框 ${ready.textareas}）`
  );

  let report;
  const runDiagnose = async () => {
    try {
      return await injection.diagnose(wc);
    } catch (err) {
      return { error: err.message, groups: {} };
    }
  };

  report = await runDiagnose();
  report.renderReady = ready;

  // 拦截页不是"选择器过期"，两者要分清楚，否则会带着人去改错地方。
  // 只重试一次 —— 短时间内反复重试只会让限流更严重。
  if (report.blocked) {
    log.warn(`检测到风控拦截页: ${report.blockedReason} —— 5 秒后自动重试一次`);
    await new Promise((r) => setTimeout(r, 5000));
    try {
      wc.reload();
    } catch (_) {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 600));
    await waitForLoad(wc, 20000);
    const retryReady = await waitForAppReady(wc, 20000);
    log.info(`自检：重试等待 ${retryReady.waitedMs}ms → ${retryReady.reason}`);
    report = await runDiagnose();
    report.retried = true;
    report.renderReady = retryReady;
    if (report.blocked) {
      log.warn(`重试后仍被拦截: ${report.blockedReason}。这不是代码问题，先解决拦截再来自检。`);
    } else {
      log.info('重试成功，页面已恢复正常。');
    }
  } else if (!ready.ready) {
    log.warn(`${ready.reason}：页面没渲染完整，本次选择器命中数可能偏低（不一定是选择器过期）。`);
  } else if (report.pageKind === 'signin') {
    log.info('当前是登录页（还没登录）。composer/sendButton 等组不适用，登录后再跑一次自检。');
  }

  const text = format(report);
  // 走 log 保证进日志文件（双击 exe 启动时看不到 stdout）
  log.info(`\n${text}`);
  try {
    fs.writeFileSync(PATHS.selfCheckFile, `${text}\n`, 'utf8');
    console.log(`\n自检报告已写入: ${PATHS.selfCheckFile}`);
  } catch (err) {
    log.warn(`自检报告写盘失败: ${err.message}`);
  }

  await captureShots(win, 'self-check', ctx);
  await verifyQuickAskPanel(ctx, win);
  await verifyWindowInteractions(ctx, win);

  setTimeout(() => ctx.windows.quit(), 400);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 快捷问答面板的端到端实测（npm run test:ask）。
 *
 * 会真的连续发两个相同问题 —— 因为「填输入框 → 点发送 → 盯住新回复 → 回传面板」
 * 这条链路没法靠静态检查覆盖，断了就只能等用户反馈。
 * 问题要求先思考再分点回答，用来观察“思考先于正文”的流式阶段。
 */
const TEST_QUESTION = '请先思考，再用三点简述 JavaScript 事件循环，每点一句。';

async function runAskTest(ctx) {
  const win = ctx.windows.target();
  if (!win) {
    log.error('问答测试失败：没有可用窗口');
    return ctx.windows.quit();
  }
  const tab = win.getActiveTab();
  if (!tab) {
    log.error('问答测试失败：没有活动会话');
    return ctx.windows.quit();
  }
  const initialTabIds = win.tabs.map((item) => item.id).join(',');
  const initialTabUrl = tab.url;

  const ready = await waitForAppReady(tab.view.webContents, 40000);
  log.info(`问答测试：页面就绪状态 = ${ready.reason}（元素 ${ready.total}，输入框=${ready.hasComposer}）`);
  if (!ready.hasComposer) {
    log.warn('当前页面没有输入框（可能未登录或被拦截），问答测试跳过。');
    return ctx.windows.quit();
  }

  ctx.openQuickAsk();
  await sleep(900);
  await captureShots(win, 'quickask-open', ctx);

  const started = Date.now();
  const phases = [];
  const reasoningStreamed = [];
  for (let round = 1; round <= 2; round++) {
    log.info(`问答测试：第 ${round} 轮发送「${TEST_QUESTION}」…`);
    await ctx.quickAsk.ask(TEST_QUESTION);

    const roundStarted = Date.now();
    let lastPhase = '';
    const reasoningLengths = new Set();
    while (Date.now() - roundStarted < 130000) {
      const current = ctx.quickAsk.state;
      const currentTurn = current.turns && current.turns[current.turns.length - 1];
      if (current.phase === 'generating' && currentTurn && currentTurn.reasoning) {
        reasoningLengths.add(currentTurn.reasoning.length);
      }
      if (current.phase !== lastPhase) {
        lastPhase = current.phase;
        phases.push(`${round}:${current.phase}@${Math.round((Date.now() - started) / 100) / 10}s`);
      }
      if (current.phase === 'done' || current.phase === 'error') break;
      await sleep(100);
    }
    reasoningStreamed.push(reasoningLengths.size >= 2);
    if (ctx.quickAsk.state.phase !== 'done') break;
  }

  const st = ctx.quickAsk.state;
  const turns = st.turns || [];
  const last = turns.length ? turns[turns.length - 1] : null;
  const answer = last ? last.a || '' : '';
  const reasoning = last ? last.reasoning || '' : '';
  const separated = !reasoning || !answer.includes(reasoning);
  log.info(
    `问答测试结果: phase=${st.phase} 耗时=${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `轮数=${turns.length} 正文=${answer.length}字 思考=${reasoning.length}字 note=${st.note || '-'}`
  );
  if (st.phase === 'done' && turns.length !== 2) {
    log.warn(`问答测试失败：期望完成 2 轮，实际 ${turns.length} 轮`);
  }
  log.info(`阶段变化: ${phases.join(' → ')}`);
  log.info(`思考过程观察到多个增量: ${reasoningStreamed.join(' / ') || '未观察到'}`);
  log.info(`思考与正文分离 = ${separated}`);
  if (!separated) log.warn('问答测试失败：完整思考内容混进了正文');
  const worker = ctx.quickAsk.worker;
  let workerVisibility = 'missing';
  let workerOutside = false;
  if (worker && !worker.isDestroyed()) {
    workerVisibility = await worker.webContents.executeJavaScript('document.visibilityState', true);
    const b = worker.getBounds();
    workerOutside = screen.getAllDisplays().every((display) => {
      const d = display.bounds;
      return b.x + b.width <= d.x || b.x >= d.x + d.width || b.y + b.height <= d.y || b.y >= d.y + d.height;
    });
  }
  const isolated = !!worker && workerVisibility === 'visible' && workerOutside && !worker.isFocused() &&
    win.getActiveTab() === tab && tab.url === initialTabUrl && win.tabs.map((item) => item.id).join(',') === initialTabIds;
  log.info(`快捷问答与主面板隔离 = ${isolated}`);
  log.info(`后台页 visibility=${workerVisibility} 屏幕外=${workerOutside} 获取焦点=${worker ? worker.isFocused() : false}`);
  if (!isolated) log.warn('问答测试失败：快捷问答隐藏会话影响了主面板');
  if (answer) {
    log.info(`回答内容(前 200 字): ${String(answer).slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  if (reasoning) {
    log.info(`思考过程(前 120 字): ${String(reasoning).slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  await captureShots(win, 'quickask-answer', ctx);

  await sleep(400);
  ctx.windows.quit();
}

/**
 * 快捷问答面板的可交互性自检。
 *
 * 面板和主窗口都是置顶窗口，默认位置又高度重叠（实测重叠 67%）——
 * 曾经的现象是「点面板输入框，实际点到主窗口，主窗口抢走焦点后把面板 blur 关掉」，
 * 用户看到的就是面板完全点不动。这类层级 + 几何问题静态检查抓不到，只能在这里断言。
 */
async function verifyQuickAskPanel(ctx, win) {
  const results = [];
  try {
    if (!win || !win.win || win.win.isDestroyed()) return;
    ctx.openQuickAsk();
    await sleep(800);

    const panel = ctx.quickAsk && ctx.quickAsk.win;
    if (!panel || panel.isDestroyed()) {
      log.warn('快捷问答自检：面板没能创建');
      return;
    }

    results.push(`面板可见 = ${panel.isVisible()}`);
    // 「窗口有没有系统前台焦点」和「DOM 焦点在不在输入框」是两件事：
    // 自动化/后台启动时窗口可能拿不到前台焦点，那时的 DOM 焦点失败是环境问题，不是 bug。
    results.push(`面板持有系统焦点 = ${panel.isFocused()}`);

    // preload 桥写错名字（比如改名后两边不一致）会让整个面板变成死的，
    // 但这在渲染层只会表现为「点了没反应」，必须显式断言。
    const bridgeOk = await panel.webContents.executeJavaScript(
      `typeof window.csQuickAsk === 'object' && typeof window.csQuickAsk.ask === 'function'`,
      true
    );
    results.push(`preload 桥已注入(csQuickAsk.ask) = ${bridgeOk}`);

    // ★ 关键断言：面板必须是主窗口的 owned window。
    // Windows 上 owned window 永远绘制在 owner 之上 —— 这是「点得到面板」的机制保证。
    // 靠两个顶层置顶窗口抢 z-order 是不可靠的（谁最后激活谁在上层）。
    let hasOwner = false;
    try {
      const owner = panel.getParentWindow();
      hasOwner = !!owner && !owner.isDestroyed();
    } catch (_) {
      /* ignore */
    }
    results.push(
      `已挂为主窗口的 owned window = ${hasOwner}${hasOwner ? '' : '   ← 异常！面板可能被主窗口盖住'}`
    );

    const pb = panel.getBounds();
    const mb = win.win.getBounds();
    const ox = Math.max(0, Math.min(mb.x + mb.width, pb.x + pb.width) - Math.max(mb.x, pb.x));
    const oy = Math.max(0, Math.min(mb.y + mb.height, pb.y + pb.height) - Math.max(mb.y, pb.y));
    const overlapPct = ((ox * oy) / (pb.width * pb.height)) * 100;
    results.push(
      `与主窗口重叠 = ${overlapPct.toFixed(1)}%（重叠本身不影响点击，层级由 owned window 保证）`
    );

    // 能打字才算「呼出即用」
    const focusedId = await panel.webContents.executeJavaScript(
      `document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'null'`,
      true
    );
    results.push(`焦点落在输入框 = ${focusedId === 'input'}`);

    // 渲染脚本是否整体跑通。脚本崩了面板就是个「点什么都没反应」的死壳，
    // 而且不会有任何可见提示 —— 必须显式断言，否则只能等用户来报。
    const booted = await panel.webContents.executeJavaScript('window.__qaReady === true', true);
    results.push(`渲染脚本已就绪 = ${booted}`);
    if (!booted) {
      log.warn('快捷问答自检：面板渲染脚本没跑通 —— 面板会「点什么都没反应」。看上面有没有 [面板控制台] 的报错。');
    }

    /* ---- Markdown 渲染管线冒烟测试（marked 解析 + DOMPurify 消毒）---- */
    const md = await panel.webContents.executeJavaScript(
      `(() => {
        const hasMarked = !!(window.marked && typeof window.marked.parse === 'function');
        const hasPurify = !!(window.DOMPurify && typeof window.DOMPurify.sanitize === 'function');
        if (!hasMarked || !hasPurify) return { hasMarked: hasMarked, hasPurify: hasPurify };
        const opts = { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input'], FORBID_ATTR: ['style', 'srcset'] };
        const render = (s) => window.DOMPurify.sanitize(window.marked.parse(s, { gfm: true, breaks: true }), opts);
        const h = render('# 标题\\n\\n- 甲\\n- 乙\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`\\n\\n**粗体**与\`行内\`');
        const evil = render('<img src=x onerror=alert(1)><script>alert(2)<\\/script>');
        return {
          hasMarked: hasMarked,
          hasPurify: hasPurify,
          heading: /<h1/.test(h),
          list: /<ul>/.test(h),
          code: /<pre/.test(h),
          inline: /<code>/.test(h),
          bold: /<strong>/.test(h),
          sanitized: !/<script|onerror=/i.test(evil),
        };
      })()`,
      true
    );
    results.push(
      `Markdown 管线: marked=${md.hasMarked} DOMPurify=${md.hasPurify} 标题=${md.heading} ` +
        `列表=${md.list} 代码块=${md.code} 行内码=${md.inline} 粗体=${md.bold} 危险标签已清除=${md.sanitized}`
    );
    if (!md.hasMarked || !md.hasPurify) {
      log.warn('快捷问答自检：marked / DOMPurify 没加载上 —— 检查 node_modules 装好没、CSP 是否放行。');
    } else {
      if (!md.heading || !md.list || !md.code || !md.bold) {
        log.warn('快捷问答自检：Markdown 有语法没渲染出来，检查依赖引入。');
      }
      if (!md.sanitized) log.warn('快捷问答自检：DOMPurify 没清掉危险标签 —— 有 XSS 风险，必须修！');
    }

    /* ---- 多轮 + 思考过程折叠：喂一份假状态，验证渲染结果 ----
       比真发消息好：不污染会话历史，还能精确控制「有思考 / 无思考」两种形态。 */
    const savedState = JSON.parse(JSON.stringify(ctx.quickAsk.state));
    ctx.quickAsk.setState({
      phase: 'generating',
      note: '正在思考…',
      turns: [{ q: '流式测试', a: '', reasoning: '先分析问题，再组织答案', note: '正在思考…' }],
    });
    await sleep(250);
    const streaming = await panel.webContents.executeJavaScript(
      `(() => {
        const turn = document.querySelector('.turn');
        const think = turn && turn.querySelector('.think');
        const note = turn && turn.querySelector('.turn-note');
        return {
          thinkVisible: !!(think && !think.hidden),
          thinkOpen: !!(think && think.open),
          reasoning: think ? think.querySelector('.think-body').textContent : '',
          busy: !!(note && note.classList.contains('busy')),
          status: note ? note.textContent : '',
        };
      })()`,
      true
    );
    results.push(
      `流式思考: 可见=${streaming.thinkVisible} 展开=${streaming.thinkOpen} ` +
        `状态=${streaming.status} 动态标记=${streaming.busy}`
    );
    if (!streaming.thinkVisible || !streaming.thinkOpen || !streaming.reasoning || !streaming.busy) {
      log.warn('快捷问答自检：思考过程没有在正文出现前进入流式生成态');
    }

    ctx.quickAsk.setState({
      phase: 'done',
      note: '',
      turns: [
        { q: '第一问', a: '**答案一**', reasoning: '第一轮的思考过程原文', note: '' },
        { q: '第二问', a: '# 答案二\n\n- 甲\n- 乙', reasoning: '', note: '' },
      ],
    });
    await sleep(450);

    const dom = await panel.webContents.executeJavaScript(
      `(() => {
        const turns = Array.from(document.querySelectorAll('.turn'));
        const t0 = turns[0] || null;
        const t1 = turns[1] || null;
        const think0 = t0 ? t0.querySelector('.think') : null;
        return {
          count: turns.length,
          t0ThinkVisible: !!(think0 && !think0.hidden),
          t0ThinkOpen: !!(think0 && think0.open),
          t0ThinkText: t0 && t0.querySelector('.think-body') ? t0.querySelector('.think-body').textContent.slice(0, 8) : '',
          t0AnswerText: t0 && t0.querySelector('.a') ? t0.querySelector('.a').textContent : '',
          t0Bold: !!(t0 && t0.querySelector('.a strong')),
          t0Q: t0 ? (t0.querySelector('.q').textContent || '') : '',
          t1ThinkVisible: !!(t1 && t1.querySelector('.think') && !t1.querySelector('.think').hidden),
          t1H1: !!(t1 && t1.querySelector('.a h1')),
          t1Ul: !!(t1 && t1.querySelector('.a ul')),
        };
      })()`,
      true
    );
    results.push(`多轮渲染: 轮数=${dom.count} 期望 2`);
    results.push(
      `第1轮: 问题="${dom.t0Q}" 思考块可见=${dom.t0ThinkVisible} 思考已折叠=${!dom.t0ThinkOpen} ` +
        `思考原文="${dom.t0ThinkText}" 正文加粗=${dom.t0Bold}`
    );
    results.push(`第2轮: 无思考块=${!dom.t1ThinkVisible} 标题=${dom.t1H1} 列表=${dom.t1Ul}`);
    if (dom.count !== 2) log.warn('快捷问答自检：多轮对话没有渲染成 2 轮');
    if (!dom.t0ThinkVisible || dom.t0ThinkOpen) {
      log.warn('快捷问答自检：思考过程没有正确折叠（有正文时应自动收起）');
    }
    if (dom.t0AnswerText.includes('思考过程原文')) {
      log.warn('快捷问答自检：思考内容混进了正文区域');
    }

    // 长回答必须留在固定高度的内容容器里滚动，不能把窗口越撑越大。
    ctx.quickAsk.setState({
      phase: 'done',
      note: '',
      turns: [{ q: '长回答滚动测试', a: Array.from({ length: 80 }, (_, i) => `${i + 1}. 测试内容`).join('\n'), reasoning: '', note: '' }],
    });
    await sleep(300);
    const scroll = await panel.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('content');
        const scrollable = el.scrollHeight > el.clientHeight;
        el.scrollTop = Math.max(1, Math.floor((el.scrollHeight - el.clientHeight) / 2));
        return { scrollable, moved: el.scrollTop > 0, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
      })()`,
      true
    );
    results.push(
      `长回答滚动: 可滚动=${scroll.scrollable} 已移动=${scroll.moved} ` +
        `高度=${scroll.clientHeight}/${scroll.scrollHeight}`
    );
    if (!scroll.scrollable || !scroll.moved) log.warn('快捷问答自检：长回答内容区无法滚动');

    // 趁这份样例数据还在，截一张 —— 它就是「多轮 + 思考折叠 + Markdown」的真实渲染效果，
    // 排查「渲染不对」时比对着描述猜快得多。
    await captureShots(win, 'quickask-render', ctx);

    // 还原（别把假数据留在面板上）
    ctx.quickAsk.state = savedState;
    ctx.quickAsk.push();
    await sleep(250);

    // 拖动面板：合成 PointerEvent 端到端跑一遍（渲染层 → IPC → setBounds）。
    // 这类靠鼠标才能触发的功能人工很难回归，坏掉也只能等用户说「拖不动」。
    const send = (js) => panel.webContents.executeJavaScript(js, true);
    const mkPointerFn = (id) =>
      'function mk(t,X,Y){return new PointerEvent(t,{bubbles:true,cancelable:true,button:0,buttons:1,' +
      'isPrimary:true,pointerId:' +
      id +
      ',pointerType:"mouse",screenX:X,screenY:Y,clientX:0,clientY:0});}';

    const beforeDrag = panel.getBounds();
    const px = beforeDrag.x + 100;
    const py = beforeDrag.y + 20;
    const P = mkPointerFn(1);
    await send(
      '(function(){' + P + 'document.getElementById("dragbar")' +
        '.dispatchEvent(mk("pointerdown",' + px + ',' + py + '));return 1;})()'
    );
    await sleep(90);
    await send(
      '(function(){' + P + 'document.getElementById("dragbar")' +
        '.dispatchEvent(mk("pointermove",' + (px + 60) + ',' + (py + 40) + '));return 1;})()'
    );
    await sleep(90);
    await send(
      '(function(){' + P + 'document.getElementById("dragbar")' +
        '.dispatchEvent(mk("pointerup",' + (px + 60) + ',' + (py + 40) + '));return 1;})()'
    );
    await sleep(420);
    const afterDrag = panel.getBounds();
    const dx = afterDrag.x - beforeDrag.x;
    const dy = afterDrag.y - beforeDrag.y;
    const sizeStable = afterDrag.width === beforeDrag.width && afterDrag.height === beforeDrag.height;
    results.push(
      `拖动面板 位移(${dx},${dy}) 期望(60,40)=${dx === 60 && dy === 40} 尺寸不变=${sizeStable}`
    );

    // 反过来也要成立：从输入框上拖动绝不能挪窗口。
    // 拖拽区一旦吃掉输入框的指针事件，表现就是「点不进输入框」。
    const beforeInput = panel.getBounds();
    const Q = mkPointerFn(2);
    await send(
      '(function(){' + Q + 'var el=document.getElementById("input");' +
        'el.dispatchEvent(mk("pointerdown",' + (beforeInput.x + 200) + ',' + (beforeInput.y + 30) + '));return 1;})()'
    );
    await sleep(80);
    await send(
      '(function(){' + Q + 'document.getElementById("input")' +
        '.dispatchEvent(mk("pointermove",' + (beforeInput.x + 500) + ',' + (beforeInput.y + 300) + '));return 1;})()'
    );
    await sleep(80);
    await send(
      '(function(){' + Q + 'document.getElementById("input")' +
        '.dispatchEvent(mk("pointerup",' + (beforeInput.x + 500) + ',' + (beforeInput.y + 300) + '));return 1;})()'
    );
    await sleep(360);
    const afterInput = panel.getBounds();
    const ix = afterInput.x - beforeInput.x;
    const iy = afterInput.y - beforeInput.y;
    results.push(`从输入框拖动 位移(${ix},${iy}) 期望(0,0) = ${ix === 0 && iy === 0}`);

    await captureShots(win, 'quickask-panel', ctx);
    log.info(`快捷问答面板自检:\n  - ${results.join('\n  - ')}`);
  } catch (err) {
    log.warn(`快捷问答面板自检失败: ${err.message}`);
  } finally {
    try {
      ctx.closeQuickAsk();
    } catch (_) {
      /* ignore */
    }
    await sleep(250);
  }
}

/**
 * 窗口交互自检。
 *
 * 拖拽、置顶、紧凑切换这类功能靠鼠标才能触发，人工很难回归、也不好远程描述
 * 「到底哪里坏了」。所以这里在标题栏里合成一串 PointerEvent，端到端跑一遍：
 *   - 拖拽：合成 pointerdown/move/up，检查窗口位移是否精确等于鼠标位移
 *   - 紧凑切换：切到展开再切回来，检查尺寸是否按档位变化
 * 顺带确认置顶真的生效。
 */
async function verifyWindowInteractions(ctx, win) {
  if (!win || !win.win || win.win.isDestroyed()) return;
  const results = [];

  // 这段会真的拖动/缩放窗口。几何变化不能落盘，否则自检会把用户窗口
  // 挪到测试位置并让下次启动不再居中 —— 所以全程关掉持久化，跑完还原。
  const savedWindow = JSON.parse(JSON.stringify(ctx.config.get('window') || {}));
  const startBounds = win.win.getBounds();
  win.suppressPersist = true;

  /* ---- 1) 置顶 ---- */
  try {
    results.push(`置顶 = ${win.win.isAlwaysOnTop()}`);
  } catch (err) {
    results.push(`置顶读取失败: ${err.message}`);
  }

  /* ---- 2) 拖拽 ---- */
  const before = win.win.getBounds();
  const DX = 80;
  const DY = 40;
  try {
    await win.chromeView.webContents.executeJavaScript(
      `(async () => {
        const bar = document.getElementById('titlebar');
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const send = (type, x, y) => {
          bar.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 1, isPrimary: true, button: 0, buttons: 1,
            screenX: x, screenY: y, clientX: 4, clientY: 20
          }));
        };
        send('pointerdown', 5000, 5000);
        await frame();
        send('pointermove', ${5000 + DX}, ${5000 + DY});
        await frame();
        await frame();
        send('pointerup', ${5000 + DX}, ${5000 + DY});
        await frame();
        return true;
      })()`,
      true
    );
    await sleep(350);
    const after = win.win.getBounds();
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const sizeStable = after.width === before.width && after.height === before.height;
    results.push(
      `拖拽 位移(${dx},${dy}) 期望(${DX},${DY}) ${dx === DX && dy === DY ? '✅' : '❌'} ` +
        `尺寸不变=${sizeStable ? '✅' : '❌'}`
    );
    // 复位，别把用户窗口挪走
    win.win.setBounds(before);
    await sleep(150);
  } catch (err) {
    results.push(`拖拽自检失败: ${err.message}`);
  }

  /* ---- 3) 紧凑 ⇄ 展开 ---- */
  try {
    const compactBefore = win.currentSize();
    const expanded = win.toggleCompact();
    await sleep(250);
    const sizeExpanded = win.win.getBounds();
    win.toggleCompact();
    await sleep(250);
    const sizeCompact = win.win.getBounds();
    const expected = win.currentSize();
    results.push(
      `紧凑切换 展开档=${expanded} 展开后=${sizeExpanded.width}×${sizeExpanded.height} ` +
        `切回后=${sizeCompact.width}×${sizeCompact.height} 期望=${expected.width}×${expected.height} ` +
        `${Math.abs(sizeCompact.width - expected.width) <= 4 && Math.abs(sizeCompact.height - expected.height) <= 4 ? '✅' : '❌'}`
    );
    results.push(`紧凑档原始尺寸 ${compactBefore.width}×${compactBefore.height}`);
  } catch (err) {
    results.push(`紧凑切换自检失败: ${err.message}`);
  }

  log.info(`窗口交互自检:\n  - ${results.join('\n  - ')}`);

  // 还原：窗口位置 + 被这段测试动过的配置。
  // suppressPersist 故意不关回去 —— 还原用的 setBounds 会触发一次 move 事件，
  // 落盘的防抖要 500ms 后才执行，那时再关就已经晚了。
  // 反正自检跑完就退出，全程不落盘最干净（否则会把「自动居中」变成写死的坐标，
  // 多显示器下换个屏唤出就不居中了）。
  try {
    win.win.setBounds(startBounds);
    ctx.config.set('window', savedWindow);
  } catch (err) {
    log.warn(`交互自检还原失败: ${err.message}`);
  }
}

/**
 * 顺手截两张图：标题栏和站点区各一张。
 * 排查「小窗口下标题栏挤成一团」「注入的悬浮条挡住按钮」「页面白屏」这类问题时，
 * 有图比描述快得多。截图失败不影响自检结果。
 *
 * 顺便做**空白检测**：只存图不分析的话，「站点一片白」这种问题会静默溜过去
 * （capturePage 返回一张全白图，isEmpty() 依然是 false，不会报错）。
 */
function analyzeImage(image) {
  try {
    const bmp = image.toBitmap();
    let min = 255;
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const v = bmp[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n++;
    }
    return { min, max, avg: n ? Number((sum / n).toFixed(1)) : 0, blank: min === max, size: image.getSize() };
  } catch (_) {
    return null;
  }
}

async function captureShots(win, prefix = 'self-check', ctx = null) {
  const shots = [
    [`${prefix}-chrome.png`, win && win.chromeView],
    [`${prefix}-site.png`, win && win.getActiveTab() && win.getActiveTab().view],
  ];
  // 快捷问答面板开着的话也拍一张（它是普通 BrowserWindow，直接拿 webContents）
  const panel = ctx && ctx.quickAsk && ctx.quickAsk.win && !ctx.quickAsk.win.isDestroyed() ? ctx.quickAsk.win : null;
  if (panel) shots.push([`${prefix}-panel.png`, { webContents: panel.webContents }]);

  for (const [name, view] of shots) {
    try {
      if (!view || !view.webContents || view.webContents.isDestroyed()) continue;
      const image = await view.webContents.capturePage();
      if (image.isEmpty()) continue;
      const file = path.join(PATHS.userData, name);
      fs.writeFileSync(file, image.toPNG());
      const stat = analyzeImage(image);
      if (stat && stat.blank) {
        log.warn(
          `截图 ${name} 是【全白】：${stat.size.width}×${stat.size.height}。` +
            `捕获到一片纯色说明这一层根本没画出来，不是内容为空。`
        );
      } else if (stat) {
        log.info(
          `截图 ${name}: ${stat.size.width}×${stat.size.height} 亮度 min=${stat.min} max=${stat.max} avg=${stat.avg}`
        );
      }
      console.log(`截图已保存: ${file}`);
    } catch (err) {
      log.warn(`截图失败(${name}): ${err.message}`);
    }
  }
}

/* ========================================================================== */
/*                        深度探测：一条回复的真实结构                          */
/* ========================================================================== */

/**
 * 打开一个历史会话，dump「助手回复」的 DOM 结构。
 *
 * 为什么单独做这个：快捷问答要分别读「思考过程」和「正文」，还必须知道
 * 「一条完整回复」的容器是哪一层 —— 这些在首页（新会话，页面上没有回复）
 * 完全看不出来。盲写选择器只会读到碎片（实测读到过只剩 `-` 和 `34`）。
 *
 * 用 `npm run probe:chat` 跑，输出写 %APPDATA%/ChatShell/chat-structure.txt。
 */
const STRUCTURE_PROBE = `(() => {
  const out = [];
  const cls = (el) => String(el.className || '').split(/\\s+/).filter(Boolean).join('.');
  const label = (el) => '<' + el.tagName.toLowerCase() + (cls(el) ? ' .' + cls(el) : '') + '>';
  const txt = (el) => String(el.textContent || '').replace(/\\s+/g, ' ').trim();
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.width) + 'x' + Math.round(r.height);
  };
  const clip = (s, n) => s.slice(0, n === undefined ? 26 : n);

  const mds = Array.from(document.querySelectorAll('[class*="markdown"], [class*="md-"]'))
    .filter((el) => txt(el).length > 0);

  out.push('页面: ' + location.href);
  out.push('含 markdown 类的元素总数: ' + mds.length);
  out.push('');
  out.push('--- 后 6 个 markdown 元素（看它们是不是同一层的碎片）---');
  mds.slice(-6).forEach((el) => {
    out.push('  ' + label(el) + ' ' + box(el) + ' len=' + txt(el).length + ' | ' + clip(txt(el)));
  });

  if (mds.length) {
    let el = mds[mds.length - 1];
    const chain = [];
    for (let d = 0; d < 10 && el; d++) { chain.push(el); el = el.parentElement; }

    out.push('');
    out.push('--- 从最后一个 markdown 元素向上 10 层 ---');
    chain.forEach((n, i) => {
      out.push('  ↑' + i + ' ' + label(n) + ' ' + box(n) +
        ' 子元素=' + n.children.length + ' len=' + txt(n).length);
    });

    // 取祖先链第 4 层当「一条消息」的容器（通常正好是消息气泡那一层）
    const root = chain[Math.min(chain.length - 1, 4)];
    out.push('');
    out.push('--- 消息容器子树 root=' + label(root) + ' ---');
    const walk = (node, depth) => {
      for (const child of node.children) {
        if (out.length > 150) return;
        const r = child.getBoundingClientRect();
        out.push('  '.repeat(depth) + label(child) +
          ' h=' + Math.round(r.height) +
          ' len=' + txt(child).length +
          (r.height === 0 ? '  [不可见]' : '') +
          ' | ' + clip(txt(child)));
        if (depth < 3) walk(child, depth + 1);
      }
    };
    walk(root, 1);
  }

  // 顺带把「可能和思考过程有关」的元素的类名全列出来
  const thinkish = Array.from(document.querySelectorAll('[class*="think"], [class*="reason"], [class*="Thought"], details, [aria-expanded]'))
    .slice(0, 14);
  out.push('');
  out.push('--- 疑似「思考过程」相关元素 ---');
  if (!thinkish.length) out.push('  （一个都没有）');
  thinkish.forEach((el) => {
    out.push('  ' + label(el) + ' ' + box(el) + ' len=' + txt(el).length +
      ' aria=' + (el.getAttribute('aria-expanded') || '-') + ' | ' + clip(txt(el), 34));
  });

  return out.join('\\n');
})()`;

async function runChatProbe(ctx) {
  const win = ctx.windows.target();
  const tab = win && win.getActiveTab();
  if (!tab) {
    log.error('探测失败：没有可用的会话标签');
    return ctx.windows.quit();
  }
  const wc = tab.view.webContents;
  // 侧边栏在窄窗口下站点根本不渲染 —— 探测要能看到历史会话列表，先把窗口放大
  try {
    win.show();
    const b = win.win.getBounds();
    win.win.setBounds({ x: b.x, y: b.y, width: 1280, height: 900 });
    await sleep(1500);
  } catch (_) {
    /* ignore */
  }
  await waitForLoad(wc);
  await waitForAppReady(wc);

  // 打开一个已有会话 —— 新会话页面上没有回复，探测不出东西
  const opened = await wc.executeJavaScript(
    `(() => {
      const sels = ['a[href*="/a/chat/s/"]', 'a[href*="/chat/s/"]', 'a[href*="/chat/"]'];
      for (const s of sels) {
        const links = Array.from(document.querySelectorAll(s))
          .filter((a) => a.href && a.href.indexOf('#') === -1);
        if (links.length) { links[0].click(); return { ok: true, how: s, href: links[0].href, n: links.length }; }
      }
      return { ok: false };
    })()`,
    true
  );

  if (!opened.ok) {
    log.warn('探测：没找到历史会话链接（侧边栏可能没渲染，或这个账号还没有历史会话）');
    log.warn('→ 你可以先在主窗口打开任意一个历史会话，然后再跑一次 npm run probe:chat');
  } else {
    log.info(`探测：已打开历史会话（${opened.how}，共 ${opened.n} 条）${opened.href}`);
    await sleep(6000); // 等这个会话的消息渲染出来
  }

  let text;
  try {
    text = await wc.executeJavaScript(STRUCTURE_PROBE, true);
  } catch (err) {
    text = `探测脚本执行失败: ${err.message}`;
  }

  const file = path.join(PATHS.userData, 'chat-structure.txt');
  try {
    fs.writeFileSync(file, `${text}\n`, 'utf8');
    console.log(`\n结构已写入: ${file}`);
  } catch (err) {
    log.warn(`结构写盘失败: ${err.message}`);
  }
  log.info(`\n${text}`);

  // ★ 最关键的一步：让注入层用它**真实的解析代码**读一遍这个会话，
  // 回报「正文 / 思考」分离得对不对。光看 DOM 结构猜不出解析逻辑是否真的能用。
  try {
    ctx.lastDebugResult = null;
    win.sendToTab(win.getActiveTab(), 'cs:debug-read-turn', {});
    const asked = Date.now();
    while (!ctx.lastDebugResult && Date.now() - asked < 6000) await sleep(300);

    if (ctx.lastDebugResult) {
      const r = ctx.lastDebugResult;
      log.info(
        `★ 解析自检（用的是注入层真实代码）:\n` +
          `  正文 ${r.contentLen} 字 / 思考 ${r.reasoningLen} 字\n` +
          `  正文容器   : ${r.contentElClass}\n` +
          `  一轮容器   : ${r.turnClass}\n` +
          `  思考容器   : ${r.reasoningElClass}\n` +
          `  正文开头   : ${String(r.contentHead || '').replace(/\s+/g, ' ').slice(0, 110)}\n` +
          `  思考开头   : ${String(r.reasoningHead || '').replace(/\s+/g, ' ').slice(0, 110)}`
      );
      if (!r.ok) log.warn('解析自检：注入层一条回复都没读到 —— 选择器多半需要按上面的结构改。');
      else if (!r.contentLen) log.warn('解析自检：只读到思考、没读到正文。检查 assistantMessage 组。');
      else if (!r.reasoningLen) {
        log.info('解析自检：这个会话没有思考过程（或该模型不产出），所以思考容器显示未命中属正常。');
      }
    } else {
      log.warn('解析自检：注入层没有回报结果（页面可能还没就绪，或 preload 没装上）。');
    }
  } catch (err) {
    log.warn(`解析自检失败: ${err.message}`);
  }

  await captureShots(win, 'probe-chat', ctx);
  await sleep(400);
  ctx.windows.quit();
}

module.exports = { run, runAskTest, runChatProbe };
