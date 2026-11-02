/**
 * 时间块解析：任务的「安排」写成 [at:: 14:00-15:30]。
 *
 * 放在 shared 里是因为三处都要用：服务端解析、CLI 校验、前端表单预检。
 * 不要把这段逻辑在客户端再抄一遍——格式一旦两边不一致，写进去就读不回来。
 */
export function parseScheduled(v?: string): [string, string] | undefined {
  if (!v) return undefined;
  const m = /^(\d{1,2}):(\d{2})\s*[–—~-]\s*(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return undefined;
  const hh = (s: string) => s.padStart(2, '0');
  return [`${hh(m[1])}:${m[2]}`, `${hh(m[3])}:${m[4]}`];
}

/** ['09:00','10:30'] → '09:00-10:30' */
export function formatScheduled(v?: [string, string]): string {
  return v ? `${v[0]}-${v[1]}` : '';
}
