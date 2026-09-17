'use strict';

/**
 * 把 site-preload 打成单文件 bundle。
 *
 * 为什么需要打包：preload 运行在 sandbox 里，**只能 require('electron')**，
 * 引不了任何第三方模块 —— 想在注入层复用 turndown 这类成熟库，唯一的办法
 * 是用 esbuild 把依赖内联进一个自包含文件（electron 保留为外部 require）。
 *
 * 产物在 dist/preload/（已被 .gitignore 忽略）。
 * launch.js 启动前会检查源文件和 bundle 的新旧，需要时自动重建。
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'preload', 'site-preload.js');

function build() {
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'preload', 'site-preload.js')],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'], // sandbox 下唯一允许 require 的模块，必须保留
    minify: false,
    sourcemap: false,
    logLevel: 'silent',
  });
  return OUT;
}

module.exports = { build, OUT };

if (require.main === module) {
  const out = build();
  console.log(
    `site-preload bundle 已生成: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)}KB)`
  );
}
