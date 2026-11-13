#!/usr/bin/env node
/**
 * 构建产物体检：只查「能不能打开」这件事。
 *
 * 为什么需要它：2026-11-13 生产白屏过一次。vite build 报成功，assets 也都写好了，
 * 但 dist/index.html 是 621 字节的全零文件——长度对、内容空。服务照常起、/healthz 照常回 ok，
 * 只有浏览器打开是白屏。发布脚本的三条判据（健康、对象数、解析率）全都看不见这个问题。
 *
 * 所以判据补一条：入口文件必须非空、必须引用真实存在的资源。
 * 退出码非 0 会让 promote 的 `npm run build` 失败，从而自动回滚。
 */
import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const INDEX = path.join(DIST, 'index.html');

const fail = (msg) => {
  console.error(`\n[verify-dist] ✗ ${msg}`);
  console.error('[verify-dist] 构建产物不可用，拒绝交付。');
  process.exit(1);
};

if (!fs.existsSync(INDEX)) fail(`没有 ${INDEX}`);

const buf = fs.readFileSync(INDEX);

// 1. 全零 / 全空白：写入被截断或垫片占位的典型特征
if (buf.length === 0) fail(`${INDEX} 是空文件`);
const nonBlank = buf.some((b) => b !== 0 && b !== 32 && b !== 10 && b !== 13);
if (!nonBlank) fail(`${INDEX} 内容全是零字节（${buf.length} 字节），写入被截断`);

const html = buf.toString('utf8');

// 2. 必须真的挂载前端：没有 script 标签就是白屏
const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
if (!refs.some((r) => r.endsWith('.js'))) fail(`${INDEX} 里没有入口脚本，打开会是白屏`);
if (!html.includes('id="root"')) fail(`${INDEX} 缺少 #root 挂载点`);

// 3. 引用的资源必须真的在盘上：哈希错位会 404，同样是白屏
const missing = refs.filter((r) => !fs.existsSync(path.join(DIST, r.replace(/^\//, ''))));
if (missing.length) fail(`入口引用的资源不存在：${missing.join('、')}`);

console.log(`[verify-dist] ✓ index.html ${buf.length} 字节，引用 ${refs.length} 个资源，全部存在`);