/** 稳定 ID：<kind>-<ulid>。改名、移动都不变。 */

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
let lastTime = 0;
let lastRand: number[] = [];

function randChars(): string {
  // 同一毫秒内单调进位，避免排序抖动
  let i = lastRand.length - 1;
  while (i >= 0) {
    if (lastRand[i] < 31) {
      lastRand[i] += 1;
      break;
    }
    lastRand[i] = 0;
    i -= 1;
  }
  if (i < 0 || lastRand.length === 0) {
    lastRand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  return lastRand.map((n) => ENC[n]).join('');
}

export function ulid(now = Date.now()): string {
  if (now !== lastTime) {
    lastTime = now;
    lastRand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + randChars();
}

export function newId(kind: string, now = Date.now()): string {
  return `${kind}-${ulid(now)}`;
}

/** 从 id 取出 kind；不合法返回 null */
export function kindOf(id: string): string | null {
  const m = /^([a-z]+)-[0-9A-HJKMNP-TV-Z]{26}$/.exec(id);
  return m ? m[1] : null;
}

/**
 * 本地日历日（YYYY-MM-DD）。
 * 别用 new Date().toISOString().slice(0,10)：那是 UTC，UTC+8 的 00:00–08:00
 * 会算成昨天，于是「挪到今天」把任务挪进逾期。空间里所有日期字段都是本地日历日。
 */
export function todayISO(t = Date.now()): string {
  return nowISO(t).slice(0, 10);
}

export function nowISO(t = Date.now()): string {
  const d = new Date(t);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ao = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(ao / 60))}:${pad(ao % 60)}`
  );
}
