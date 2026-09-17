# ChatShell

**网页版 AI 的桌面外壳。** 当前适配 DeepSeek（chat.deepseek.com），架构上不绑定任何一家 —— 换站只改三行配置 + 一份选择器。

名字取「壳」的意思：它**不是**另一个 AI 客户端，而是在官方网页外面加一层壳。

**一句话定位**：登录态存在本地、按一次热键就能以小窗口呼出、能改造站点 UI 但改坏了也不影响主功能。

```
┌──────────────────────────────────────────────┐
│  标题栏（自绘 40px）  Tabs  置顶  提示词  ─ □ ✕ │  ← 第 1 层：窗口层
├──────────────────────────────────────────────┤
│                                              │
│      WebContentsView  ← chat.deepseek.com     │  ← 第 2 层：站点层
│      partition: persist:deepseek              │     （登录态在这里）
│                                              │
│                            （注入的 DOM 打 cs- 标记）│  ← 第 3 层：注入层
└──────────────────────────────────────────────┘     只加不抢，选不到就静默跳过
```

三层各管各的：窗口层管快捷启动，站点层管登录态，注入层管改造 ——
**所以站点改版只会影响注入层，登录态和主功能不受影响**，这就是这个结构存在的意义。

---

## 适配其他网页版 AI

因为壳和站点是解耦的，换站需要改的地方很少：

| 步骤 | 改哪里 | 说明 |
| --- | --- | --- |
| 1 | `config.json` 的 `site` | `name`（显示名）、`home`（首页地址）、**`partition` 必须换成新的**（例如 `persist:kimi`），否则两家登录态会串在一起 |
| 2 | `src/inject/selectors.json` | 选择器换掉。**不用靠猜**：先跑 `npm run self-check`，报告里的「DOM 指纹」会把真实存在的 `textarea`、按钮标签、高频 class 全列出来，照着抄即可 |
| 3 | `src/main/useragent.js` | 一般不用动。它本来就是通用的：抹掉所有非标准产品 token + 做 Chrome UA 缩减 |
| 4 | 想同时保留多个站点 | 给每个站点一个 `partition` 和一个 selectors 文件即可；当前实现是「一次一个站点」，多站点并存需要把 `config.site` 改成数组并让 Tab 带上站点标识 |

不用改的：注入层的容错机制、通用兜底（找不到输入框就退化为最后一个可见 textarea）、拦截页识别、快捷问答、托盘、热键 —— 这些都是站点无关的。

---

## 30 秒跑起来

```bash
npm install          # 已经装好了，重装才需要
npm run verify:login # ① 先干这个，见下一节
npm start            # ② 正常启动
```

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 正常启动 |
| `npm run dev` | 启动并打开开发者工具 |
| `npm run verify:login` | **登录态持久化验证**（第一优先级） |
| `npm run self-check` | 非交互自检：打开页面 → 等 SPA 挂载 → 选择器自检 → 报告 + DOM 指纹 → 自动截图 → 自动退出 |
| `npm run test:ask` | 快捷问答面板端到端实测（**会真的发一句「只回复两个字：收到」**，测完可以在历史里删掉） |
| `npm run probe:chat` | 打开一个历史会话，dump 回复的 DOM 结构，并让注入层用真实解析逻辑读一遍（站点改版后调解析时用） |
| `npm run check` | 静态自检：JS 语法 / JSON / HTML 引用，不启动 GUI |
| `npm run icon` | 重新生成应用图标 |
| `npm run dist` | electron-builder 打包 |

> **改名的说明（v0.2.0）**：项目原名 `DeepSeek Desktop`，现名 **ChatShell**。
> 改名有个副作用 —— `app.getPath('userData')` 是按应用名推导的，而**登录态就在那个目录里**。
> 所以启动时会自动把 `%APPDATA%/DeepSeek Desktop` 迁移到 `%APPDATA%/ChatShell`
> （只跳过缓存目录，`Partitions/`、`Local Storage/`、`Network/`、`Local State` 一个不少，
> 尤其 `Local State` 存着 cookie 的加密密钥，丢了就要重新登录）。
> 旧目录**不会被删除**，确认一切正常后你可以自己删掉。
>
> 以后再想改名：改 `package.json` 的 `productName`，把旧名字加进 `src/main/branding.js`
> 的 `LEGACY_APP_NAMES`，其余不用动。

> **`electron` 启动报 `Cannot read properties of undefined (reading 'commandLine')`？**
> 说明环境里有 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 被当成纯 Node 跑了。
> 所有 npm 脚本都走 `scripts/launch.js`，它会在拉起子进程前清掉这个变量，所以不会踩到。

---

## ① 第一件事：验证登录态能留住

这是整个项目**唯一真正决定成败的地方**。别急着加功能，先跑这个：

```bash
npm run verify:login
```

它会做两件事：

1. 启动时打印 `partition` / 存储目录 / cookie 数 / 疑似登录凭证 / localStorage 键数
2. 退出前再打印一次，方便和启动时对比

输出同时写在 stdout 和 `%APPDATA%/ChatShell/chatshell.log`（双击 exe 启动看不到控制台，所以必须落文件）。

**判定标准**：

```
第一次跑：cookie 数可能是 0（还没登录）
  → 在弹出的窗口里正常登录
  → 完全退出：托盘图标右键 → 退出（不是点 ✕，点 ✕ 只是收进托盘）
  → 再跑一次 npm run verify:login
第二次跑：cookie 数 > 0 且「疑似登录凭证」不为空  ✅ 登录态留住了
                    两次都是 0                  ❌ 回来查 partition
```

正常输出长这样：

```
[verify] partition      : persist:deepseek
[verify] 存储目录        : C:\Users\...\AppData\Roaming\ChatShell\Partitions\deepseek (存在=true)
[verify] cookie 总数     : 7 / deepseek 域: 7
[verify] 疑似登录凭证    : intercom-session-xxx, ds_session_id
```

### 关于登录态，代码里刻意没做这些事

| 没做 | 原因 |
| --- | --- |
| `session.clearStorageData()` | 调一次就每次启动都要重新登录 |
| `cookies.remove()` | 同上 |
| 任何无痕式逻辑 | 同上 |
| 非 `persist:` 的 partition | 不落盘 |

`src/main/index.js` 里的 `setupPartition()` 对此有明确注释，改代码时别踩。

---

## 功能

### 快捷启动（小窗口形态）

默认就是一个**紧凑小窗口**（480×700，置顶），热键唤出即用 —— 不是大窗口，也不是随时要去找的普通窗口。

- **全局热键呼出 / 隐藏**：默认 `Alt+Space`（Spotlight 手感）
  - Windows 上 `Alt+Space` 是「窗口系统菜单」，可能注册失败 → 自动按 `Alt+Shift+Space` → `Control+Alt+Space` → `F9` 依次回退
  - **托盘菜单里显示的是实际生效的组合键**（不是配置值），避免「我明明设了却没用」
  - 唤出时如果窗口被最大化过，会先还原成小窗口再显示
- **停靠位置**：还没被拖过时，每次启动都自动停在「鼠标所在那块屏幕的上方居中」。拖一次之后就记住你的位置
- **拖动窗口**：按住标题栏任意空白处拖（见下面的实现说明）
- **窗口置顶**：默认开启。标题栏 ⌖ 按钮或托盘菜单可关
- **紧凑 ⇄ 展开**：标题栏 ⤢ 按钮，或托盘「紧凑小窗口」。
  两档尺寸分开记，来回切不丢尺寸；展开时如果会被屏幕右边切掉，位置会在收起时自动还原，不会一路往左漂
- **托盘常驻**：点 ✕ 默认只是收进托盘，热键随时唤回
- **开机自启**：默认开启；托盘菜单「开机自启」可随时取消（走 `app.setLoginItemSettings`）
- **单实例锁**：第二次双击图标不会开新进程，而是把已有窗口拉出来
- **窄窗口自动精简标题栏**：宽度 < 640px 时收起 Tab 条和前进/后退/刷新，改显示当前会话标题（小窗口里位置比按钮密度值钱）

### 会话

- **多会话 Tab**：`Ctrl+T` 新会话 / `Ctrl+W` 关 / `Ctrl+Shift+T` 恢复 / `Ctrl+Tab` 切换 / 中键关闭
  - 紧凑窗口下 Tab 条是隐藏的（位置不够），用 `Ctrl+Tab` 切、`Ctrl+T` 新建；展开后 Tab 条自动出现
- **多窗口**：`Ctrl+Shift+N`，新窗口共用同一个 partition，登录态共享
- **自绘标题栏**：40px，比原生省一截垂直空间；双击空白处最大化
- **页面缩放**：`Ctrl+滚轮` 或托盘「缩放」

### 窗口拖动是怎么实现的

**没有用** CSS 的 `-webkit-app-region: drag`，而是 JS 接管：

- 按下时记下「鼠标屏幕坐标 → 窗口左上角」的偏移，移动时用 `屏幕坐标 - 偏移` 反算位置
- 用**偏移**而不是逐帧增量，避免误差累积；用 `setPointerCapture`，鼠标移出标题栏也不会断
- 用 `requestAnimationFrame` 把每秒上百次 `pointermove` 合并成每帧一次

原因：`-webkit-app-region` 依赖 Electron 对 `WebContentsView` 的拖拽区支持，行为不好验证也不好测（没法用脚本回归）。JS 接管是确定可用的，而且顺手能记录位置。

自检里的「窗口交互自检」会合成一串 `PointerEvent` 端到端跑一遍，直接断言窗口位移是否**精确等于**鼠标位移 —— 所以这个功能是有自动回归的，不靠肉眼。

### Prompt 模板库

- 热键 `Ctrl+Alt+P`，或标题栏「提示词」按钮
- `↑↓` 选择 / `Enter` 填充并发送 / `Ctrl+Enter` 只填入不发送 / `Ctrl+N` 新建 / `Esc` 关闭
- 托盘菜单「Prompt 模板」子菜单同样可直接发送
- 存在 `%APPDATA%/ChatShell/prompts.json`，可以直接编辑

### 快捷问答面板（Cherry Studio 那种小助手）

热键 `Ctrl+Shift+Space`（可在 config.json 改 `quickAskHotkey`），或托盘「快捷问答」。

```
┌──────────────────────────────────────────────────┐
│ ✦  问点什么… Enter 发送 · Shift+Enter 换行  新会话 展开│
├──────────────────────────────────────────────────┤
│ 给我讲讲事件循环                                   │  ← 你的问题
│                                                   │
│ ▸ 思考过程                       ← 可折叠（默认收起）│
│   事件循环是……  缩进 + 左边线 + 灰底 + 更小的字       │
│                                                   │
│ ## 事件循环                                      │  ← 正文，Markdown 渲染
│ 1. 调用栈清空后……                                │
│ ┌────────────────────────┐                        │
│ │ js            setTimeout(() => {}, 0) │         │  ← 代码块带语言角标
│ └────────────────────────┘                        │
│ ────────────────────────────────                  │
│ 给我举个实际例子                                   │  ← 第二轮，多轮有上下文
│ ▸ 思考过程                                        │
│ 用户在问……                                        │
├──────────────────────────────────────────────────┤
│ ESC 关闭   C 复制回答                              │
└──────────────────────────────────────────────────┘
```

- **Markdown 渲染**：标题、列表、表格、引用、行内码、代码块（带语言角标）按格式显示。
  渲染器是零依赖的 `src/renderer/md.js`（约 200 行）—— 面板的 CSP 是 `script-src 'self'`
  引不了 CDN，而内容来自外部，所以流程是「**先整体转义，再按白名单加标签**」，
  任何原始 HTML 都会被转义（自检里有一条专门的 XSS 转义断言）。
- **思考过程单独渲染 + 可折叠**：读的是站点的 `.ds-think-content`（推理原文，不含「已思考（用时 N 秒）」那句折叠头），
  视觉上和正文刻意拉开距离。生成中自动展开让你看到进度，正文一出来自动收起；
  **你手动开合过之后就不再自动动它**（免得你正读着被折叠）。
- **多轮对话 + 独立会话**：面板会**自己新开一个会话标签**，不占用你正在聊的那个
  —— 否则面板的问题会插进你的对话里。多轮之间有上下文记忆；关掉面板再打开对话还在；
  想重开就点「新会话」。这个会话一直保留到退出应用，内容同时落在 DeepSeek 历史里随时能找回来。
- 居屏幕偏上、水平对齐主窗口中心呼出；无边框、圆角、置顶；`Enter` 发送，`Shift+Enter` 换行，`Esc` 关闭
- **按住顶部输入条可拖动面板**（在输入框或按钮上按下不会误触发拖动）
- 焦点不在输入框时按 **`C`** 复制答案（复制的是 **Markdown**）
- 「展开」按钮关掉面板并把主窗口拉出来 —— 会话就在那个标签里，可以直接接着聊
- **面板永远是主窗口的 owned window**（创建时挂 `parent`）。主窗口和面板都是置顶窗口、位置又高度重叠，
  如果靠「谁最后激活谁在上层」抢层级，就会出现「点面板实际点到主窗口，主窗口抢走焦点后把面板 blur 关掉」——
  看起来就是面板完全点不动。owned window 由系统保证绘制在 owner 之上，从根上避免这个竞争。
  拖动也是 JS 接管（不用 `-webkit-app-region`），因为拖拽区一旦盖住输入框就没法用脚本回归验证。

> **读回复的方式**（站点改版时最先坏的就是这里）：正文取 `.ds-assistant-message-main-content`，
> 思考取 `.ds-think-content`，两者都在 `.ds-message` 这个「一轮」容器里。
> 早期用「`[class*='markdown']` 取最后一个」是错的 —— 全页这类元素有 90 个，
> 大多是碎片（代码块外壳的文本只有 8 个字），面板会只显示出 `-` 和 `34`。
> 跑 `npm run probe:chat` 可以拿真实会话验证解析是否还对。

**它和「另做一个 API 客户端」的区别**：面板只是一层薄 UI，问题和答案仍然走**已登录的网页版**。

| | 本方 | 直接调 API |
| --- | --- | --- |
| 登录 / 额度 | 复用网页版，零配置 | 需要 API key，另算费用 |
| 会话历史 | 自动落在 DeepSeek 历史里 | 独立存储 |
| 模型能力 | 和网页版完全一致（深度思考、联网搜索都在） | 取决于 API 是否开放 |

**怎么知道答案生成完了？** 不看站点的按钮状态（那是脆的），而是看**文本是否停止变化**——
最新回复 1.5 秒内不再变化就判定生成完毕。这个判据与站点改版无关，是最稳的做法。
面板里的交互自检（`npm run test:ask`）会真实发一句问题跑完整条链路并打印阶段耗时：

```
阶段变化: sending@0s → generating@0.4s → done@2.8s
回答内容(前 200 字): 收到
```

### 站点改造（注入层）

- **紧凑模式**：细滚动条 + 去掉回复块外层留白
- **隐藏无关元素**：下载 App 入口、公告条
- **隐藏左侧栏**：默认开（窄窗口下站点本来就不渲染侧栏，所以无副作用；展开档下才有意义）
- **Ctrl+Enter 发送**：capture 阶段拦截，`isComposing` / `keyCode === 229` 时直接放行，**中文输入法组字状态下绝不吞 Enter**
- **复制最新回复为 Markdown**：**右键菜单**「复制最新回复为 Markdown」。从**渲染后的 DOM** 读，不碰网络
- **页内悬浮条**（`MD` / `新的` / `重载`）：**默认关闭**。实测它会压在正文上（思考过程那一段直接被盖住），
  而且快捷问答面板已经覆盖了这些场景。想要的话到托盘「注入」里打开

每个开关都能在托盘「注入（站点改造）」子菜单里单独关掉，关掉后主功能照常可用。

---

## 站点改版了怎么办

DOM 选择器是最脆的部分。所以设计上把所有选择器集中在 **一个文件**：

```
src/inject/selectors.json
```

每一项都是**候选数组**，按顺序尝试，命中即用，全都没命中就静默跳过。改这一个文件即可，不用碰代码（CSS 里的 `{{sidebar}}` 这类占位符也是从它渲染的）。

出问题时的排查流程：

```bash
npm run self-check
```

它会打开页面、跑一遍自检、自动退出，报告写在：

- `%APPDATA%/ChatShell/self-check.txt` —— 人看的
- `%APPDATA%/ChatShell/selector-report.json` —— 机器看的
- `self-check-chrome.png` / `self-check-site.png` —— 顺手截的图（标题栏 + 页面）。
  排查「小窗口下标题栏挤成一团」「注入的悬浮条挡住按钮」这类问题时，有图比描述快得多
  （无 GPU 的环境下站点截图可能是空白，标题栏那张不受影响）

自检还会做一次**窗口交互自检**，用合成的 `PointerEvent` 端到端验证拖拽和紧凑切换：

```
窗口交互自检:
  - 置顶 = true
  - 拖拽 位移(80,40) 期望(80,40) ✅
  - 紧凑切换 展开档=false 展开后=1181×821 切回后=481×701 期望=480×700 ✅
```

这类靠鼠标才能触发的功能人工很难回归、也不好远程描述「到底哪里坏了」，所以做成自动断言。
（跑这段时会临时关掉几何持久化，不会把你的窗口位置和尺寸弄乱。）

报告长这样：

```
✅ composer
     ·   1 × textarea#chat-input
      0 × #chat-input
✅ sendButton
     ·   1 × div[role='button'][aria-label*='发送']
❌ sidebar
      0 × aside
      0 × [class*='sidebar']
              ^^^ 挂掉的是这组，去 selectors.json 改它

---- DOM 指纹（改 selectors.json 时照抄这里）----
textarea（1）
     #chat-input .ds-scroll-area  placeholder="给 DeepSeek 发送消息"
可见按钮（3）
     aria="发送" title="" text="" .ds-icon-button
高频 class token（60）
   42 × ds-markdown
   18 × ds-icon-button
```

**「DOM 指纹」是重点**：它把页面上真实存在的 `textarea` / `contenteditable` / 按钮标签 / 链接 / 高频 class 全列出来，改选择器时直接照抄，不用猜、不用开着 DevTools 一个个翻。

运行中也可以随时自检：**托盘菜单 → 「选择器自检」**，或点标题栏的 ◍ 按钮。

### 命中 0/8 有三种完全不同的原因，报告会帮你区分

自检不会让你瞎猜。它会先判断页面处在哪种状态，再决定要不要让你去改选择器：

| 页面状态 | 报告表现 | 该做什么 |
| --- | --- | --- |
| **风控拦截页** | 顶部红字 `⚠⚠⚠ 检测到「风控拦截页」，本次选择器结果无效`，并列出命中特征和页面内容片段 | 别改 selectors.json。先解决拦截（见上文 UA 一节） |
| **登录页** | `ℹ 当前停在「登录页」，不是聊天页` | 正常。先登录，再跑一次自检 |
| **真的改版了** | 正常报告，某一组标 ❌，其余 ✅ | 照 DOM 指纹改 `selectors.json` 那一组 |

自检还会等 **SPA 真正渲染完**（轮询 `#root` 是否挂载），而不是 `did-finish-load` 后写死 sleep —— 后者会在页面还没渲染时就去查选择器，必然全落空，误导性极强。

### 选择器有两层兜底

1. **候选数组**：`selectors.json` 里每项是一组选择器，按序尝试。实测确认 DeepSeek 用的是 `ds-` 前缀设计系统（`.ds-button` / `.ds-a--link` 等），所以 `ds-*` 候选都放在靠前位置。
2. **文本兜底**：某些按钮没有稳定 class（登录页的按钮就不带 `aria-label`），可以在该组里加 `textKeywords`：

```json
"newChat": {
  "textKeywords": ["新对话", "开启新对话", "New chat"],
  "selectors": ["..."]
}
```

选择器全落空时，按可见文本 / `aria-label` 模糊匹配。匹配规则是两轮：先**完全相等**（长文案也认），再**包含**（但只接受 ≤4 字的短标签，避免「发送验证码」被误当成「发送」按钮）。自检报告里会额外输出一行 `text:关键词` 的命中情况。

另外：输入框和发送按钮还有一层**代码级**兜底 —— 输入框找不到时退化为「页面上最后一个可见的 textarea / contenteditable」，发送按钮退化为「`aria-label` 含发送且不是停止/重新生成/复制的那一个」，最后直接派发 Enter。所以即使 `selectors.json` 全过期，发 Prompt 一般还是能用。

### ⚠ 写隐藏规则的三条铁律（真实踩出来的白屏事故）

2026-09-17 出过一次**整页纯白**的故障，根因非常隐蔽，写在这里避免重蹈覆辙：

> 开关类名 `ds-hide-sidebar` 被加在 `<html>` 上，而 sidebar 的选择器里有 `[class*='sidebar']`。
> **这个类名属性值本身包含 "sidebar"** → 规则匹配到了 `<html>` 自己 → 一条 `display:none !important` 把整页清空。
> `document.documentElement` 的 `display` 变成 `none`，页面全白，且看不到任何报错。

同时暴露的第二个问题：`html[data-...] {{sidebar}}` 这种写法**只对候选列表的第一个选择器生效**，
逗号后面的候选会退化成「无条件生效」——同样危险。

所以现在必须满足：

1. **开关状态用 `data-*` 属性，不用 class**。属性值不会被 `[class*=...]` 命中。
2. **候选列表必须用 `:is(...)` 整体包裹**，保证门禁作用于每一个候选：
   ```css
   html[data-cs-inject='on'][data-cs-hide-sidebar='on'] :is({{sidebar}}):not(html):not(body) { ... }
   ```
3. **隐藏类规则一律加 `:not(html):not(body)` 兜底**，无论选择器怎么改都不可能藏掉文档根节点。

再加一层自愈：注入层贴完开关后会检查 `<html>` 的 `display`，一旦发现被隐藏就**自动回滚全部注入开关**并写日志 —— 用户宁可少几个功能，也不能面对一片白屏。

自检报告里对应新增了 **`selfHidden` 断言**（检查 html/body/#root 是否被隐藏、尺寸是否为 0），
这类问题会被直接点名，不用再靠用户报「白屏」。截图分析也会把「全白」标出来而不是静默存图。

---

## 两条刻意没碰的红线

**1. 不拦网络请求伪造「本地聊天记录」**
聊天记录就是脆，而且容易被判定异常。`MD` 按钮是从渲染后的 DOM 读文本再转 Markdown，全程不碰网络层。

**2. 不触发风控**

- 不追加 `--enable-automation`，反而在启动时 `removeSwitch('enable-automation')`
- 不注入 `navigator.webdriver`（`self-check` 报告里会明确输出它的值，**必须是 false**）
- **UA 必须抹掉 Electron 特征** —— 见下一节，这是实测踩出来的，不是猜的
- 不拦网络请求改写响应

另外没做的：多账号轮询、绕过限流。个人自用没问题，对外分发或商用请自行评估服务方用户协议。

---

## ⚠ 关于 UA：一次实测出来的拦截

这是这个项目最容易踩、也最难自己诊断的一个坑，单独拎出来说。

**现象**：应用打开就显示一页 `Error - Request Blocked` / `Rate Limit Reached`，带 `Event ID: 30-clou-...`，DOM 只有十几个元素，所有选择器都命中不了 —— 看起来像「站点改版了」，其实是**请求在边缘节点就被拦了**。

**实测（同一 IP、同一时刻、同一个 curl 客户端，只换 UA 字符串）**：

| # | UA | sec-ch-ua 里带 Electron | 结果 |
| --- | --- | --- | --- |
| A | 干净 Chrome UA | 无 | **200 真实页面** |
| D | 干净 Chrome UA | 干净 | **200 真实页面** |
| E | 干净 Chrome UA | **带 Electron** | **200 真实页面** |
| G | 干净 Chrome UA（复现） | 无 | **200 真实页面** |
| H | **Electron 默认 UA** | 无 | **429 拦截页** |

结论：

- **不是 IP 限流**（同 IP 的 curl 用 Chrome UA 稳定 200）
- **不是 `sec-ch-ua` 请求头**（带上 Electron 也照样 200）—— 所以完全不需要去改写请求头
- **唯一决定因素就是 UA 字符串里的 `Electron/44.4.1` 和 `DeepSeekDesktop/0.1.0`**

**修法**（`src/main/useragent.js`，默认已开启）：

```
Electron 默认：
  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
  DeepSeekDesktop/0.1.0 Chrome/152.0.7977.78 Electron/44.4.1 Safari/537.36
                                                    ↑ 这两个 token 就是元凶

chrome 模式（默认）：
  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
  Chrome/152.0.0.0 Safari/537.36
  ↑ 抹掉非标准产品 token，并按 Chrome 的 UA 缩减规则压成 major.0.0.0
    最终与同平台真实 Chrome 逐字节一致
```

两个细节值得注意：

1. **不能只删 token**。真实 Chrome 自 2023 起做 UA 缩减，桌面端只上报 `major.0.0.0`；如果留着完整 build 号 `152.0.7977.78`，本身又是一个异常特征。
2. **别照抄网上那种硬编码 `Chrome/122.0.0.0` 的写法**。版本号对不上 Chromium 真实版本，比不改更容易被识别。这里是从 `app.userAgentFallback` 推导的，Chromium 升级时会自动跟上，并且平台（Windows/macOS/Linux）也保持真实。

想临时对比验证，不用改配置文件：

```bash
npm start -- --user-agent-mode=default     # 保留 Electron UA（复现拦截）
npm start -- --user-agent-mode=chrome      # 干净 Chrome UA（默认）
```

自检报告里会打印生效 UA，并且一旦发现 UA 里还有 `Electron/` 或应用名 token 就会直接告警。

---

## 配置

`%APPDATA%/ChatShell/config.json`（只存被改过的值，缺失项用 `src/main/defaults.js` 兜底）：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `hotkey` | `Alt+Space` | 呼出/隐藏，注册失败会按 `hotkeyFallbacks` 回退 |
| `promptHotkey` | `Control+Alt+P` | 唤起 Prompt 模板库 |
| `quickAskHotkey` | `Control+Shift+Space` | 唤起快捷问答面板 |
| `autoLaunch` | `true` | 开机自启 |
| `hideToTrayOnClose` | `true` | 点 ✕ 收进托盘而不是退出 |
| `startMinimized` | `false` | 启动直接进托盘 |
| `alwaysOnTop` | **`true`** | 窗口置顶（小窗口唤出即用，不希望被盖住） |
| `theme` | `system` | `system` / `light` / `dark` |
| `zoomFactor` | `1` | 缩放 |
| `window.compact` | `true` | `true` 紧凑小窗口 / `false` 展开 |
| `window.compactSize` | `480×700` | 紧凑档尺寸（用户缩放后写回这里） |
| `window.expandedSize` | `1180×820` | 展开档尺寸 |
| `window.x` / `window.y` | `null` | `null` = 还没拖过，每次启动自动停靠；拖过之后写死实际坐标 |
| `userAgentMode` | `chrome` | **`chrome`** 抹掉 Electron/应用名 token 并做 UA 缩减（必须，见上文）；`default` 保留 Electron 原生 UA |
| `userAgent` | `""` | 填了就优先用它（最后手段） |
| `proxy` | `""` | 留空时自动读 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量 |
| `injection.hideSidebar` | **`true`** | 隐藏左侧历史会话栏（小窗口放不下） |
| `injection.*` | 见上 | 注入层其它开关 |
| `site.partition` | `persist:deepseek` | **别改** |

**想恢复某项默认行为？直接删掉那个键就行**，不用去查默认值是多少 —— 文件里只有你显式改过的值。

`window.x/y` 写成 `null` 就等于「忘掉位置，下次自动居中」。

**代理**：Chromium 默认不认 `http_proxy` 环境变量，公司网络下会莫名其妙加载失败。这个壳会自动读环境变量，也可以显式配置：

```bash
npm start -- --proxy=http://127.0.0.1:7890
```

---

## 目录结构

```
src/
    main/                    主进程
    index.js               入口：单实例锁、启动流程、session/代理/权限/UA
    window-manager.js      BaseWindow + chromeView + 站点 WebContentsView、Tab、外链拦截、快捷键
    useragent.js           ★ UA 策略（抹 Electron 特征 + Chrome UA 缩减）
    config-migrate.js      配置迁移（默认值变更后回收被固化的旧值）
    tray.js                托盘菜单、开机自启
    shortcuts.js           全局热键（含注册失败回退）
    palette.js             Prompt 调色板窗口
    quickask.js            ★ 快捷问答面板（薄 UI + 读站点渲染后的答案）
    injection.js           注入层主进程侧（选择器/CSS 下发、自检、拦截页识别）
    verify.js              登录态验证
    selfcheck.js           非交互自检（含 SPA 渲染等待、拦截页判定）
    ipc.js                 所有 IPC 通道
    store.js               配置持久化（只写与默认值的差异）
    paths.js / log.js / defaults.js
  preload/
    site-preload.js        ★ 注入层本体（自包含，容错）
    chrome-preload.js      标题栏桥
    palette-preload.js     调色板桥
  inject/
    selectors.json         ★ 站点改版只改这里
    inject.css             样式（{{占位符}} 从 selectors.json 渲染）
  renderer/
    chrome.html/.css/.js   自绘标题栏
    palette.html/.css/.js  Prompt 调色板
    quickask.html/.css/.js 快捷问答面板
    error.html/.js         加载失败兜底页
scripts/
  launch.js                启动器（清 ELECTRON_RUN_AS_NODE）
  make-icon.js             纯 Node 生成图标
  syntax-check.js          静态自检
```

---

## 打包

```bash
npm run dist      # 输出到 release/
npm run pack:dir  # 只出目录，方便快速验证
```

Windows 出 NSIS 安装包 + 免安装 portable 版，macOS 出 dmg，Linux 出 AppImage。

---

## 故障排查

| 症状 | 原因 / 处理 |
| --- | --- |
| **页面一片白，只有标题栏有内容** | 注入层的某条隐藏规则命中了 `<html>`。**已在 2026-09-17 修掉**（根因：开关类名 `ds-hide-sidebar` 加在 `<html>` 上，而选择器里有 `[class*='sidebar']`，属性值自己包含 "sidebar" → 规则匹配到 `<html>` → 整页 `display:none`）。现在的防线是：开关走 `data-*` 属性、候选列表用 `:is(...)` 整体包裹、隐藏规则一律加 `:not(html):not(body)`，再加一层「发现 `<html>` 被隐藏就自动回滚注入」的自愈。自检报告里新增了 `selfHidden` 断言，这类问题会被直接指出来 |
| **快捷问答面板「点什么都没反应」** | 两个已知成因，都已在 2026-09-17 修掉：① 面板和主窗口抢 z-order（主窗口更靠上 → 点面板实际点到主窗口 → 面板被 blur 关掉）→ 改为 owned window；② 渲染脚本启动时抛错（`hint-title` 只有 class 没 id），把同一次调用里的 `focusInput()` 一起带走 → 加 `safeRender()` 兜底 + 「渲染脚本已就绪」断言。**排查顺序**：看日志里有没有 `[面板控制台]` 报错 → 跑 `npm run self-check`，它会断言面板的层级、桥、焦点和拖拽 |
| 页面显示 `Rate Limit Reached` / `Request Blocked`（带 Event ID，DOM 只有十几个元素） | **不是限流，是 UA 被识别**。见上文「关于 UA」。确认 `config.json` 里 `userAgentMode` 是 `"chrome"`（或直接删掉这个键，跟随默认值） |
| 每次启动都要重新登录 | `site.partition` 被改成了非 `persist:` 前缀；或者代码里有人调了 `clearStorageData`。跑 `npm run verify:login` |
| 热键按了没反应 | `Alt+Space` 被系统或别的软件占了。看日志里「呼出热键生效: xxx」，或到 `config.json` 改 `hotkey` |
| `Cannot read properties of undefined (reading 'commandLine')` | 环境里有 `ELECTRON_RUN_AS_NODE=1`。用 `npm start`（走 `launch.js`），别直接 `electron .` |
| 自检停在「登录页」，命中 0/8 | 正常 —— 还没登录。先在窗口里登录再跑自检 |
| 自检显示某组 ❌ 但页面正常 | 站点改版了。照报告里的 DOM 指纹改 `src/inject/selectors.json` |
| 复制按钮 / 新对话点了没反应 | 同上；另外 `newChat`/`sendButton` 组支持 `textKeywords` 按文本兜底，可以往里加关键词 |
| 页面加载不出来（非 429） | 网络问题。公司网络配 `proxy`，或 `npm start -- --proxy=http://127.0.0.1:7890` |
| 注入层整个挂掉 | 不该发生 —— 每个入口都是 `try/catch` + 选不到就 `return`。真挂了也只是少几个功能，主功能照常 |
| 点站内链接弹出裸窗口 | 不应该。非 `deepseek.com` 的链接都被 `setWindowOpenHandler` 丢给系统浏览器了 |
| 改了 `defaults.js` 的默认值却不生效 | 检查 `config.json` 里是否有同名键 —— 有就是显式值覆盖了默认值。删掉那个键即可（`config.json` 只存差异，不该出现全量配置） |
| 窗口每次启动都比上次大一点点 | 分数 DPI（如 175%）下 `getBounds()` 比请求值大 1~3px，被存进配置后就成了棘轮。已在 v5 迁移里修掉（差值在容差内就存「请求值」而不是「实测值」）。要是又遇到，删掉 `window.compactSize` 即可 |

日志：`%APPDATA%/ChatShell/chatshell.log`（托盘菜单「打开日志」）。

---

## 已知边界

- 选择器按 DeepSeek 当前前端结构编写。`ds-*` 前缀和按钮/链接的 class 命名是 **2026-09 在未登录状态下实测采集**的，所以 `composer` / `sendButton` / `assistantMessage` 三组建议登录后跑一次 `npm run self-check` 复核。
- 输入框和发送按钮有代码级通用兜底（见上文），`selectors.json` 过期时发 Prompt 一般仍可用。
- `config.json` **只存与默认值的差异**（不是全量配置）。所以想恢复某项默认行为，直接删掉那个键就行，不用查默认值是多少。改动默认值记得同步更新默认值就行。
- 主题跟随系统；站点自身的深色模式独立于外壳。
