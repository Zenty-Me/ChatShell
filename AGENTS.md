# ChatShell 开发协作规范

适用于本仓库的开发、审查、测试和交付。先核对当前实现、工作区状态与用户授权，再执行任务。本文是工作约定，不代表用户已经授权提交、推送、删除分支或发布；当前会话中的明确要求优先。

## 项目定位与技术栈

ChatShell 是网页版 AI 的 Electron 桌面外壳，当前适配 DeepSeek。主窗口承载官方站点，复用本地持久化登录态；快捷问答和分支追问通过独立后台页面投递问题、读取站点渲染后的回答，不要求用户配置模型 API key。

- 使用 npm、CommonJS JavaScript、原生 HTML/CSS；没有 npm workspaces、React、TypeScript、Fastify 或本地数据库服务。
- 依赖版本以 `package-lock.json` 为准，修改前同时查看 `package.json` 和锁文件。当前锁定 Electron 44.4.1、electron-builder 26.15.3、esbuild 0.28.2；Markdown 处理复用 marked、DOMPurify、turndown 及 GFM 插件。
- 开发环境使用 Node.js 22.12.0 或更新的兼容版本及 npm；当前发布工作流使用 Node.js 22。不要照搬其他项目的 Node.js 24、Python、数据库扩展或前端构建要求。
- 应用启动后打开桌面窗口，没有固定的本机 Web 服务端口或 `/api/health`。浏览器页面验证不能替代 Electron 窗口、preload 和 IPC 的实际验证。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/main/index.js` | 应用启动、单实例锁、session、代理、生命周期与组件装配 |
| `src/main/window-manager.js` | BaseWindow、WebContentsView、多窗口、标签页、导航与窗口几何 |
| `src/main/ipc.js` | 主进程 IPC 注册与消息路由 |
| `src/main/quickask.js` | 快捷问答及分支共用的小窗、独立后台页面、多轮问答状态 |
| `src/main/branch-ask.js` | 分支来源识别、分支复用、窗口及后台消息归属、来源关闭后的清理 |
| `src/main/injection.js` | 选择器配置与注入 CSS 的加载、下发及诊断 |
| `src/main/defaults.js`、`store.js`、`config-migrate.js` | 默认配置、差异持久化、已有配置迁移 |
| `src/main/paths.js`、`branding.js`、`useragent.js` | 数据路径、旧应用数据迁移、统一 UA 策略 |
| `src/preload/` | 隔离世界桥接；`site-preload.js` 实现站点 DOM 交互与回答读取 |
| `src/inject/selectors.json`、`inject.css` | 站点选择器与可关闭的注入样式 |
| `src/renderer/` | 标题栏、Prompt 模板、快捷问答和错误页的原生 HTML/CSS/JS |
| `scripts/` | 启动、preload 构建、静态检查、分支集成测试与图标生成 |
| `docs/` | 设计说明；已有设计文档位于 `docs/superpowers/specs/` |
| `build/` | 受版本控制的图标等打包输入 |
| `dist/`、`release/` | preload bundle 与安装包等生成产物，不手改、不提交 |
| `.github/workflows/release.yml` | Windows 构建与 GitHub Release 发布工作流 |
| `.codex/development-skills.md` | 本工作区允许自动使用的开发技能目录 |

运行期用户数据位于 `app.getPath('userData')`，Windows 通常是 `%APPDATA%/ChatShell/`，不在仓库内。路径定义集中在 `src/main/paths.js`。

## 技能与文档检索

- 选择技能前先读取 `.codex/development-skills.md`，只在任务受益时加载所选技能的 `SKILL.md`，遵循其流程并说明正在使用。该目录未列出的技能禁止自动发现或加载，除非用户明确要求或修改本策略；学术、办公文档、个人知识库和业务运营工作流不因关键词命中而自动启用。
- `.codex/config.toml` 已关闭完整自动技能目录，按本地开发目录选择技能。保持已安装技能目录和全局 Codex 设置不变；修改它们需要对应的用户授权。规则中不绑定个人用户名、盘符或插件缓存版本，按当前会话提供的位置定位技能。
- 用户显式调用 `$grill-me` 时，先读取已安装的 `grill-me/SKILL.md`。其调用 `grilling` 的要求表示加载对应技能；没有名为 `Skill` 的工具时，直接读取并遵循已安装的 `grilling/SKILL.md`。默认位置为 `~/.agents/skills/grill-me/SKILL.md` 和 `~/.agents/skills/grilling/SKILL.md`；不得修改这两个上游目录。
- 前端页面、组件、布局、字体、配色、间距、圆角和动效设计统一使用用户指定的 `landing-page-design`。实施设计前先定位并读取该技能；若当前目录或会话未提供，报告缺失并取得可用路径或替代方案，不静默改用其他设计技能、不自行安装。此次指定允许为设计任务查找该技能，不改变其他技能的范围限制。
- 复用 grill-me 已确认的需求。项目当前没有 `openspec/`；已有 OpenSpec change 时把必要设计决策写入该 change，否则使用现有 `docs/` 设计文档。只有用户要求引入 OpenSpec 时才初始化，不将其他项目的流程目录视为已经存在。
- 涉及外部库的 API、配置或版本差异，先查看实现和锁定版本，再优先调用 Context7 MCP：先 `resolve-library-id`，再 `query-docs`；用户提供完整库 ID 时可直接查询。尽量匹配项目版本；查询工具支持语言参数且需要 TypeScript 示例时使用 `language: "TypeScript"`，本项目默认查 JavaScript 示例。
- Context7 不可用或未覆盖问题时，说明限制并查阅该库官方文档。查询不得携带密钥、个人信息、聊天内容或项目私有代码。纯本地实现核对、文档编辑等不需要外部资料的任务不必调用 MCP。

## 开发命令

所有日常命令在仓库根目录执行。以 `package.json` 当前脚本为准。

| 命令 | 用途与边界 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖，仅在需要安装或恢复依赖时运行 |
| `npm start` | 通过启动器运行桌面应用，启动前按需重建 preload |
| `npm run dev` | 开发模式启动并打开开发者工具 |
| `npm run check` | 检查 JS 语法、JSON 和 HTML 引用，不启动 GUI |
| `npm run build:preload` | esbuild 打包站点 preload 到 `dist/preload/site-preload.js` |
| `npm run test:branch` | 使用本机 HTTP 夹具、隔离 userData 和 partition，验证真实 Electron 分支流程，不调用远端 AI |
| `npm run verify:login` | 验证真实登录态跨重启持久化，会读取用户 session |
| `npm run self-check` | 打开真实站点，自检选择器、窗口交互并输出报告和截图 |
| `npm run probe:chat` | 打开真实历史会话，检查 DOM 与回答解析，输出可能含私人内容 |
| `npm run test:ask` | 真实发送一条测试问题，产生远端会话记录；须在用户授权范围内运行 |
| `npm run icon` | 重新生成打包图标，仅在图标任务中使用 |
| `npm run pack:dir` | 构建 preload 并生成未安装的应用目录 |
| `npm run dist -- --publish never` | 构建本地安装版和便携版等产物，禁止自动上传 |

当前没有 `npm run lint`、通用 `npm run build` 或 `npm test`，不要机械执行其他项目的命令，也不要为了满足模板添加空脚本。

启动使用 `scripts/launch.js`，它会清理子进程环境中的 `ELECTRON_RUN_AS_NODE`；不要通过修改用户全局环境解决此问题。启动前核对是否有旧实例，避免单实例锁导致仍在运行旧代码；退出时注意关闭窗口可能只是隐藏到托盘。不要终止无关 Electron 进程或擅自关闭用户未完成的会话。

Windows 下优先使用 PowerShell 核实命令、路径及 Git 换行问题，再判断是否需要修改文件或工具。GUI 启动、跨工作区写入和受限网络访问遵循执行环境的权限要求，不绕过审批。

## 实现原则（HERO）

- 采用满足当前需求的最小完整改动，优先复用现有窗口、状态、IPC、DOM 解析和成熟依赖。修改共享逻辑前查清调用方，同步受影响的桥接接口、渲染端、测试及说明。
- 不添加没有实际用途的抽象、包装层、feature flag、兼容层、迁移框架、哈希或指纹；现有需求所需的兼容和迁移正常完成。
- 按真实使用方式处理边界，报告罕见但可达的问题，不为纯理论场景扩大范围。保留输入校验、必要错误处理、资源清理、安全边界和可访问性。
- JavaScript 延续 CommonJS、`'use strict'`、两空格缩进、单引号和分号。类使用 PascalCase，函数与变量使用 camelCase；沿用所在文件风格，不做无关的批量格式化或框架迁移。
- 注释解释代码无法直接表达的设计理由。确需接受的限制用 `shortcut: <限制>, <何时升级>` 记录，不添加无关的 AI 署名或草拟过程。

### Electron、注入层与 IPC

- 主进程管理权限、窗口和系统能力；preload 暴露明确且最小的桥接；renderer 只负责界面。保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，不向远程站点暴露任意 Node.js 或 IPC 调用能力。
- 新增或修改 IPC 时校验发送者、frame、目标窗口和载荷类型、长度；分支入口验证来源站点与标签页，后台回答仅路由到所属面板。不把站点发来的字符串当代码或 shell 命令执行。
- 站点 preload 通过 esbuild 内联第三方依赖；修改源码后构建验证，不能只改被忽略的 bundle。新增源码依赖时同时核对启动器的重建判定和打包资源。
- 选择器集中维护在 `selectors.json`，DOM 交互找不到元素时应局部降级。注入失败不能让主页面不可用；新增注入 UI 使用 `cs-` 标记及 `data-cs-ui`，避免污染回答解析。
- 注入开关使用 `data-*`；隐藏规则需要防止误命中 `html`、`body` 和自身标记，保持现有自愈与禁用入口。站点改版时用真实 DOM 证据修选择器，不凭猜测堆叠规则。
- 不拦截或伪造站点网络响应，不修改 `navigator.webdriver` 或绕过登录、验证码与权限限制。UA 兼容集中在已有 `useragent.js`，根据运行时 Chromium 推导，不散落硬编码 UA 或额外请求头伪装。
- Markdown 展示复用 marked + DOMPurify；站点回答、引用、标题均是不可信输入，纯文本使用 `textContent`，不得删除 HTML 消毒、CSP 或外链校验来消除报错。

### 快捷问答与分支追问

- 主会话、普通快捷问答及不同分支分别维护问答状态和后台页面；可共享同站点登录 partition，但不能共享消息状态或把问题发送到主会话。
- 分支首轮携带选中片段及所在回答附近的参考内容，后续使用该分支上下文；保持现有长度校验，不擅自上传整段历史或其他标签页内容。
- 关闭分支小窗应保留其历史与草稿，返回来源标签页，保持主线消息、草稿和阅读位置。后台加载或生成完成不能重新弹出已关闭的小窗抢焦点。
- 当前分支关联保留到来源标签页关闭或应用退出；刷新页面会形成新的关联。不得宣称已支持跨重启恢复、永久树形历史或多层嵌套分支。
- 清理来源关闭、应用退出和后台进程异常时的窗口、监听器及定时器；迟到回包不能写入其他分支或把发送失败覆盖为成功。文本稳定判定有现有局限，超时或未读到新回答时必须诚实显示状态，不使用旧回答冒充本轮结果。

## 验证与交付

- 修改实现后运行 `npm run check`；涉及站点 preload 时运行 `npm run build:preload`；涉及分支、快捷问答共用逻辑或 IPC 时运行 `npm run test:branch`。打包配置、依赖或资源路径变化再按需运行本地打包检查。
- 新增非平凡逻辑补最小有效回归测试或可重复断言，并说明命令；优先复用 Node.js 内置断言、本地夹具与已有 Electron 测试方式，不另装无必要的测试框架，不写仅复述实现的测试。
- 自动化测试使用隔离的临时 userData、session partition 和本机模拟站点；结束后关闭窗口和服务。不得用个人 profile 做变更性测试，不使用真实密钥或真实 AI 请求代替可重复的本地回归。
- UI 变化按影响范围启动 Electron 实测：标题栏与拖拽、多标签页、紧凑/展开、缩放、深浅色、中文输入法、快捷键、滚动、焦点、面板关闭重开。分支变化重点验证选区入口、引用、多轮、互相隔离及返回主线位置；交付附不含私人内容的截图。
- 静态检查和本机夹具不能证明真实站点选择器仍有效。需要真实站点验收时，在用户授权范围内执行，区分已登录、未登录、网络拦截与解析失败；报告真实站点尚未验证的部分。
- 已委派子 agent 的任务，由执行子 agent 提供检查和行为验收证据；主 agent 汇总并核对。未使用子 agent 的任务由执行者验证，不为纯文档编辑额外创建实现或集成工作区。
- 纯文档改动只检查内容、引用、路径、脚本与实际项目的一致性。复用仍有效的结果；没有新变更或疑点时不重复检查。未运行、失败或受阻的检查不得描述为通过。
- 交付说明写清最终行为、必要取舍、验证结果和剩余问题；已提交时提供 commit SHA，已推送时提供目标分支及远端核验证据，未执行的动作明确说明。提交标题简短，使用祈使句；任务记录聚焦改动与验证。

## Git、协作与交付分支

- 开始先查看 Git 状态、当前分支、upstream、远端和 worktree。区分用户已有修改、本任务修改、生成物和其他 agent 的工作；不能覆盖、回滚或顺手提交无关内容，不用 `git add .` 混入不明文件。
- 只有用户或适用规则明确要求委派时才启用子 agent。委派时写清任务、允许修改范围、工作区及交付目标；需要隔离时使用独立 worktree，避免多个 agent 同时编辑相同文件。
- 仅在任务包含提交、集成或推送授权时执行相应动作。交付分支优先采用用户明确指定的目标；否则核对当前分支与 `origin` 的对应关系，仅在指向唯一且属于授权范围时解析目标。不得仅凭 `main`、`master`、默认分支或当前分支名称猜测交付目标；缺少、冲突或非 `origin` 的 upstream 必须先澄清。
- 推送前获取目标远端的最新引用，确认 upstream 与已解析的 `origin/<交付分支>` 一致，检查 `upstream..HEAD` 的全部待推送提交及反向差异，确认没有夹带无关内容或未处理的远端更新。
- 尚无 upstream 时，以已解析的目标远端引用为基线核对，核对通过再建立对应 upstream。目标远端分支尚不存在时，需要有创建该分支的明确授权，并核实已授权基线及全部待交付内容；不能凭空指定基线。
- 核对通过后仅显式推送已解析且获授权的交付分支，不使用 `--all`、`--mirror`、强制推送或 `--force-with-lease`。推送后重新查询目标远端 ref，确认远端包含全部交付提交；不能仅依据本地 upstream 或命令退出码宣称完成。
- 认证、权限、分支保护或并发更新阻塞时报告具体原因，不绕过限制，不擅自改推其他远端或目标分支。
- 普通交付不自动部署或发布。`v*` 标签推送和手动触发 Release 工作流会发布产物，需要单独授权；本地打包使用 `--publish never`。

### 临时分支与 worktree 清理

- 任务已集成到已解析的交付分支并验证通过、远端已包含全部交付内容、无活跃 agent 占用、没有未提交或未集成内容及需保留文件后，由主 agent 明确指定的集成子 agent 清理本任务对应的本地临时分支和 worktree。没有子 agent 的任务由主 agent 在同样约束下处理，不为清理任意创建委派流程。
- 清理前核实准确路径与 ref、提交和实际内容包含关系、工作区状态（包含未跟踪与忽略文件）、关联遗留 PR 和活跃所有者，向主 agent 报告候选清单、保留项及阻塞；普通 `git status` 的干净结果不足以证明忽略目录中没有用户文件。
- cherry-pick 或 squash 后不能只靠祖先关系判断是否集成，需结合补丁等价、目标内容、冲突处理与验证结果核对；仅有提交标题或相似 diff 不足以证明交付完整。
- 既有 agent 创建的远端分支和遗留 PR，仅在用户授权且主 agent 明确委派的范围内清理，不合并遗留 PR。
- 保护根工作区和用户改动。信息不明、存在未集成内容、未跟踪或忽略目录内有需保留文件时保留并上报，不使用 `git worktree remove --force`、`git reset` 或 `git clean` 绕过阻塞。
- Windows 删除或移动目录前，核实解析后的绝对路径位于已核准的临时工作区；使用同一 shell 和原生路径参数操作，不把枚举结果拼接成另一种 shell 的删除命令。
- 主 agent 最终报告功能完成情况、检查结果、commit SHA、已解析交付分支、推送验证结果、临时分支/worktree 清理状态及剩余问题。未创建临时资源时明确说明无需清理。

## 配置与数据安全

- 默认值维护在 `src/main/defaults.js`，用户 `config.json` 只保存与默认值不同的设置。修改默认值需核对既有显式配置与 `config-migrate.js`；不得用全量覆盖、删除配置文件或重置登录态掩盖迁移问题。
- 默认 `site.partition` 是 `persist:deepseek`。同站点窗口共享此登录态；新增其他站点时使用独立 partition。不得擅自修改用户现有 partition、调用 `clearStorageData()`、清 cookie 或删除 profile 让测试通过。
- 改名或迁移用户数据遵循 `branding.js`；登录态相关目录与加密所需的 `Local State` 作为整体保留。备份或恢复前停止对应应用实例；旧目录不自动删除。
- 本项目没有模板项目的 `.env` 加载、`LLM_API_KEY`、SQLite 或上传目录约定；代理沿用当前配置和已支持的环境变量。未实现的能力不得写成已具备，也不为套模板引入新服务。
- cookie、token、用户提示词、聊天记录和带认证信息的代理地址不得写入源码、测试夹具、规范、提交或对外报告。诊断输出、截图与日志可能含私人内容，分享前脱敏；新增日志避免记录完整提问、回答或凭据。
- 提交前检查暂存区，即使文件已被忽略也不能假定绝无敏感内容。不要提交 `node_modules/`、`dist/`、`release/`、`.cache/`、用户 profile 或实际诊断产物；`build/` 中的图标是打包输入，不要当临时文件删除。
- 若 `AGENTS.md` 或本地配置被 `.git/info/exclude` 等规则忽略，应报告其仅在本机生效，不擅自改忽略规则或强制加入版本控制。
