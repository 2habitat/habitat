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
    --bg:#f1ece1;--surface:#fbf7ed;--surface-2:#f6f1e5;--border:#e4dccb;--border-strong:#cdc2ac;
    --text:#1e1b17;--text-2:#4e483f;--text-3:#6f675b;
    --accent:#b0432b;--accent-ink:#8f3520;--accent-soft:#f6e3db;--accent-text:#fff;
    --danger:#a8332b;--danger-soft:#f7e6e2;--warn:#8d6118;--warn-soft:#f7edd8;--ok:#4d6b45;--info:#2f5d80;
    --radius:2px;
    --serif:"Noto Serif SC","Source Han Serif SC","Songti SC",STSong,SimSun,Georgia,serif;
    --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#121314;--surface:#1a1b1d;--surface-2:#202225;--border:#2f3236;--border-strong:#4a4f56;
      --text:#eae5da;--text-2:#b3ada1;--text-3:#8a8478;
      --accent:#d9756a;--accent-ink:#efb68f;--accent-soft:#3a221d;--accent-text:#1a1411;
      --danger:#d9756a;--danger-soft:#3a211e;--warn:#c8a05a;--warn-soft:#332a19;--ok:#8fae87;--info:#7fa8c4;
    }
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;background:var(--bg);color:var(--text);
    font:15px/1.7 "PingFang SC","HarmonyOS Sans SC","Noto Sans SC","Microsoft YaHei",-apple-system,sans-serif;
    display:grid;place-items:center;padding:clamp(16px,4vw,40px);
    background-image:radial-gradient(circle at 50% 0,color-mix(in srgb,var(--surface) 55%,transparent) 0,transparent 62%);
  }
  .wrap{width:min(430px,100%)}
  .brand{display:flex;align-items:center;gap:10px;margin:0 2px 16px}
  .seal{
    width:26px;height:26px;flex:none;display:grid;place-items:center;border-radius:var(--radius);
    background:var(--accent);color:var(--accent-text);font:600 15px/1 var(--serif);
  }
  .lockup{display:flex;flex-direction:column;line-height:1.15}
  .lockup b{font:600 14px/1.2 var(--serif);letter-spacing:.04em;color:var(--text)}
  .lockup i{font-style:normal;font-size:10px;letter-spacing:.18em;color:var(--text-3);margin-top:2px}
  .brand .stage{margin-left:auto;color:var(--text-3);font:10px/1.4 var(--mono);letter-spacing:.06em;text-align:right}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:clamp(22px,5vw,30px)}
  h1{margin:0 0 6px;font:600 clamp(22px,4.6vw,27px)/1.32 var(--serif);letter-spacing:.01em}
  .lede{margin:0 0 20px;color:var(--text-2);font-size:13px;line-height:1.75}
  .who{display:flex;align-items:center;gap:8px;margin-bottom:14px;color:var(--text-3);font:12px/1.5 var(--mono)}
  .who b{color:var(--text-2);font-weight:600}
  .chip{border:1px solid var(--border);border-radius:var(--radius);padding:0 7px;font-size:11px;color:var(--text-2)}
  form{margin:0}
  label{display:block;margin-bottom:14px}
  label>span{display:block;margin-bottom:5px;color:var(--text-2);font:10.5px/1.6 var(--mono);letter-spacing:.14em;text-transform:uppercase}
  input{
    width:100%;min-height:42px;padding:9px 11px;border:1px solid var(--border-strong);border-radius:var(--radius);
    background:var(--surface);color:var(--text);font:inherit;outline:none;
    transition:border-color .14s ease,box-shadow .14s ease;
  }
  input:focus{border-color:var(--text-3);box-shadow:0 0 0 3px color-mix(in srgb,var(--text) 7%,transparent)}
  button{
    width:100%;min-height:44px;margin-top:6px;border:0;border-radius:var(--radius);cursor:pointer;
    background:var(--accent);color:var(--accent-text);font:600 15px/1.4 inherit;letter-spacing:.02em;
    transition:filter .14s ease,transform .14s ease;
  }
  button:hover{filter:brightness(1.05)}
  button:active{transform:translateY(1px)}
  .msg{margin:0 0 14px;padding:9px 11px;border:1px solid transparent;border-left-width:2px;border-radius:var(--radius);font-size:13px;line-height:1.6}
  .msg-err{background:var(--danger-soft);color:var(--danger);border-left-color:var(--danger)}
  .msg-note{background:var(--accent-soft);color:var(--text-2);border-left-color:var(--accent)}
  .alt{margin-top:16px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--text-3);text-align:center}
  .alt a{color:var(--accent-ink);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}
  .alt a:hover{border-bottom-color:var(--accent)}
  .rules{margin:2px 0 16px;padding:0;list-style:none;font-size:12px;color:var(--text-3);line-height:1.9}
  .rules li::before{content:"·";margin-right:6px;color:var(--border-strong)}
  .meter{height:4px;background:var(--surface-2);overflow:hidden;margin:-4px 0 5px}
  .meter>i{display:block;height:100%;width:0;background:var(--danger);transition:width .16s ease,background .16s ease}
  .meter>i[data-level="2"]{background:var(--warn)}
  .meter>i[data-level="3"],.meter>i[data-level="4"]{background:var(--ok)}
  .meter-label{font:11px/1.5 var(--mono);color:var(--text-3);margin:0 0 14px;min-height:1.2em}
  footer{margin-top:14px;text-align:center;color:var(--text-3);font:10px/1.6 var(--mono);letter-spacing:.1em}
  @media (max-width:420px){ .card{padding:20px} h1{font-size:20px} .brand .stage{display:none} }
</style></head>
<body><div class="wrap">
  <div class="brand">
    <span class="seal" aria-hidden="true">栖</span>
    <span class="lockup"><b>Habitat</b><i>个人档案</i></span>
    <span class="stage">自托管 · 文件是事实源</span>
  </div>
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
