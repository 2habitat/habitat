#!/usr/bin/env node
/**
 * habitat CLI 的启动壳：把参数转给 TypeScript 版的 server/cli.ts。
 * 这样 `npx habitat status` 和 `npx tsx server/cli.ts status` 是同一件事。
 *
 * 启动前先验一次原生模块的 ABI：fnm/nvm 切过大版本时，better-sqlite3 的
 * .node 二进制会失配，原来的报错是一屏堆栈，这里换成一句人话 + 一条命令。
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { probeBetterSqlite3, fixHint, findCompatibleNode } from './runtime-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const projectDir = path.join(here, '..');
const probe = probeBetterSqlite3();
if (!probe.ok) {
  // ABI 失配就自己换一个能用的 Node 重跑，而不是让人先切版本。
  // Agent 用什么 shell、PATH 怎么排我们都控制不了，这一步必须自动。
  if (probe.kind === 'abi') {
    const better = findCompatibleNode(projectDir);
    if (better) {
      const r = spawnSync(better, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, HABITAT_NODE_SWITCHED: '1' },
      });
      process.exit(r.status ?? 1);
    }
  }
  console.error(`[habitat] 原生模块起不来：${probe.message}`);
  console.error(`[habitat] 当前 node ${process.version}，${process.execPath}`);
  console.error(fixHint());
  process.exit(2);
}
const cli = path.join(here, '..', 'server', 'cli.ts');

const child = spawn(process.execPath, [
  path.join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  cli,
  ...process.argv.slice(2),
], { stdio: 'inherit', env: process.env });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
