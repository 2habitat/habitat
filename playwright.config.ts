import { defineConfig } from '@playwright/test';
import path from 'node:path';

// 测试空间放仓库内，跟着仓库走，不写死任何人的绝对路径
// 允许用 HABITAT_E2E_ROOT 换位置：测试文件与 seed 脚本早就在读这个变量，配置这里跟上，
// 否则「空间被占用删不掉」时整轮测试都起不来。
const E2E = process.env.HABITAT_E2E_ROOT ? path.resolve(process.env.HABITAT_E2E_ROOT) : path.resolve('.e2e-space');

const PORT_API = Number(process.env.HABITAT_E2E_API_PORT ?? 8788);
const PORT_WEB = Number(process.env.HABITAT_E2E_WEB_PORT ?? 5179);

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
      env: {
        HABITAT_PORT: String(PORT_API),
        HABITAT_LOG: 'warn',
        HABITAT_MAIL_CONFIG: path.join(E2E, '.mail.json'),
        // E2E 走无登录模式：不读开发机上的真实账号文件，也不会因为「本机有账号」而卡在登录页
        HABITAT_AUTH: 'off',
        HABITAT_AUTH_FILE: path.join(E2E, '.auth.json'),
        // E2E 不拉起真模型：mock harness 会走一遍 session MCP，覆盖「工具 → 建议 → 接受」
        HABITAT_AGENT_MOCK: '1',
      },
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
