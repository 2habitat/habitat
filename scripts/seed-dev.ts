/** 生成开发用空间：habitat seed --target <dir> */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MINI } from '../tests/helpers/space.ts';

const target = process.argv[2] ?? process.env.HABITAT_SPACE;
if (!target) {
  console.error('用法：npx tsx scripts/seed-dev.ts <目标空间目录>');
  process.exit(1);
}
await fsp.mkdir(target, { recursive: true });
for (const [rel, content] of Object.entries(MINI)) {
  const abs = path.join(target, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}
console.log(`已生成开发空间：${target}（${Object.keys(MINI).length} 个文件）`);
