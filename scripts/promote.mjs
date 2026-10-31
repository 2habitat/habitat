#!/usr/bin/env node
/**
 * 发布：把一个 git tag 安全地升到生产目录，出问题自动回滚。
 *
 * 为什么需要它：生产和开发如果是同一个目录，你改坏代码后只要重启就影响日常使用。
 * 升级必须满足三条：
 *   1. 能判断"这次升级到底好不好"（不只看进程起没起来）
 *   2. 坏了能一条命令退回去
 *   3. 整个过程不用你记步骤
 *
 * 用法（在生产目录里跑）：
 *   node scripts/promote.mjs v0.1.1
 *   node scripts/promote.mjs v0.1.1 --dry-run          # 只看会做什么
 *   node scripts/promote.mjs v0.1.1 --restart "命令"    # 自定义重启
 *   node scripts/promote.mjs v0.1.1 --no-test          # 跳过单元测试
 *
 * 判断"好"的标准（三个都要过）：
 *   · /healthz 返回 ok
 *   · 空间对象数不低于升级前（防重构把扫描改坏）
 *   · 链接解析率不明显下降（防链接解析回归）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const ref = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const skipTest = args.includes('--no-test');
const restartIdx = args.indexOf('--restart');
const restartCmd = restartIdx >= 0 ? args[restartIdx + 1] : process.env.HABITAT_RESTART_CMD ?? '';

const PORT = process.env.HABITAT_PORT ?? '8765';
const HEALTH = `http://127.0.0.1:${PORT}/healthz`;
const SPACE = process.env.HABITAT_SPACE ?? '';

if (!ref) {
  console.error('用法：node scripts/promote.mjs <tag 或 commit> [--dry-run] [--no-test] [--restart "命令"]');
  process.exit(1);
}

// 必须知道在给哪个空间发版。没设就拒绝——否则会去读 ./space 那个示例空间，
// 拿错误的基线去判断"对象数有没有掉"，比不判断更危险。
if (!SPACE) {
  console.error('请先设 HABITAT_SPACE 指向生产空间（例如 export HABITAT_SPACE=D:/path/to/MySpace）');
  process.exit(1);
}

const sh = (cmd, opts = {}) => {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`命令失败（退出码 ${r.status}）：${cmd}${r.stderr ? `\n${r.stderr}` : ''}`);
  }
  return r;
};

const out = (cmd, opts = {}) => execFileSync(cmd, { shell: true, encoding: 'utf8', ...opts }).trim();

function step(n, text) {
  console.log(`\n[${n}] ${text}`);
}

/** 读空间统计：用当前代码去扫，升级前后各读一次 */
function snapshot() {
  try {
    const raw = out('npx tsx server/cli.ts status --json', {
      env: { ...process.env, HABITAT_SPACE: SPACE },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw.slice(raw.indexOf('{')));
  } catch (e) {
    return { error: e.message };
  }
}

async function health(timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(HEALTH);
      if (r.ok) {
        const j = await r.json();
        if (j.ok) return j;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`健康检查超时（${HEALTH}）`);
}

function restart() {
  if (!restartCmd) {
    console.log('   ⚠ 没配重启命令。服务不会自己换代码——请手动重启，或设 HABITAT_RESTART_CMD。');
    return;
  }
  console.log(`   重启：${restartCmd}`);
  sh(restartCmd);
}

/* ---------------- 开始 ---------------- */

const prevHead = out('git rev-parse HEAD');
const prevShort = prevHead.slice(0, 7);

console.log('Habitat 发布');
console.log(`  生产目录：${process.cwd()}`);
console.log(`  当前版本：${prevShort}`);
console.log(`  目标版本：${ref}${dryRun ? '（演练，不会改任何东西）' : ''}`);

step(1, '检查工作区');
const dirty = out('git status --porcelain');
if (dirty) {
  console.error('   工作区有未提交的改动，拒绝发布：\n' + dirty);
  console.error('   生产目录不应该直接改代码。先提交/丢弃，或在开发目录里改。');
  process.exit(1);
}
console.log('   干净');

step(2, '解析目标版本');
sh('git fetch --tags --quiet');
// 解引用到 commit：annotated tag 的 sha 是 tag 对象，不是提交
const targetHead = out(`git rev-parse ${ref}^{commit}`);
const targetShort = targetHead.slice(0, 7);
if (targetHead === prevHead) {
  console.log(`   已经在 ${targetShort}，无需升级`);
  process.exit(0);
}
console.log(`   ${prevShort} → ${targetShort}`);

// 版本号对不上会让 /healthz 报的 version 和 tag 不一致，上线后排查时很容易看错
const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
if (/^v\d+\.\d+\.\d+$/.test(ref) && `v${pkgVersion}` !== ref) {
  console.log(`   ⚠ package.json 版本是 ${pkgVersion}，与标签 ${ref} 不一致（/healthz 会报旧版本号）`);
}

step(3, '升级前快照');
const before = snapshot();
if (before.error) {
  console.error(`   读不到空间统计：${before.error}`);
  console.error('   没有基线就没法判断升级好坏，中止。');
  process.exit(1);
}
console.log(`   ${before.objects} 个对象，链接 ${before.links} 条（未解析 ${before.unresolved}）`);

const lockChanged = out(`git diff --name-only ${prevHead} ${targetHead} -- package-lock.json`) !== '';

if (dryRun) {
  console.log('\n演练结论：');
  console.log(`  · 切到 ${targetShort}`);
  if (lockChanged) console.log('  · 依赖变了，需要 npm ci');
  console.log('  · npm run build');
  if (!skipTest) console.log('  · npm run test:unit');
  console.log(`  · 重启：${restartCmd || '(未配置)'}`);
  console.log('  · 健康检查 + 对象数/解析率对比，任一项不过自动回滚');
  process.exit(0);
}

function rollback(reason) {
  console.error(`\n✗ 失败：${reason}`);
  console.error(`   回滚到 ${prevShort}…`);
  try {
    sh(`git checkout --quiet ${prevHead}`);
    if (lockChanged) sh('npm ci');
    sh('npm run build');
    restart();
    console.error('   已回滚。请确认服务可用后再继续排查。');
  } catch (e) {
    console.error(`   回滚也失败了：${e.message}`);
    console.error(`   手动执行：git checkout ${prevHead} && npm ci && npm run build，然后重启`);
  }
  process.exit(1);
}

step(4, '切换代码');
sh(`git checkout --quiet ${targetShort}`);
console.log(`   现在在 ${targetShort}`);

step(5, '依赖');
if (lockChanged) {
  console.log('   package-lock 有变化，执行 npm ci');
  try {
    sh('npm ci');
  } catch (e) {
    rollback(`依赖安装失败：${e.message}`);
  }
} else {
  console.log('   依赖没变，跳过');
}

step(6, '构建');
try {
  sh('npm run build');
} catch (e) {
  rollback(`构建失败：${e.message}`);
}

if (!skipTest) {
  step(7, '单元测试');
  try {
    sh('npm run test:unit');
  } catch (e) {
    rollback(`测试失败：${e.message}`);
  }
}

step(8, '重启服务');
try {
  restart();
} catch (e) {
  rollback(`重启失败：${e.message}`);
}

step(9, '健康检查');
try {
  const h = await health();
  console.log(`   ok，uptime ${h.uptime}s`);
} catch (e) {
  rollback(e.message);
}

step(10, '数据一致性');
const after = snapshot();
if (after.error) {
  rollback(`升级后读不到空间统计：${after.error}`);
}
console.log(`   ${after.objects} 个对象（升级前 ${before.objects}），链接 ${after.links} 条`);

if (after.objects < before.objects) {
  rollback(`对象数从 ${before.objects} 掉到 ${after.objects}——扫描大概率改坏了`);
}
const beforeRate = before.links ? 1 - before.unresolved / before.links : 1;
const afterRate = after.links ? 1 - after.unresolved / after.links : 1;
if (afterRate < beforeRate - 0.05) {
  rollback(`链接解析率从 ${(beforeRate * 100).toFixed(1)}% 掉到 ${(afterRate * 100).toFixed(1)}%`);
}

console.log(`\n✓ 已升级到 ${targetShort}`);
console.log(`  回滚命令：git checkout ${prevShort} && npm ci && npm run build && ${restartCmd || '<重启服务>'}`);
