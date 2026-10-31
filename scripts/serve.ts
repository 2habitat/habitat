#!/usr/bin/env node
/**
 * 生产入口：给「家里这台」跑的服务。
 *
 * 空间根由 HABITAT_SPACE 给；令牌由外部通过 KB_TOKEN 注入，
 * 不写进命令行、不写进文件。
 *
 * 典型部署：本机 8765 ← SSH 反向隧道 / 内网穿透 → nginx ← https://你的域名
 */
import fs from 'node:fs';
import path from 'node:path';

const SPACE = process.env.HABITAT_SPACE ?? path.resolve('space');

process.env.HABITAT_SPACE = SPACE;
process.env.HABITAT_PORT ??= '8765';
process.env.HABITAT_HOST ??= '127.0.0.1';

if (!fs.existsSync(path.join(SPACE, 'space.yaml'))) {
  console.error(`[habitat] 空间不存在或缺少 space.yaml：${SPACE}`);
  process.exit(1);
}
if (!fs.existsSync(path.resolve(import.meta.dirname, '..', 'dist', 'index.html'))) {
  console.error('[habitat] 没有前端产物 dist/，先跑 npm run build');
  process.exit(1);
}

const { start } = await import('../server/index.ts');
await start(SPACE);
