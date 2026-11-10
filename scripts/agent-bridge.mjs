#!/usr/bin/env node
/**
 * 远端 ACP bridge：在远端机器上拉起一个本地 harness（默认 dsh），
 * 把它的 stdio JSON-RPC 暴露成平台能访问的 HTTP/SSE 端点。
 *
 *   node scripts/agent-bridge.mjs --port 8799 --token <token> --command dsh
 *
 * 平台侧 agents.yaml：
 *   - id: studio
 *     driver: remote
 *     endpoint: http://<这台机器>:8799/acp
 *     token: ${REMOTE_AGENT_TOKEN}
 *
 * 注意：平台会把 session MCP 的 URL 传给本地 harness。远端必须能访问这个 URL
 * （LAN、公网或反向隧道）；否则 harness 能启动，但工具面连不上。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
}

const PORT = Number(arg('port', '8799'));
let TOKEN = arg('token', '');
const COMMAND = arg('command', 'dsh');
const PUBLIC_URL = arg('url', `http://127.0.0.1:${PORT}/acp`);

// 有配对码就先向平台登记；平台会把这个 bridge 作为远端 harness 加入列表
if (!TOKEN && arg('code')) {
  const platform = arg('platform', 'http://127.0.0.1:8787').replace(/\/+$/, '');
  try {
    const r = await fetch(`${platform}/api/agent/bridge/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: arg('code'),
        endpoint: PUBLIC_URL,
        label: arg('label', '远端 harness'),
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error ?? '配对失败');
    TOKEN = j.token;
    console.log(`[agent-bridge] 已配对：${j.harness?.id ?? '?'}（${j.harness?.label ?? ''}）`);
    console.log(`[agent-bridge] 平台可见 endpoint：${PUBLIC_URL}`);
  } catch (e) {
    console.error(`[agent-bridge] 配对失败：${e.message}`);
    process.exit(1);
  }
}
const HARNESS_ARGS = (() => {
  const raw = arg('args', '');
  if (!raw) return ['--profile', 'acp'];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : ['--profile', 'acp']; } catch { return ['--profile', 'acp']; }
})();

const CWD = path.join(os.tmpdir(), `habitat-bridge-${process.pid}`);
fs.mkdirSync(CWD, { recursive: true });

let child = null;
let seq = 0;
let pending = new Map();
let activePrompt = null;
let closed = false;
let lastError = '';

function startChild() {
  if (child) return;
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(COMMAND);
  child = spawn(COMMAND, HARNESS_ARGS, {
    cwd: CWD,
    env: { ...process.env, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? 'read-only' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: useShell,
    windowsHide: true,
  });
  child.stderr.on('data', (d) => { lastError = `${lastError}${d}`.slice(-4000); });
  child.on('error', (e) => { lastError = `${lastError}${e.message}`.slice(-4000); });
  child.on('exit', (code) => {
    const err = { message: `harness 退出（${code}）${lastError ? `：${lastError.slice(-300)}` : ''}` };
    for (const [, p] of pending) p.reject(new Error(err.message));
    pending.clear();
    if (activePrompt) {
      activePrompt.res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: activePrompt.id, error: err })}\n\n`);
      activePrompt.res.end();
      activePrompt = null;
    }
    child = null;
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id === undefined) {
      if (activePrompt) activePrompt.res.write(`data: ${JSON.stringify(msg)}\n\n`);
      return;
    }
    if (msg.id !== undefined) {
      if (activePrompt && Number(msg.id) === activePrompt.id) {
        activePrompt.res.write(`data: ${JSON.stringify(msg)}\n\n`);
        activePrompt.res.end();
        activePrompt = null;
        return;
      }
      const p = pending.get(Number(msg.id));
      if (!p) return;
      pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message ?? 'ACP 请求失败'));
      else p.resolve(msg.result);
    }
  });
}

function sendToChild(method, params, timeoutMs = 30000) {
  startChild();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ACP 请求超时：${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/acp')) {
    res.writeHead(404).end();
    return;
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  let body;
  try { body = await readBody(req); } catch { res.writeHead(400).end(); return; }
  const id = body.id ?? null;
  const method = String(body.method ?? '');
  const params = body.params && typeof body.params === 'object' ? body.params : {};

  try {
    if (method === 'session/prompt') {
      startChild();
      const promptId = id !== null && Number.isFinite(Number(id)) ? Number(id) : ++seq;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(':ok\n\n');
      activePrompt = { id: promptId, res };
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, method, params })}\n`);
      return;
    }
    if (method === 'session/new') {
      // 平台传来的 cwd 是平台机器的沙箱路径；远端用 bridge 自己的临时目录
      params.cwd = CWD;
    }
    const result = await sendToChild(method, params, 30000);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  } catch (e) {
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agent-bridge] http://127.0.0.1:${PORT}/acp`);
  console.log(`[agent-bridge] command: ${COMMAND} ${HARNESS_ARGS.join(' ')}`);
  if (TOKEN) console.log('[agent-bridge] token required');
});

function shutdown() {
  closed = true;
  try { child?.stdin.end(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
process.on('exit', () => { if (!closed) try { child?.kill(); } catch { /* ignore */ } });
