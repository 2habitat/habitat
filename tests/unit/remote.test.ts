/**
 * 远端 ACP 驱动：用一个最小 HTTP fixture 验证 JSON/SSE 解析，不依赖真实 bridge。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { RemoteAcpDriver } from '../../server/agent/remote.ts';
import type { DriverEvent } from '../../server/agent/acp.ts';

let server: http.Server;
let endpoint = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}') as { id: number; method: string };
      const send = (obj: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (msg.method === 'initialize') {
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              mcpCapabilities: { http: true },
              promptCapabilities: { image: true, embeddedContext: true },
              sessionCapabilities: { resume: {} },
            },
            authMethods: [],
          },
        });
        return;
      }
      if (msg.method === 'session/new') {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'remote-s1', configOptions: [] } });
        return;
      }
      if (msg.method === 'session/prompt') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(':ok\n\n');
        res.write(`data: ${JSON.stringify({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: 'remote-s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '远端回答' } } },
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n\n`);
        res.end();
        return;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}/acp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('远端 ACP 驱动', () => {
  it('initialize / session/new / prompt（SSE）都能解析', async () => {
    const events: DriverEvent[] = [];
    const d = new RemoteAcpDriver({ id: 'remote', label: 'remote', driver: 'remote', endpoint });
    const r = await d.start({
      sessionId: 's1', cwd: '/tmp', mcpUrl: '', token: '', withMcp: false,
      onEvent: (e) => events.push(e),
    });
    expect(r.caps.protocolVersion).toBe('1');
    expect(r.caps.images).toBe(true);
    const p = await d.prompt('你好');
    expect(p.stopReason).toBe('end_turn');
    expect(events.some((e) => e.t === 'text' && e.delta === '远端回答')).toBe(true);
    await d.close();
  });
});
