'use strict';

/**
 * 全局路径常量。全部基于 app.getPath('userData')，
 * 也就是 %APPDATA%/ChatShell —— 这里也是登录态真正的落盘点。
 */
const { app } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const PATHS = {
  root: ROOT,
  src: path.join(ROOT, 'src'),
  renderer: path.join(ROOT, 'src', 'renderer'),
  preload: path.join(ROOT, 'src', 'preload'),
  inject: path.join(ROOT, 'src', 'inject'),
  dist: path.join(ROOT, 'dist'), // 构建产物（site-preload 的 bundle），gitignore 忽略
  userData: app.getPath('userData'),
  configFile: path.join(app.getPath('userData'), 'config.json'),
  promptsFile: path.join(app.getPath('userData'), 'prompts.json'),
  loginLog: path.join(app.getPath('userData'), 'chatshell.log'),
  selectorReport: path.join(app.getPath('userData'), 'selector-report.json'),
  selfCheckFile: path.join(app.getPath('userData'), 'self-check.txt'),
};

module.exports = { PATHS };
