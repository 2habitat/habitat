/**
 * Mock harness：测试与「刚部署还没配模型」时的兜底。
 *
 * 它不假装懂内容，只回放固定策略；批注场景会真的走一遍 session MCP，
 * 这样 E2E 能覆盖「模型请求工具 → 平台校验 → 建议回到界面」的整条链路。
 */
import type { HarnessCaps, StartResult } from '../../shared/agent.ts';
import type { DriverStartInput } from './acp.ts';

const CAPS: HarnessCaps = {
  streamText: true,
  thoughts: false,
  toolCalls: true,
  permissions: false,
  mcp: { http: true, sse: false, stdio: false },
  systemPrompt: false,
  images: false,
  embeddedContext: false,
  resume: false,
  maxContextChars: 12000,
  protocolVersion: 'mock',
  configOptions: [],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstQuote(text: string): string {
  const sel = /<selection[^>]*>([\s\S]*?)<\/selection>/.exec(text)?.[1]?.trim();
  if (sel) return sel.split('\n').filter(Boolean)[0]?.slice(0, 80) ?? '';
  const sec = /<section[^>]*>([\s\S]*?)<\/section>/.exec(text)?.[1]?.trim();
  if (sec) {
    const line = sec.split(/\n+/).map((s) => s.trim()).find((s) => s.length > 12 && !s.startsWith('#'));
    if (line) return line.slice(0, 80);
  }
  return '';
}

function focusTitle(text: string): string {
  return /<focus[^>]*>([\s\S]*?)<\/focus>/.exec(text)?.[1]?.trim() ?? '当前内容';
}

export class MockDriver {
  private input: DriverStartInput | null = null;

  async start(input: DriverStartInput): Promise<StartResult> {
    this.input = input;
    return {
      caps: CAPS,
      configOptions: [{
        id: 'model', name: 'Model', type: 'select', currentValue: 'mock',
        options: [{ value: 'mock', name: 'Mock' }],
      }],
    };
  }

  async prompt(text: string): Promise<{ stopReason?: string }> {
    const input = this.input;
    if (!input) throw new Error('mock 未启动');
    const title = focusTitle(text);
    // 只看用户这一轮，不看上下文里的契约/技能文本：否则「批注」二字永远先命中
    const userText = /<user>([\s\S]*?)<\/user>/.exec(text)?.[1]?.trim() ?? text;

    if (/批注|annotate/i.test(userText)) {
      const quote = firstQuote(text);
      if (quote) {
        await this.callTool(input, 'kb_annotate_suggest', {
          repId: /<focus[^>]*id="([^"]+)"/.exec(text)?.[1] ?? '',
          items: [{ quote, note: '这句话把结论和条件绑在一起，值得回看。', color: 'yellow' }],
        });
        await this.chunk('我从原文里挑了一句，提了一条批注建议；接受后会落到边注里。');
      } else {
        await this.chunk('这段里我没找到可以稳定定位的句子。先选一段正文，再让我批注。');
      }
      return { stopReason: 'end_turn' };
    }

    if (/苏格拉底|socratic|别直接告诉我/i.test(userText) || /<skill name="苏格拉底/.test(text)) {
      await this.chunk(`先别急着要结论。你刚读的《${title}》里，哪一句最像作者在让步？为什么？`);
      return { stopReason: 'end_turn' };
    }

    await this.chunk(`我看到了你的问题：「${userText.replace(/<[^>]+>/g, ' ').slice(-60).trim()}」。`);
    await this.chunk(`当前带入的是《${title}》。你可以继续追问，或选中一段正文让我批注。`);
    return { stopReason: 'end_turn' };
  }

  async cancel(): Promise<void> { /* no-op */ }
  async setConfig(): Promise<[]> { return []; }
  async close(): Promise<void> { this.input = null; }

  private async chunk(text: string): Promise<void> {
    // 分块发，界面才能验证「流式追加」而不是一次性替换
    for (const part of text.match(/.{1,12}/gs) ?? [text]) {
      this.input?.onEvent({ t: 'text', turnId: '', delta: part });
      await sleep(12);
    }
  }

  private async callTool(input: DriverStartInput, name: string, args: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(input.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      await res.text();
    } catch {
      // mock 不因为工具失败而中断对话；真正的错误由 session 事件暴露
    }
  }
}
