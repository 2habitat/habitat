/**
 * 账号与登录：自己的密码、账号列表、管理员重置。
 *
 * 改密仍然走服务端签发的会话：保存成功后服务端会换一张 Cookie，
 * 当前这台设备不掉线，其它设备上的旧会话全部作废。
 */
import { useState, type FormEvent } from 'react';
import { Card, Chip, Bar, Field, Spinner, ErrorBox, Empty } from '../../components/ui.tsx';
import { useMe, useAuthUsers } from '../../services/use.ts';
import { endpoints, ApiError, type AccountUser } from '../../services/api.ts';
import { passwordStrength } from '../../../shared/password.ts';
import { useUi } from '../../app/ui.ts';

function fmtTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const problems = e.detail?.problems;
    if (problems?.length) return problems.join('；');
  }
  return e instanceof Error ? e.message : String(e);
}

export function AccountPage() {
  const toast = useUi((s) => s.toast);
  const { data: me, isLoading, error, refetch } = useMe();
  const { data: users, refetch: refetchUsers } = useAuthUsers(!!me?.canManageUsers);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [saving, setSaving] = useState(false);

  const [newName, setNewName] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [newRole, setNewRole] = useState<'member' | 'owner'>('member');
  const [newPassword, setNewPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [temp, setTemp] = useState<{ username: string; password: string; kind: 'create' | 'reset' } | null>(null);
  const [rowBusy, setRowBusy] = useState('');

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  if (!me) return null;

  const strength = passwordStrength(next);

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setPwError('');
    if (next !== confirm) {
      setPwError('两次输入的新密码不一致。');
      return;
    }
    setSaving(true);
    try {
      await endpoints.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast('密码已更新；其它设备上的会话已失效', 'ok');
      await refetch();
    } catch (err) {
      setPwError(errText(err));
    } finally {
      setSaving(false);
    }
  }

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setTemp(null);
    try {
      const r = await endpoints.createUser({
        username: newName.trim(),
        displayName: newDisplay.trim() || undefined,
        role: newRole,
        password: newPassword.trim() || undefined,
      });
      if (r.tempPassword) setTemp({ username: r.user.username, password: r.tempPassword, kind: 'create' });
      else toast(`已创建 ${r.user.username}；该账号首次登录需要改密`, 'ok');
      setNewName('');
      setNewDisplay('');
      setNewPassword('');
      setNewRole('member');
      await refetchUsers();
    } catch (err) {
      toast(errText(err), 'err');
    } finally {
      setCreating(false);
    }
  }

  async function resetPassword(username: string) {
    if (!window.confirm(`重置 ${username} 的密码？\n\n会生成一串临时密码，该账号下次登录必须修改；现有会话立即失效。`)) return;
    setRowBusy(username);
    setTemp(null);
    try {
      const r = await endpoints.resetUserPassword(username);
      if (r.tempPassword) setTemp({ username, password: r.tempPassword, kind: 'reset' });
      await refetchUsers();
    } catch (err) {
      toast(errText(err), 'err');
    } finally {
      setRowBusy('');
    }
  }

  async function toggleDisabled(u: AccountUser) {
    const action = u.disabled ? '启用' : '停用';
    if (!u.disabled && !window.confirm(`停用 ${u.username}？\n\n该账号的现有会话会立即失效，之后可以再启用。`)) return;
    setRowBusy(u.username);
    try {
      await endpoints.updateUser(u.username, { disabled: !u.disabled });
      toast(`已${action} ${u.username}`, 'ok');
      await refetchUsers();
    } catch (err) {
      toast(errText(err), 'err');
    } finally {
      setRowBusy('');
    }
  }

  async function forceChange(u: AccountUser) {
    if (!window.confirm(`要求 ${u.username} 下次登录修改密码？\n\n如果对方正在使用，下一次请求就会被拦到改密页。`)) return;
    setRowBusy(u.username);
    try {
      await endpoints.updateUser(u.username, { mustChangePassword: true });
      toast(`已要求 ${u.username} 下次登录改密`, 'ok');
      await refetchUsers();
    } catch (err) {
      toast(errText(err), 'err');
    } finally {
      setRowBusy('');
    }
  }

  async function copyTemp() {
    if (!temp) return;
    try {
      await navigator.clipboard.writeText(temp.password);
      toast('临时密码已复制', 'ok');
    } catch {
      toast('复制失败，请手动选中', 'err');
    }
  }

  async function logout() {
    await endpoints.logout().catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className="content-wide">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>账号与登录</h2>
          <div className="small muted">人用密码，脚本用令牌；两条路互不影响。</div>
        </div>
      </div>

      {me.change?.required ? (
        <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: 12 }}>
          <strong style={{ color: 'var(--danger)' }}>{me.change.message}</strong>
          <div style={{ marginTop: 8 }}>
            <a className="btn btn-sm btn-primary" href="/change-password">去改密码</a>
          </div>
        </div>
      ) : null}

      {!me.user ? (
        <Card
          title={me.auth.mode === 'none' ? '没有启用登录' : '当前是令牌会话'}
          desc={me.auth.mode === 'none' ? '本机开发模式：所有请求直接放行' : '访问令牌足够读写整个空间，但不能管理账号'}
        >
          <p className="small" style={{ marginTop: 0 }}>
            {me.auth.mode === 'none'
              ? '这个实例没有启用登录（通常只在本机开发时这样）。'
              : '你正在用 HABITAT_TOKEN / KB_TOKEN 访问。要使用账号体系，先用管理员账号登录，或在服务器上运行：'}
          </p>
          <pre className="mono" style={{ background: 'var(--surface-2)', padding: 10, borderRadius: 6, overflowX: 'auto' }}>
{`habitat user add <用户名> --role owner
# 然后重启服务，用这个账号登录`}
          </pre>
          <button className="btn btn-sm" onClick={() => void logout()}>退出当前会话</button>
        </Card>
      ) : (
        <>
          <Card title="当前账号" desc={`${me.user.username} · ${me.user.role === 'owner' ? 'owner（可管理账号）' : 'member'}`}>
            <div className="grid grid-2">
              <div><span className="small muted">用户名</span><div className="mono">{me.user.username}</div></div>
              <div><span className="small muted">显示名</span><div>{me.user.displayName ?? '—'}</div></div>
              <div><span className="small muted">上次登录</span><div className="small">{fmtTime(me.user.lastLoginAt)}{me.user.lastLoginIp ? ` · ${me.user.lastLoginIp}` : ''}</div></div>
              <div><span className="small muted">密码更新</span><div className="small">{fmtTime(me.user.passwordUpdatedAt)}</div></div>
              <div>
                <span className="small muted">密码状态</span>
                <div style={{ marginTop: 3 }}>
                  {me.user.mustChangePassword
                    ? <Chip tone="warn">待修改</Chip>
                    : me.user.change.required
                      ? <Chip tone="warn">已过期</Chip>
                      : <Chip tone="ok">正常</Chip>}
                  <span className="small muted" style={{ marginLeft: 8 }}>{me.user.change.message}</span>
                </div>
              </div>
              <div>
                <span className="small muted">会话</span>
                <div style={{ marginTop: 3 }}><button className="btn btn-sm" onClick={() => void logout()}>退出登录</button></div>
              </div>
            </div>
          </Card>

          <Card title="修改密码" desc="改完立即生效；其它设备需要重新登录">
            <form onSubmit={(e) => void savePassword(e)} style={{ maxWidth: 620 }}>
              <Field label="当前密码" hint="用来确认是你本人">
                <input className="input" type="password" autoComplete="current-password" value={current}
                  onChange={(e) => setCurrent(e.target.value)} required />
              </Field>
              <Field label="新密码" hint="10–200 个字符；至少两类字符，16 个字符以上可放宽">
                <input className="input" type="password" autoComplete="new-password" value={next}
                  onChange={(e) => setNext(e.target.value)} required />
              </Field>
              <div style={{ marginTop: -6, marginBottom: 10 }}>
                <Bar value={strength.score / 4} />
                <div className="small muted" style={{ marginTop: 4 }}>
                  {next ? `${strength.label} · ${strength.facts.length} 个字符 · ${strength.facts.classes} 类字符` : '强度会在输入后显示'}
                </div>
              </div>
              <Field label="确认新密码">
                <input className="input" type="password" autoComplete="new-password" value={confirm}
                  onChange={(e) => setConfirm(e.target.value)} required />
              </Field>
              {pwError ? <div className="small" style={{ color: 'var(--danger)', marginBottom: 10 }}>{pwError}</div> : null}
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? '保存中…' : '保存新密码'}
              </button>
            </form>
          </Card>

          {me.canManageUsers ? (
            <Card title="账号管理" desc={`密码有效期 ${users?.passwordDays === 0 ? '不限' : `${users?.passwordDays ?? '—'} 天`} · 账号文件 ${users?.file ?? ''}`}>
              {temp ? (
                <div className="card" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', marginBottom: 12 }}>
                  <div className="row">
                    <strong>{temp.kind === 'create' ? '账号已创建' : '密码已重置'}：{temp.username}</strong>
                    <span className="spacer" />
                    <button className="btn btn-sm" onClick={() => void copyTemp()}>复制</button>
                  </div>
                  <div className="mono" style={{ fontSize: 'var(--fs-5)', marginTop: 6, letterSpacing: '.06em' }}>{temp.password}</div>
                  <div className="small" style={{ marginTop: 6 }}>
                    这串临时密码只显示这一次。交给对方后，其首次登录必须先改密码。
                  </div>
                </div>
              ) : null}

              <form onSubmit={(e) => void createUser(e)} style={{ marginBottom: 16 }}>
                <div className="row row-wrap" style={{ alignItems: 'flex-end' }}>
                  <div style={{ flex: '1 1 160px' }}>
                    <Field label="新用户名">
                      <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)}
                        placeholder="字母 / 数字 / 中文" autoComplete="off" required />
                    </Field>
                  </div>
                  <div style={{ flex: '1 1 140px' }}>
                    <Field label="显示名（可选）">
                      <input className="input" value={newDisplay} onChange={(e) => setNewDisplay(e.target.value)} autoComplete="off" />
                    </Field>
                  </div>
                  <div style={{ flex: '0 0 110px' }}>
                    <Field label="角色">
                      <select className="select" value={newRole} onChange={(e) => setNewRole(e.target.value as 'member' | 'owner')}>
                        <option value="member">member</option>
                        <option value="owner">owner</option>
                      </select>
                    </Field>
                  </div>
                  <div style={{ flex: '1 1 170px' }}>
                    <Field label="初始密码（可留空）">
                      <input className="input" type="password" value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)} placeholder="留空则自动生成" autoComplete="new-password" />
                    </Field>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <button className="btn btn-primary" type="submit" disabled={creating}>
                      {creating ? '创建中…' : '新建账号'}
                    </button>
                  </div>
                </div>
                <div className="small muted">无论是否填写初始密码，新账号首次登录都必须改密。</div>
              </form>

              {!users ? (
                <Spinner label="载入账号…" />
              ) : users.users.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>上次登录</th><th style={{ width: 230 }}>操作</th></tr>
                    </thead>
                    <tbody>
                      {users.users.map((u) => (
                        <tr key={u.username}>
                          <td>
                            <span className="mono">{u.username}</span>
                            {u.username === me.user?.username ? <span style={{ marginLeft: 6 }}><Chip tone="accent">我</Chip></span> : null}
                          </td>
                          <td>{u.displayName ?? '—'}</td>
                          <td><Chip>{u.role}</Chip></td>
                          <td>
                            {u.disabled ? <Chip tone="danger">已停用</Chip> : <Chip tone="ok">正常</Chip>}
                            {u.change.required ? <span style={{ marginLeft: 4 }}><Chip tone="warn">待改密</Chip></span> : null}
                          </td>
                          <td className="small muted">{fmtTime(u.lastLoginAt)}</td>
                          <td>
                            <div className="row" style={{ gap: 4 }}>
                              <button className="btn btn-sm" disabled={rowBusy === u.username} onClick={() => void resetPassword(u.username)}>
                                重置密码
                              </button>
                              <button className="btn btn-sm" disabled={rowBusy === u.username || u.username === me.user?.username}
                                onClick={() => void forceChange(u)}>
                                要求改密
                              </button>
                              <button className="btn btn-sm" disabled={rowBusy === u.username || u.username === me.user?.username}
                                onClick={() => void toggleDisabled(u)}>
                                {u.disabled ? '启用' : '停用'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="还没有其它账号" desc="新建一个 member，把链接分享出去时就不用给令牌了。" />
              )}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
