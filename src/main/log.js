'use strict';

const electronLog = require('electron-log/main');
const { PATHS } = require('./paths');

/**
 * 日志：复用 electron-log（成熟库）。
 *
 * 自己当初写的那版只有「拼一行 + appendFile」，缺了成熟库该有的东西：
 * 文件大小轮转、跨平台路径处理、多进程（renderer/preload）汇聚、未捕获异常落盘。
 *
 * 对外仍然只暴露 log.info / warn / error / verify 四个方法，调用方一行都不用改。
 * 为什么必须落文件：双击 exe 启动时没有控制台，stdout 会直接丢掉。
 */
electronLog.transports.file.resolvePathFn = () => PATHS.loginLog;
electronLog.transports.file.maxSize = 5 * 1024 * 1024; // 5MB 就轮转，别让日志无限长
electronLog.transports.file.format = '[{y}-{m}-{d}T{h}:{i}:{s}.{ms}] [{level}] {text}';
electronLog.transports.file.level = 'info';
electronLog.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}';

// 未捕获异常也进日志（手写那版没有这个能力，崩了就只能看到一句「应用已退出」）
electronLog.errorHandler.startCatching({ showDialog: false });

const log = {
  info: (msg) => electronLog.info(msg),
  warn: (msg) => electronLog.warn(msg),
  error: (msg) => electronLog.error(msg),
  verify: (msg) => electronLog.info(`[verify] ${msg}`),
};

module.exports = { log };
