import { defineConfig } from '@playwright/test';
import path from 'node:path';

// 测试空间放仓库内，跟着仓库走，不写死任何人的绝对路径
const E2E = path.resolve('.e2e-space');

const PORT_API = 8788;
const PORT_WEB = 5179;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT_WEB}`,
    trace: 'off',
    video: 'off',
  },
  webServer: [
    {
      // 空间根目录直接作为命令行参数传，不依赖环境变量是否被透传
      command: `npx tsx scripts/seed-e2e.ts && npx tsx server/index.ts ${E2E}`,
      // 邮件配置指到临时文件：测试绝不能碰用户真实的 ~/.habitat/mail.json
      env: { HABITAT_PORT: String(PORT_API), HABITAT_LOG: 'warn', HABITAT_MAIL_CONFIG: path.join(E2E, '.mail.json') },
      port: PORT_API,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${PORT_WEB} --strictPort`,
      // 必须把 API 端口一起塞给 Vite：vite.config.ts 里 /api 的代理目标读的就是 HABITAT_PORT，
      // 不传就会退回默认的 8787，前端所有请求都打到空气上。
      env: { HABITAT_PORT: String(PORT_API) },
      port: PORT_WEB,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
