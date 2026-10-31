/**
 * 邮件投递：把「发给自己的邮件」变成收件箱里的碎片。
 *
 * 为什么要有它：采集如果必须打开网页，那灵感和收据就死在手机里。
 * 发一封邮件到自己的邮箱，是最低摩擦的入口——不需要装 App、不需要登录、离线也能写。
 *
 * 两条硬规则（否则这个通道会变成垃圾投递口）：
 *   1. 只收白名单发件人。默认只认「配置里的发件邮箱自己」。
 *   2. 只处理未读，处理完标记已读。不删邮件、不改邮箱里的东西。
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Habitat } from './space.ts';
import type { Store } from './store.ts';
import { loadMailConfig, type MailConfig } from './mailer.ts';
import { saveAsset, assetMarkdown } from './assets.ts';
import { nowISO } from '../../shared/id.ts';

const STATE_FILE = '.habitat/state/mail-inbox.json';

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * 从 mail 配置推出 IMAP 设置：没显式配就按常见服务商猜。
 * QQ/Foxmail → imap.qq.com:993；其它 → imap.<smtp 域名去掉 smtp.>
 */
export function resolveImap(cfg: MailConfig & { imap?: Partial<ImapConfig> }): ImapConfig {
  const guessHost = cfg.host.startsWith('smtp.') ? `imap.${cfg.host.slice(5)}` : cfg.host;
  return {
    host: cfg.imap?.host ?? guessHost,
    port: Number(cfg.imap?.port ?? 993),
    secure: cfg.imap?.secure !== false,
    user: cfg.imap?.user ?? cfg.user,
    pass: cfg.imap?.pass ?? cfg.pass,
  };
}

/** 白名单：没配就只认自己（防止任何人往你库里投东西） */
export function allowedSenders(cfg: MailConfig & { allowFrom?: string[] }): string[] {
  const list = (cfg.allowFrom ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : [cfg.user.toLowerCase()];
}

function senderAllowed(from: string | undefined, allow: string[]): boolean {
  if (!from) return false;
  const a = from.toLowerCase();
  return allow.some((rule) => (rule.startsWith('@') ? a.endsWith(rule) : a === rule));
}

/** 极简 HTML → 文本：够用就行，别为了转正文引入一整套 DOM */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ParsedMailLike {
  subject?: string;
  from?: { value?: { address?: string }[] };
  date?: Date;
  text?: string;
  html?: string | false;
  attachments?: { filename?: string; content?: Buffer }[];
}

/**
 * 邮件 → 碎片（纯函数，好测）。
 * 附件只产出 markdown 链接，落盘由调用方做——这样单测不需要文件系统。
 */
export function mailToCapture(parsed: ParsedMailLike): {
  title: string;
  body: string;
  attachments: { filename: string; content: Buffer }[];
} {
  const title = (parsed.subject ?? '(无主题)').slice(0, 120);
  const text = (parsed.text ?? (parsed.html ? htmlToText(String(parsed.html)) : '')).trim();
  const from = parsed.from?.value?.[0]?.address ?? '';
  const date = (parsed.date ?? new Date()).toISOString();
  const attachments = (parsed.attachments ?? []).filter(
    (a): a is { filename: string; content: Buffer } => !!a.filename && !!a.content,
  );
  const NL = String.fromCharCode(10);
  const parts = [text || '（这封邮件没有正文）'];
  if (attachments.length) {
    const names = attachments.map((a) => `- ${a.filename}`).join(NL);
    parts.push(`${NL}${NL}---${NL}附件：${NL}${names}`);
  }
  parts.push(`${NL}${NL}> 来自邮件：${from} · ${date.slice(0, 16).replace('T', ' ')}`);
  const body = parts.join('');
  return { title, body, attachments };
}

export interface MailIngestItem {
  subject: string;
  from: string;
  date: string;
  attachments: number;
  id?: string;
  skipped?: string;
}

export interface MailIngestReport {
  at: string;
  configured: boolean;
  fetched: number;
  captured: MailIngestItem[];
  skipped: MailIngestItem[];
  error?: string;
}

/** 连一次、收一轮。dryRun 时只看有哪些，不落库、不标记已读。 */
export async function ingestMail(hab: Habitat, opts: { dryRun?: boolean; limit?: number } = {}): Promise<MailIngestReport> {
  const cfg = loadMailConfig() as (MailConfig & { imap?: Partial<ImapConfig>; allowFrom?: string[] }) | null;
  const report: MailIngestReport = { at: nowISO(), configured: !!cfg, fetched: 0, captured: [], skipped: [] };
  if (!cfg) {
    report.error = '没有配置邮件通道';
    return report;
  }

  const imap = resolveImap(cfg);
  const allow = allowedSenders(cfg);
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const found = await client.search({ seen: false }, { uid: true });
      const uids: number[] = Array.isArray(found) ? found : [];
      report.fetched = uids.length;
      // 取最新的 N 封：投递通道关心的是「刚发的」，不是「最老的」
      const take = uids.slice(-(opts.limit ?? 20));

      for (const uid of take) {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0]?.address ?? '';
        const subject = (parsed.subject ?? '(无主题)').slice(0, 120);
        const date = (parsed.date ?? new Date()).toISOString();

        if (!senderAllowed(from, allow)) {
          report.skipped.push({ subject, from, date, attachments: 0, skipped: '发件人不在白名单' });
          // 不标记已读：留给人自己决定，别替人清邮箱
          continue;
        }

        const text = (parsed.text ?? (parsed.html ? htmlToText(String(parsed.html)) : '')).trim();
        const files = parsed.attachments ?? [];

        if (opts.dryRun) {
          report.captured.push({ subject, from, date, attachments: files.length, skipped: 'dry-run 未入库' });
          continue;
        }

        // 附件先入库，正文里插链接——这样碎片本身就是完整的
        const links: string[] = [];
        for (const f of files) {
          if (!f.content || !f.filename) continue;
          const r = await saveAsset(hab.store, Buffer.from(f.content), { name: f.filename, dir: 'assets/attachments' });
          links.push(assetMarkdown(r.rel, f.filename));
        }

        const body = [
          text || '（这封邮件没有正文）',
          links.length ? `\n\n---\n附件：\n${links.join('\n')}` : '',
          `\n\n> 来自邮件：${from} · ${date.slice(0, 16).replace('T', ' ')}`,
        ].join('');

        const r = await hab.capture({ title: subject, body, target: 'inbox', actor: 'human' });
        report.captured.push({ subject, from, date, attachments: files.length, id: r.id });
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    report.error = (e as Error).message;
  } finally {
    try {
      if (client.usable) await client.logout();
    } catch {
      /* 已经断了就算了 */
    }
  }

  if (!opts.dryRun && report.captured.length) await remember(hab.store, report.captured.length);
  return report;
}

async function remember(store: Store, n: number): Promise<void> {
  const raw = await store.adapter.read(STATE_FILE).catch(() => '');
  let prev: { total?: number } = {};
  try {
    prev = JSON.parse(raw) as { total?: number };
  } catch {
    prev = {};
  }
  await store.adapter.write(
    STATE_FILE,
    JSON.stringify({ at: nowISO(), total: (prev.total ?? 0) + n }, null, 2),
    { backup: false },
  );
}
