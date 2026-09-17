'use strict';

/**
 * 启动器。
 *
 * 为什么需要它：如果环境里存在 ELECTRON_RUN_AS_NODE=1（某些 Electron 宿主 / IDE
 * 的集成终端会设置它），electron.exe 会退化成纯 Node 进程，于是：
 *   require('electron') 返回一串可执行文件路径而不是 API
 *   → 报 "Cannot read properties of undefined (reading 'commandLine')"
 * 这个错误非常难懂。这里统一在拉起子进程前把它清掉。
 *
 *   npm start / npm run dev / npm run verify:login / npm run self-check 都走这里。
 */

const { spawn } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let binary = require('electron');
if (typeof binary !== 'string') {
  // 万一已经在 Electron 里跑了（返回对象而不是路径），退回到 node_modules/.bin
  binary = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
}

const appDir = path.resolve(__dirname, '..');
const child = spawn(binary, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('error', (err) => {
  console.error(`[launch] 启动 Electron 失败: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code == null ? 0 : code);
});
