/** E2E 用的固定空间：每次跑测试前重建，保证可重复 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MINI, MINI_BINARY } from '../tests/helpers/space.ts';

export const E2E_ROOT = process.env.HABITAT_E2E_ROOT ?? path.resolve('.e2e-space');

/**
 * 手写递归删除，不用 fsp.rm：
 * 某些环境下 fsp.rm 会被「安全删除」钩子接管走回收站，删不掉就静默失败，
 * 结果测试跑在一个脏空间上，失败原因极难查。这里用 unlink/rmdir，失败就抛。
 */
function wipe(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) wipe(abs);
    else fs.unlinkSync(abs);
  }
  fs.rmdirSync(dir);
}

export async function seedE2e(): Promise<string> {
  wipe(E2E_ROOT);
  await fsp.mkdir(E2E_ROOT, { recursive: true });
  for (const [rel, content] of Object.entries(MINI)) {
    const abs = path.join(E2E_ROOT, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  for (const [rel, buf] of Object.entries(MINI_BINARY)) {
    const abs = path.join(E2E_ROOT, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
  }
  return E2E_ROOT;
}

if (process.argv[1] && /seed-e2e\.ts$/.test(process.argv[1])) {
  const r = await seedE2e();
  console.log(`E2E 空间就绪：${r}`);
}
