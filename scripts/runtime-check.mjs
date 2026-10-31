/**
 * 原生模块 ABI 自检。
 *
 * better-sqlite3 是预编译的 .node 二进制，和 Node 的 NODE_MODULE_VERSION（ABI）
 * 严格绑定：小版本升级没事，大版本一换（18→20→22→24）必然失配。
 * 原始报错是一坨堆栈，这里把它翻成「谁编译的、现在需要谁、怎么补一句命令」。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** ABI 号 → Node 大版本，只为把报错说人话，认不出就返回 null */
const ABI_MAJOR = {
  108: 18,
  111: 19,
  115: 20,
  120: 21,
  127: 22,
  131: 23,
  137: 24,
  141: 25,
};

const ABI_RE =
  /NODE_MODULE_VERSION (\d+)[\s\S]*?This version of Node\.js requires\s+NODE_MODULE_VERSION (\d+)/i;

export function abiToMajor(abi) {
  return ABI_MAJOR[Number(abi)] ?? null;
}

/**
 * 试着加载 better-sqlite3，把 ABI 失配和其它错误区分开。
 * @returns {{ok: true} | {ok: false, kind: 'abi'|'other', built?: number, need: number, major?: number|null, message: string}}
 */
export function probeBetterSqlite3() {
  const require = createRequire(import.meta.url);
  const need = Number(process.versions.modules);
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return { ok: true };
  } catch (err) {
    const msg = String((err && err.message) || err);
    const m = msg.match(ABI_RE);
    if (m) {
      const built = Number(m[1]);
      return {
        ok: false,
        kind: 'abi',
        built,
        need: Number(m[2]),
        major: abiToMajor(built),
        message: `better-sqlite3 是按 ABI ${built}（Node ${abiToMajor(built) ?? '?'}）编译的，当前 Node ${process.version} 需要 ABI ${m[2]}`,
      };
    }
    return { ok: false, kind: 'other', need, message: msg.split('\n')[0] };
  }
}

/** 给出可直接粘贴的补救命令（按当前 Node 重编，不需要切版本） */
export function fixHint() {
  return [
    '两个办法，选一个：',
    `  1) 按当前 Node 重编（推荐，一次到位）：  npm rebuild better-sqlite3`,
    `  2) 切回项目钉的版本再跑：              fnm use    （.node-version 已钉 22.22.3）`,
    '完整体检：  npm run doctor   （在 D:\\works\\habitat 下执行）',
  ].join('\n');
}

/**
 * 找一个 ABI 匹配的 Node。
 *
 * 为什么需要：这台机器上同时装着 Node 20（Program Files）和 fnm 管的 22，
 * better-sqlite3 只对其中一个有效。Agent 在什么 shell 里跑、PATH 怎么排，
 * 我们控制不了——所以入口自己找一个能用的，而不是要求人先切版本。
 */
export function findCompatibleNode(projectDir) {
  const exe = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  const roots = [
    path.join(os.homedir(), 'AppData/Roaming/fnm/node-versions'),
    path.join(os.homedir(), '.workbuddy/binaries/node/versions'),
    'C:/nvm4w',
  ];

  const candidates = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      for (const p of [
        path.join(root, d, 'installation', exe),
        path.join(root, d, exe),
        path.join(root, d, 'bin', 'node.exe'),
      ]) {
        if (fs.existsSync(p)) candidates.push(p);
      }
    }
  }

  // 版本号大的优先：新版本更可能匹配「最近一次编译」
  const ver = (p) => {
    const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(p);
    return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
  };
  candidates.sort((a, b) => ver(b) - ver(a));

  for (const p of candidates) {
    if (path.resolve(p) === path.resolve(process.execPath)) continue;
    const r = spawnSync(p, ['-e', "require('better-sqlite3');console.log('ok')"], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 15000,
    });
    if (r.status === 0 && String(r.stdout).includes('ok')) return p;
  }
  return null;
}
