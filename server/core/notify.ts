/**
 * 通知：规则命中、作业失败这类「需要你知道」的事，落到一个能查的列表里。
 *
 * 为什么不直接 toast：toast 一闪就没了，晚上触发的规则你根本看不到。
 * 为什么不做系统推送：本机休眠就停，承诺「到点弹窗」是骗人的（方案 §15 也这么说）。
 */
import type { Store } from './store.ts';
import { newId, nowISO } from '../../shared/id.ts';

export const NOTIFY_FILE = '.habitat/state/notifications.jsonl';

export interface Notice {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'danger';
  title: string;
  body?: string;
  /** 点进去看哪儿；前端按 hash 路由跳 */
  href?: string;
  ruleId?: string;
  read: boolean;
}

export class Notifier {
  constructor(private store: Store) {}

  private async readAll(): Promise<Notice[]> {
    const raw = await this.store.adapter.read(NOTIFY_FILE).catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Notice;
        } catch {
          return null;
        }
      })
      .filter((x): x is Notice => !!x);
  }

  async list(limit = 50): Promise<{ notices: Notice[]; unread: number }> {
    const all = await this.readAll();
    const unread = all.filter((n) => !n.read).length;
    return { notices: all.slice(-limit).reverse(), unread };
  }

  /** 同一条规则同一天只提醒一次，否则每 60 秒刷一条，很快就没人看了 */
  async alreadyToday(ruleId: string): Promise<boolean> {
    const day = nowISO().slice(0, 10);
    return (await this.readAll()).some((n) => n.ruleId === ruleId && n.at.slice(0, 10) === day);
  }

  async add(input: Omit<Notice, 'id' | 'at' | 'read'>): Promise<Notice> {
    const n: Notice = { ...input, id: newId('ntc'), at: nowISO(), read: false };
    const prev = await this.store.adapter.read(NOTIFY_FILE).catch(() => '');
    await this.store.adapter.write(NOTIFY_FILE, `${prev}${JSON.stringify(n)}\n`, { backup: false });
    return n;
  }

  async markRead(id?: string): Promise<number> {
    const all = await this.readAll();
    let n = 0;
    for (const x of all) {
      if (id && x.id !== id) continue;
      if (!x.read) {
        x.read = true;
        n += 1;
      }
    }
    if (n > 0) {
      await this.store.adapter.write(NOTIFY_FILE, `${all.map((x) => JSON.stringify(x)).join('\n')}\n`, { backup: false });
    }
    return n;
  }
}
