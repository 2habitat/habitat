/**
 * 邮件通道（SMTP）。
 *
 * 为什么要它：站内通知只有打开网页才看得到，而「明天 3 点开会」这种提醒
 * 恰恰是在你不看网页的时候才有价值。邮件是唯一不需要额外服务的推送通道。
 *
 * 凭据放哪：**不放进知识空间**（那是 WPS 同步目录，会被同步到云端）。
 * 顺序是 环境变量 → `~/.habitat/mail.json`。
 */
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** QQ/Foxmail 用的是「授权码」，不是登录密码 */
  pass: string;
  to: string;
  fromName?: string;
  /** IMAP 收信（不配就按 SMTP 域名猜） */
  imap?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string };
  /** 只收这些发件人；空 = 只认自己。支持 @domain */
  allowFrom?: string[];
}

export function configPath(): string {
  return process.env.HABITAT_MAIL_CONFIG ?? path.join(os.homedir(), '.habitat', 'mail.json');
}

/** 读配置：环境变量优先，其次文件；都没有就返回 null（不报错，让服务照常跑） */
export function loadMailConfig(): MailConfig | null {
  const env = process.env;
  if (env.HABITAT_SMTP_HOST && env.HABITAT_SMTP_USER && env.HABITAT_SMTP_PASS) {
    return {
      host: env.HABITAT_SMTP_HOST,
      port: Number(env.HABITAT_SMTP_PORT ?? 465),
      secure: (env.HABITAT_SMTP_SECURE ?? '1') !== '0',
      user: env.HABITAT_SMTP_USER,
      pass: env.HABITAT_SMTP_PASS,
      to: env.HABITAT_MAIL_TO ?? env.HABITAT_SMTP_USER,
      fromName: env.HABITAT_MAIL_FROM_NAME ?? 'Habitat',
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<MailConfig>;
    if (!raw.host || !raw.user || !raw.pass || !raw.to) return null;
    return {
      host: raw.host,
      port: Number(raw.port ?? 465),
      secure: raw.secure !== false,
      user: raw.user,
      pass: raw.pass,
      to: raw.to,
      fromName: raw.fromName ?? 'Habitat',
    };
  } catch {
    return null;
  }
}

/** 配置诊断：缺哪个字段要说清楚，不能只说「没配置」 */
export function mailStatus(): { configured: boolean; path: string; user?: string; to?: string; host?: string; port?: number; secure?: boolean; fromName?: string; missing: string[] } {
  const cfg = loadMailConfig();
  if (cfg) return { configured: true, path: configPath(), user: cfg.user, to: cfg.to, host: cfg.host, port: cfg.port, secure: cfg.secure, fromName: cfg.fromName, missing: [] };
  let raw: Partial<MailConfig> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<MailConfig>;
  } catch {
    return { configured: false, path: configPath(), missing: ['整个配置文件都不存在'] };
  }
  const missing = (['host', 'user', 'pass', 'to'] as const).filter((k) => !String(raw[k] ?? '').trim());
  return { configured: false, path: configPath(), user: raw.user, to: raw.to, host: raw.host, port: raw.port, secure: raw.secure, fromName: raw.fromName, missing };
}

/**
 * 先把域名解析成 IP，再用 IP 连。
 *
 * 为什么：nodemailer 内部用 c-ares（dns.resolve4）自己解析，而有些网络
 * 只放通了系统解析（getaddrinfo），UDP 53 直连被挡——表现就是
 * 「DNS lookup for smtp.qq.com timed out」，但 ping / nslookup 都正常。
 * 用系统解析拿 IP、再用 tls.servername 按域名校验证书，两边都不牺牲。
 */
async function resolveIp(host: string): Promise<string> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  try {
    return (await dns.promises.lookup(host, { family: 4 })).address;
  } catch {
    return host; // 解析不了就原样交给 nodemailer，让报错更贴近真相
  }
}

let cached: { key: string; tx: Transporter } | null = null;

async function transport(cfg: MailConfig): Promise<Transporter> {
  // 必须把 pass 也放进比较：改了授权码还在用旧连接池，会一直报登录失败
  const key = `${cfg.host}|${cfg.port}|${cfg.user}|${cfg.pass}`;
  if (cached?.key === key) return cached.tx;

  const ip = await resolveIp(cfg.host);
  const tx = nodemailer.createTransport({
    host: ip,
    port: cfg.port,
    secure: cfg.secure,
    tls: { servername: cfg.host },
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });
  cached = { key, tx };
  return tx;
}

export interface MailPayload {
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  ok: boolean;
  /** 没配置时是 null，不是失败——由调用方决定怎么提示 */
  skipped?: boolean;
  messageId?: string;
  error?: string;
}

export async function sendMail(payload: MailPayload): Promise<SendResult> {
  const cfg = loadMailConfig();
  if (!cfg) return { ok: false, skipped: true, error: '没有配置邮件通道' };
  try {
    const info = await (await transport(cfg)).sendMail({
      from: `"${cfg.fromName ?? 'Habitat'}" <${cfg.user}>`,
      to: cfg.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 只验证能不能连上/登录，不发信——用来判断授权码对不对 */
export async function verifyMail(): Promise<SendResult> {
  const cfg = loadMailConfig();
  if (!cfg) return { ok: false, skipped: true, error: '没有配置邮件通道' };
  try {
    await (await transport(cfg)).verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
