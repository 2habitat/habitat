#!/usr/bin/env node
/**
 * 运行时体检：Node 版本 / ABI / 原生模块是否配套。
 * 出「NODE_MODULE_VERSION」类报错时先跑这个，比读堆栈快。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abiToMajor, probeBetterSqlite3, fixHint } from './runtime-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const abi = Number(process.versions.modules);
console.log('habitat 运行时体检');
console.log(`  项目目录 : ${root}`);
console.log(`  node     : ${process.version}  (ABI ${abi} / Node ${abiToMajor(abi) ?? '?'})`);
console.log(`  execPath : ${process.execPath}`);
console.log(`  平台     : ${process.platform}-${process.arch}`);
console.log(`  sqlite   : better-sqlite3 ^11.10.0`);

const r = probeBetterSqlite3();
if (r.ok) {
  console.log('\n[ok] better-sqlite3 可加载，ABI 对得上。');
  process.exit(0);
}

console.log('\n[fail] better-sqlite3 加载失败');
if (r.kind === 'abi') {
  console.log(`  二进制编译于 : ABI ${r.built} (Node ${abiToMajor(r.built) ?? '?'})`);
  console.log(`  当前 Node 需要: ABI ${r.need} (Node ${abiToMajor(r.need) ?? '?'})`);
  console.log(`  说明         : ${r.message}`);
  console.log('');
  console.log(fixHint());
} else {
  console.log(`  原因: ${r.message}`);
  console.log('  可能是依赖没装全：npm install');
}
process.exit(1);
