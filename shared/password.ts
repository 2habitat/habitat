/**
 * 密码策略：前后端共用，避免「界面说行、服务端拒绝」这种割裂。
 *
 * 这里只做纯字符串判断，不碰哈希也不碰 Node API——浏览器要能直接 import。
 * 哈希、盐、参数在 server/core/auth.ts。
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** 只挡最烂的一批：真正的强度靠长度，复杂的字符规则只会把人逼去写 Password1! */
const COMMON = new Set([
  'password', 'password1', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'qwerty', 'qwerty123', '1q2w3e4r', '1qaz2wsx', 'abc123', 'abcd1234',
  '111111', '000000', '666666', '888888', '123123', '5201314',
  'iloveyou', 'letmein', 'welcome', 'monkey', 'dragon', 'admin', 'admin123',
  'changeme', 'secret', 'habitat', 'woaini', 'a123456',
]);

const CLASS_TESTS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  score: StrengthScore;
  label: string;
  /** 已经满足的项，给界面列清单用 */
  facts: { length: number; classes: number };
}

export interface PasswordCheck extends PasswordStrength {
  ok: boolean;
  problems: string[];
}

export function charLength(s: string): number {
  return [...s].length;
}

function classesOf(s: string): number {
  return CLASS_TESTS.reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
}

export function passwordStrength(password: string): PasswordStrength {
  const n = charLength(password);
  const classes = classesOf(password);
  let score = 0;
  if (n >= PASSWORD_MIN) score += 1;
  if (n >= 14) score += 1;
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;
  if (n >= 20) score += 1;
  let s = Math.min(4, score) as StrengthScore;
  // 常见弱密码不管多长都只给最低档：P@ssw0rd2026 依然是字典里的东西
  if (COMMON.has(password.toLowerCase())) s = 1;
  const labels = ['太短', '弱', '一般', '较强', '很强'] as const;
  return { score: s, label: labels[s], facts: { length: n, classes } };
}

/**
 * 校验新密码。
 * - 长度：10–200 个字符（按 Unicode 码点算，中文密码不会被当成 3 字节）
 * - 至少两类字符；16 个字符以上可以放宽（长口令本身就是强度）
 * - 不能等于用户名 / 包含用户名 / 等于当前密码
 * - 首尾不能有空白：复制粘贴时多一个空格，之后自己永远登不上
 */
export function checkPassword(
  password: string,
  opts: { username?: string; current?: string } = {},
): PasswordCheck {
  const strength = passwordStrength(password);
  const problems: string[] = [];
  const n = charLength(password);

  if (!password) problems.push('密码不能为空');
  if (n > 0 && n < PASSWORD_MIN) problems.push(`至少 ${PASSWORD_MIN} 个字符（现在是 ${n} 个）`);
  if (n > PASSWORD_MAX) problems.push(`最多 ${PASSWORD_MAX} 个字符`);
  if (password !== password.trim()) problems.push('首尾不要留空格');
  if (n >= PASSWORD_MIN && n < 16 && strength.facts.classes < 2) {
    problems.push('至少包含两类字符（小写、大写、数字、符号）');
  }
  if (COMMON.has(password.toLowerCase())) problems.push('这是常见弱密码，换一个');
  if (n >= PASSWORD_MIN && new Set(password).size <= 2) problems.push('重复字符太多');

  const uname = (opts.username ?? '').trim().toLowerCase();
  if (uname.length >= 3) {
    const low = password.toLowerCase();
    if (low === uname) problems.push('密码不能和用户名相同');
    else if (low.includes(uname)) problems.push('密码不能包含用户名');
  }
  if (opts.current && password === opts.current) problems.push('新密码不能和当前密码相同');

  return { ...strength, ok: problems.length === 0, problems };
}
