/**
 * 登录 / 强制改密的两个服务端页面。
 *
 * 为什么不做成 React：未登录时前端 bundle 根本不该被要求加载；
 * 一张自包含的表单没有依赖、没有白屏，手机上打开也快。
 * 视觉沿用凝脂：暖底、细边、无阴影、衬线标题。
 */
import type { PasswordChangeState } from './core/auth.ts';

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · Habitat</title>
<style>
  :root{
    --bg:#f7f6f3;--surface:#fffefb;--surface-2:#faf8f4;--border:#e3ddd3;--border-strong:#9c8e7a;
    --text:#2b2825;--text-2:#5f5952;--text-3:#6f665c;--accent:#7d5f42;--accent-soft:#f0e6da;
    --danger:#a8443a;--danger-soft:#f7e6e3;--warn:#a5761f;--ok:#4a7c59;--info:#3f6b8f;
    --accent-text:#fff;--radius:10px;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#16171a;--surface:#1e2024;--surface-2:#24272c;--border:#33373e;--border-strong:#666d76;
      --text:#e7e6e3;--text-2:#b0aea9;--text-3:#96928b;--accent:#c9a37a;--accent-soft:#2f2a22;
      --danger:#d98b80;--danger-soft:#30211f;--warn:#d3ab5e;--ok:#7fb99a;--info:#7fa8c4;
      --accent-text:#1a1815;
    }
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;background:var(--bg);color:var(--text);
    font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    display:grid;place-items:center;padding:clamp(16px,4vw,40px);
  }
  .wrap{width:min(420px,100%)}
  .brand{display:flex;align-items:baseline;gap:8px;margin:0 2px 14px;color:var(--text-2);font-size:13px}
  .mark{width:9px;height:9px;border-radius:50%;background:var(--accent);display:inline-block;transform:translateY(-1px)}
  .brand b{color:var(--text);font:600 15px/1 Georgia,"Songti SC",serif;letter-spacing:.02em}
  .brand .stage{margin-left:auto;color:var(--text-3);font-size:11px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:clamp(22px,5vw,30px)}
  h1{margin:0 0 6px;font:600 22px/1.35 Georgia,"Songti SC","Songti TC",serif;letter-spacing:.01em}
  .lede{margin:0 0 20px;color:var(--text-2);font-size:13px;line-height:1.7}
  .who{display:flex;align-items:center;gap:8px;margin-bottom:14px;color:var(--text-3);font-size:12px}
  .who b{color:var(--text-2);font-weight:600}
  .chip{border:1px solid var(--border);border-radius:99px;padding:0 8px;font-size:11px;color:var(--text-2)}
  form{margin:0}
  label{display:block;margin-bottom:14px}
  label>span{display:block;margin-bottom:5px;color:var(--text-2);font-size:12px;font-weight:600}
  input{
    width:100%;min-height:42px;padding:9px 11px;border:1px solid var(--border-strong);border-radius:8px;
    background:var(--surface);color:var(--text);font:inherit;outline:none;
  }
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  button{
    width:100%;min-height:44px;margin-top:6px;border:0;border-radius:8px;cursor:pointer;
    background:var(--accent);color:var(--accent-text);font:600 15px/1.4 inherit;
  }
  button:hover{filter:brightness(1.06)}
  button:active{transform:translateY(1px)}
  .msg{margin:0 0 14px;padding:9px 11px;border-radius:8px;font-size:13px;line-height:1.6;border:1px solid transparent}
  .msg-err{background:var(--danger-soft);color:var(--danger)}
  .msg-note{background:var(--accent-soft);color:var(--text-2)}
  .alt{margin-top:16px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--text-3);text-align:center}
  .alt a{color:var(--accent);text-decoration:none}
  .alt a:hover{text-decoration:underline}
  .rules{margin:2px 0 16px;padding:0;list-style:none;font-size:12px;color:var(--text-3);line-height:1.9}
  .rules li::before{content:"·";margin-right:6px;color:var(--border-strong)}
  .meter{height:6px;border-radius:99px;background:var(--surface-2);overflow:hidden;margin:-4px 0 5px}
  .meter>i{display:block;height:100%;width:0;background:var(--danger);border-radius:99px;transition:width .16s ease,background .16s ease}
  .meter>i[data-level="2"]{background:var(--warn)}
  .meter>i[data-level="3"],.meter>i[data-level="4"]{background:var(--ok)}
  .meter-label{font-size:11px;color:var(--text-3);margin:0 0 14px;min-height:1.2em}
  footer{margin-top:14px;text-align:center;color:var(--text-3);font-size:11px;letter-spacing:.02em}
  @media (max-width:420px){ .card{padding:20px} h1{font-size:20px} }
</style></head>
<body><div class="wrap">
  <div class="brand"><span class="mark"></span><b>Habitat</b><span class="stage">自托管 · 文件是事实源</span></div>
  <main class="card">${body}</main>
  <footer>数据不离开这台机器</footer>
</div>${script}</body></html>`;
}

export interface LoginPageOpts {
  passwordEnabled: boolean;
  tokenEnabled: boolean;
  mode?: 'password' | 'token';
  error?: string;
  notice?: string;
  username?: string;
  next?: string;
  /** 被节流时给出的剩余秒数 */
  lockedSeconds?: number;
}

export function loginPage(o: LoginPageOpts): string {
  const mode = (o.mode === 'token' && o.tokenEnabled) || !o.passwordEnabled ? 'token' : 'password';
  const next = escapeHtml(o.next || '/');
  const err = o.error && !o.lockedSeconds
    ? `<div class="msg msg-err" role="alert">${escapeHtml(o.error)}</div>`
    : '';
  const notice = o.notice ? `<div class="msg msg-note">${escapeHtml(o.notice)}</div>` : '';
  const locked = o.lockedSeconds
    ? `<div class="msg msg-err" role="alert">尝试次数过多，请 ${Math.max(1, Math.ceil(o.lockedSeconds / 60))} 分钟后再试。</div>`
    : '';

  const passwordForm = `
    <form method="post" action="/login" autocomplete="on">
      <input type="hidden" name="mode" value="password">
      <input type="hidden" name="next" value="${next}">
      <label><span>用户名</span>
        <input name="username" value="${escapeHtml(o.username ?? '')}" autocomplete="username"
               autocapitalize="none" spellcheck="false" autofocus required>
      </label>
      <label><span>密码</span>
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit">进入</button>
    </form>`;

  const tokenForm = `
    <form method="post" action="/login">
      <input type="hidden" name="mode" value="token">
      <input type="hidden" name="next" value="${next}">
      <label><span>访问令牌</span>
        <input name="token" type="password" autocomplete="off" spellcheck="false"
               placeholder="HABITAT_TOKEN / KB_TOKEN" autofocus required>
      </label>
      <button type="submit">进入</button>
    </form>`;

  let alt = '';
  if (o.passwordEnabled && o.tokenEnabled) {
    alt = mode === 'password'
      ? `<a href="/login?mode=token&amp;next=${encodeURIComponent(o.next || '/')}">改用访问令牌登录</a>`
      : `<a href="/login?mode=password&amp;next=${encodeURIComponent(o.next || '/')}">改用用户名密码登录</a>`;
  }

  const body = `
    <h1>${mode === 'password' ? '进入你的空间' : '用令牌进入'}</h1>
    <p class="lede">${mode === 'password'
      ? '登录只负责把门，内容仍然是硬盘上的 Markdown。'
      : '令牌是给脚本和 Agent 用的机器凭据。'}</p>
    ${notice}${locked}${err}
    ${mode === 'password' ? passwordForm : tokenForm}
    ${alt ? `<div class="alt">${alt}</div>` : ''}`;

  return shell('登录', body);
}

export interface ChangePasswordPageOpts {
  username: string;
  displayName?: string;
  change: PasswordChangeState;
  error?: string;
  next?: string;
}

export function changePasswordPage(o: ChangePasswordPageOpts): string {
  const next = escapeHtml(o.next || '/');
  const err = o.error ? `<div class="msg msg-err" role="alert">${escapeHtml(o.error)}</div>` : '';
  const note = o.change.required
    ? `<div class="msg msg-note">${escapeHtml(o.change.message)}</div>`
    : `<div class="msg msg-note">你正在主动修改密码。${escapeHtml(o.change.message)}</div>`;

  const body = `
    <div class="who"><b>${escapeHtml(o.displayName || o.username)}</b><span>@${escapeHtml(o.username)}</span><span class="chip">改密后其它设备需要重新登录</span></div>
    <h1>设置新密码</h1>
    <p class="lede">当前密码只用来确认是你本人；新密码保存后立即生效。</p>
    ${note}${err}
    <form method="post" action="/change-password" autocomplete="off">
      <input type="hidden" name="next" value="${next}">
      <label><span>当前密码</span>
        <input name="current" type="password" autocomplete="current-password" autofocus required>
      </label>
      <label><span>新密码</span>
        <input name="nextPassword" id="new-password" type="password" autocomplete="new-password" required>
      </label>
      <div class="meter" aria-hidden="true"><i id="pw-bar"></i></div>
      <div class="meter-label" id="pw-label">至少 10 个字符，至少两类字符</div>
      <label><span>确认新密码</span>
        <input name="confirm" type="password" autocomplete="new-password" required>
      </label>
      <ul class="rules">
        <li>10–200 个字符；16 个字符以上可以放宽字符种类</li>
        <li>不能包含用户名，不能和当前密码相同</li>
        <li>首尾不要带空格</li>
      </ul>
      <button type="submit">保存并继续</button>
    </form>
    <div class="alt"><a href="/logout">退出登录</a></div>`;

  const script = `<script>
(function(){
  var pw=document.getElementById('new-password');
  var bar=document.getElementById('pw-bar');
  var label=document.getElementById('pw-label');
  if(!pw||!bar||!label) return;
  function score(v){
    if(!v) return [0,'至少 10 个字符，至少两类字符'];
    var n=[...v].length,c=0;
    if(/[a-z]/.test(v))c+=1;
    if(/[A-Z]/.test(v))c+=1;
    if(/[0-9]/.test(v))c+=1;
    if(/[^A-Za-z0-9]/.test(v))c+=1;
    var s=0;
    if(n>=10)s+=1;
    if(n>=14)s+=1;
    if(c>=2)s+=1;
    if(c>=3)s+=1;
    if(n>=20)s+=1;
    s=Math.min(4,s);
    return [s,['太短','弱','一般','较强','很强'][s]+'（'+n+' 个字符）'];
  }
  function update(){
    var r=score(pw.value);
    bar.style.width=(r[0]/4*100)+'%';
    bar.setAttribute('data-level',String(r[0]));
    label.textContent=r[1];
  }
  pw.addEventListener('input',update);
  update();
})();
</script>`;

  return shell('设置新密码', body, script);
}
