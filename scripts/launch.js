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
const fs = require('fs');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let binary = require('electron');
if (typeof binary !== 'string') {
  // 万一已经在 Electron 里跑了（返回对象而不是路径），退回到 node_modules/.bin
  binary = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
}

const appDir = path.resolve(__dirname, '..');

/* --------------------------------------------------------------------------
 * site-preload 的 bundle 按需重建。
 *
 * preload 引了第三方依赖（turndown），sandbox 下只能加载打包后的单文件，
 * 所以源文件改了就要重新打包。这里对比「源文件 vs bundle」的修改时间，
 * 需要时自动跑一次 —— 开发时改 preload 不用记得手动 build，无感。
 * ------------------------------------------------------------------------ */
const SRC = path.join(appDir, 'src', 'preload', 'site-preload.js');
const BUNDLE = path.join(appDir, 'dist', 'preload', 'site-preload.js');

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return 0;
  }
}

if (mtimeOf(BUNDLE) < mtimeOf(SRC)) {
  try {
    // 用独立子进程跑，esbuild 的报错格式和正常输出一致
    const r = spawn(process.execPath, [path.join(__dirname, 'build-preload.js')], { stdio: 'inherit', env });
    r.on('exit', (code) => {
      if (code !== 0) {
        console.error('[launch] site-preload 打包失败，应用可能加载不到注入层。');
        process.exit(1);
      }
      spawnElectron();
    });
  } catch (err) {
    console.error(`[launch] site-preload 打包异常: ${err.message}`);
    process.exit(1);
  }
} else {
  spawnElectron();
}

function spawnElectron() {
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
}
