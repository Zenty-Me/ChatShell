'use strict';

/**
 * 默认配置。所有可调项集中在这里，config.json 只存被改过的值。
 */
const configDefaults = {
  // 注意：configVersion 故意不放在这里。
  // 迁移要靠「磁盘上有没有显式存过版本号」来判断文件真实版本，
  // 放进 defaults 会让老文件看起来已经是新版，迁移永远不会执行。
  // 版本号由 src/main/config-migrate.js 自己写入 config.json。

  // --- 快捷启动 ---
  hotkey: 'Alt+Space',
  // 如果 Alt+Space 被系统占用（Windows 上 Alt+Space 是窗口系统菜单），按顺序回退
  hotkeyFallbacks: ['Alt+Shift+Space', 'Control+Alt+Space', 'F9'],
  // Prompt 模板库
  promptHotkey: 'Control+Alt+P',
  // 快捷问答面板（Cherry Studio 那种小助手：呼出 → 打字 → 就地看答案）
  quickAskHotkey: 'Control+Shift+Space',
  autoLaunch: true, // 开机自启
  hideToTrayOnClose: true, // 关闭窗口 = 收进托盘（不退出）
  startMinimized: false, // 启动时直接进托盘
  alwaysOnTop: true, // 窗口置顶（唤出即用，不希望被别的窗口盖住）
  theme: 'system', // system | light | dark
  zoomFactor: 1,

  // --- UA（红线 2 的例外说明见 src/main/useragent.js）---
  // 'chrome'  = 抹掉 Electron/<app> token 并做 Chrome UA 缩减，与真实 Chrome 一致
  // 'default' = 保留 Electron 原生 UA（会被 DeepSeek 边缘节点判定为非标准浏览器，
  //             实测直接返回 429 + "Rate Limit Reached" 拦截页）
  userAgentMode: 'chrome',
  // 只有上面两种模式都不适用时才手填，填了就优先用它
  userAgent: '',

  // --- 网络 ---
  // 公司/校园网需要代理时填，例如 "http://127.0.0.1:7890"。
  // 留空时会自动读 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 环境变量
  // （Chromium 默认不认环境变量代理，这里补上）。
  proxy: '',

  // --- 站点 ---
  // 想换成别的网页版 AI，改这三处即可：name / home / partition，
  // 再照着 src/inject/selectors.json 的注释校一遍选择器。
  site: {
    name: 'DeepSeek', // 站点显示名（窗口标题、标签兜底文案用）
    home: 'https://chat.deepseek.com/',
    // 关键：persist: 前缀才会把 cookie/localStorage 落到磁盘。
    // 绝不要改成非 persist 的 partition，也绝不要调 session.clearStorageData()
    // 换站点时务必换成新的 partition 名（例如 persist:kimi），否则两边登录态会串
    partition: 'persist:deepseek',
  },

  // --- 注入层（只加不抢，全部可单独关掉，关掉后主功能照常可用）---
  injection: {
    enabled: true,
    compact: true, // 紧凑模式：压缩留白，省垂直空间
    hideSidebar: true, // 隐藏左侧的历史会话栏（小窗口放不下，也不需要）
    hideExtras: true, // 隐藏下载 App / 公告等干扰元素
    ctrlEnterToSend: true, // Ctrl+Enter 发送（避开输入法组字）
    // 页内悬浮条（MD / 新的 / 重载）。默认关闭：实测它会压住正文、且现在的
    // 快捷问答面板已经覆盖了这些场景。想要的话到托盘里打开，或者用右键菜单
    // 的「复制最新回复为 Markdown」——那条不受这个开关影响。
    copyButtons: false,
  },

  // --- 窗口形态 ---
  // 默认是「紧凑小窗口」：热键唤出 → 一个小窗停在屏幕上方居中，置顶、随手拖走。
  // 两档尺寸分开记：切到展开档不会把紧凑档的尺寸覆盖掉。
  window: {
    compact: true, // true = 紧凑小窗口（默认），false = 展开
    compactSize: { width: 480, height: 700 },
    expandedSize: { width: 1180, height: 820 },

    // x/y 为 null = 还没被用户拖过，每次启动按「停靠点」自动摆放（屏幕上方居中）。
    // 用户一旦拖动就会写回实际坐标，之后一直记住。
    x: null,
    y: null,
    maximized: false,
  },
};

const promptDefaults = {
  items: [
    {
      id: 'p-review',
      title: '代码审查',
      text:
        '请以资深工程师的视角审查下面这段代码，按以下结构输出：\n' +
        '1) 一句话结论（可用 / 有风险 / 不可用）\n' +
        '2) 潜在 Bug 与边界条件\n' +
        '3) 安全与性能风险\n' +
        '4) 可读性与命名问题\n' +
        '5) 改写后的完整代码\n\n' +
        '代码：\n',
    },
    {
      id: 'p-bugfix',
      title: '报错排查',
      text:
        '我遇到一个报错，请按下面顺序帮我定位：\n' +
        '1) 这个报错最可能的 3 个根因，按概率排序\n' +
        '2) 每个根因的最小验证方法（我该跑什么命令 / 看什么）\n' +
        '3) 确认根因后的修复方案\n\n' +
        '报错信息：\n```\n\n```\n\n相关代码：\n```\n\n```\n',
    },
    {
      id: 'p-summary',
      title: '结构化总结',
      text:
        '把下面的内容压缩成结构化笔记：\n' +
        '- 一句话结论\n' +
        '- 3~5 条关键要点（每条不超过 30 字）\n' +
        '- 待办事项（谁 / 做什么 / 何时）\n' +
        '- 仍不确定的问题\n\n' +
        '内容：\n',
    },
    {
      id: 'p-translate',
      title: '中英翻译润色',
      text:
        '把下面的文本翻译成地道的英文（技术语境，保留术语与代码原样），' +
        '再给出一个更简洁的版本，最后列出 3 个表达上的取舍点。\n\n' +
        '文本：\n',
    },
    {
      id: 'p-regex',
      title: '正则解释',
      text: '逐段拆解下面这个正则的含义，给出匹配示例和容易踩的坑，最后给一份更易读的等价写法。\n\n正则：\n',
    },
    {
      id: 'p-meeting',
      title: '会议纪要',
      text:
        '把下面的会议记录整理成纪要：背景 → 达成的结论 → 分歧点 → 行动项（负责人 + 截止时间）。' +
        '没有明确的信息不要编造，标注「未明确」。\n\n记录：\n',
    },
  ],
};

module.exports = { configDefaults, promptDefaults };
