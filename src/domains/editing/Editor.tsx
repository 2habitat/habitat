/**
 * 编辑器（设计方案 §7）
 * 源码 + 预览 + 元数据表单；未知 frontmatter 字段原样保留；
 * 保存带基准修订；冲突给三方，只提供「重新载入 / 看差异 / 另存副本」；
 * 原件不给保存按钮，而不是保存后报错。
 */
import { useEffect, useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { Card, Chip, Empty, Spinner, Field, ErrorBox } from '../../components/ui.tsx';
import { useRep, useRefresh } from '../../services/use.ts';
import { endpoints, ApiError } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { navigate } from '../../app/router.ts';

const md = new MarkdownIt({ html: true, linkify: true });

interface Parsed { fm: Record<string, string>; body: string; rawFmKeys: string[] }

function splitDoc(raw: string): Parsed {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw, rawFmKeys: [] };
  const fm: Record<string, string> = {};
  const keys: string[] = [];
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    fm[k] = v;
    keys.push(k);
  }
  return { fm, body: raw.slice(m[0].length), rawFmKeys: keys };
}

const FORM_FIELDS = ['title', 'status', 'kind', 'tags', 'srcIds', 'source'] as const;
const STATUS_OPT = ['seedling', 'growing', 'evergreen'];
const KIND_OPT = ['point', 'summary', 'outline', 'question', 'report'];

export function EditorPage({ repId, noteId }: { repId?: string; noteId?: string }) {
  const id = repId ?? noteId ?? '';
  const { data, isLoading, error } = useRep(id);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const refresh = useRefresh();
  const [raw, setRaw] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'split' | 'source' | 'preview'>('split');
  // 「我打开时看到的那一份」。保存时当基准回传，服务端据此判断有没有人抢先改过。
  const [base, setBase] = useState<{ rev?: number; hash?: string; content?: string }>({});

  useEffect(() => {
    if (data) {
      setRaw(data.content);
      setBase({ rev: data.rep.rev, hash: data.hash, content: data.content });
      setDirty(false);
    }
  }, [data?.rep.id, data?.content, data?.hash]);

  const parsed = useMemo(() => splitDoc(raw), [raw]);

  if (!id) return <Empty title="没有选中对象" desc="从书架、检索或收件箱点进来" action={<button className="btn" onClick={() => navigate('shelf')}>去书架</button>} />;
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const locked = data.locked;
  const unknown = parsed.rawFmKeys.filter((k) => !FORM_FIELDS.includes(k as never) && !['id', 'type', 'schema', 'spaceId', 'createdAt', 'updatedAt', 'author', 'sensitivity', 'rev', 'repId', 'partId'].includes(k));

  function patch(key: string, value: string) {
    setRaw((r) => {
      const { rawFmKeys } = splitDoc(r);
      if (rawFmKeys.includes(key)) {
        return r.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${JSON.stringify(value)}`);
      }
      return r.replace(/^---\n/, `---\n${key}: ${JSON.stringify(value)}\n`);
    });
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    try {
      const { changeset } = await endpoints.propose(
        [{ t: 'setBody', id, body: parsed.body }],
        `编辑：${parsed.fm.title ?? id.slice(0, 16)}`,
        { [id]: base },
      );
      await endpoints.validate(changeset.id);
      const r = await endpoints.commit(changeset.id);
      if (!r.ok) throw new Error('撞车了');
      toast('已保存', 'ok');
      setDirty(false);
      refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.detail?.conflict) {
          openSheet('conflict', { conflict: e.detail.conflict, title: parsed.fm.title ?? '' });
        } else if (e.detail?.blocked) {
          toast(`校验没过：${e.detail.blocked.filter((b) => !b.ok).map((b) => `${b.label}（${b.detail}）`).join('；')}`, 'err');
        } else {
          toast(e.message, 'err');
        }
      } else {
        toast(e instanceof Error ? e.message : String(e), 'err');
      }
    } finally {
      setBusy(false);
    }
  }

  /** 选文件就传上去，然后把 markdown 贴到正文末尾——不打断正在写的东西 */
  async function upload(file: File) {
    try {
      const r = await endpoints.uploadAsset(file);
      const next = `${raw.replace(/\s*$/, '')}

${r.markdown}
`;
      setRaw(next);
      setDirty(true);
      toast(r.deduped ? '这张图库里已经有了，直接引用' : '已上传，记得保存', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  return (
    <div className="content-wide">
      <Card
        title={parsed.fm.title || '未命名'}
        desc={data.rep.path}
        actions={
          <>
            {locked && <Chip tone="warn" data-testid="editor-locked-chip">入库原件 · 只读</Chip>}
            {dirty && <Chip tone="danger">未保存</Chip>}
            {!locked && (
              <label className="btn btn-sm" style={{ cursor: 'pointer' }} data-testid="editor-attach">
                附件
                <input
                  type="file"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.currentTarget.value = '';
                    if (f) void upload(f);
                  }}
                />
              </label>
            )}
            <button className="btn btn-sm" onClick={() => setView('source')} aria-pressed={view === 'source'}>源码</button>
            <button className="btn btn-sm" onClick={() => setView('split')} aria-pressed={view === 'split'}>分栏</button>
            <button className="btn btn-sm" onClick={() => setView('preview')} aria-pressed={view === 'preview'}>预览</button>
            {!locked && (
              <button className="btn btn-sm btn-primary" onClick={() => void save()} disabled={!dirty || busy} data-testid="editor-save">
                {busy ? '保存中…' : '保存'}
              </button>
            )}
          </>
        }
      >
        {locked && (
          <div className="card" style={{ marginBottom: 12, borderColor: 'var(--warn)' }}>
            <div className="small">
              <strong>原件不可改，但可批注、可衍生，不改原文。</strong>
              <br />
              这是入库原件，界面上就不给保存按钮——而不是等你写完再报错。
              想加自己的东西，走「衍生笔记」或「批注」，原文一个字都不会动。
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btn-sm" onClick={() => openSheet('derive', { srcId: id, title: `${parsed.fm.title ?? ''} · 我的版本` })}>衍生一篇可改的</button>
              <button className="btn btn-sm" onClick={() => openSheet('annotate', { repId: id })}>加批注</button>
            </div>
          </div>
        )}

        <div className="grid" style={{ gridTemplateColumns: view === 'split' ? '1fr 1fr' : '1fr' }}>
          {view !== 'preview' && (
            <div>
              <div className="small muted" style={{ marginBottom: 4 }}>源码</div>
              <textarea
                className="textarea"
                style={{ minHeight: 460, fontFamily: 'var(--font-mono)' }}
                value={raw}
                readOnly={locked}
                data-testid="editor-source"
                onChange={(e) => { setRaw(e.target.value); setDirty(true); }}
              />
            </div>
          )}
          {view !== 'source' && (
            <div>
              <div className="small muted" style={{ marginBottom: 4 }}>预览</div>
              <div className="prose card" style={{ minHeight: 460, maxHeight: 620, overflowY: 'auto' }} data-testid="editor-preview"
                dangerouslySetInnerHTML={{ __html: md.render(parsed.body) }} />
            </div>
          )}
        </div>
      </Card>

      <Card title="元数据" desc="表单只覆盖自己认识的字段，其余原样保留">
        <div className="grid grid-2">
          <Field label="标题">
            <input className="input" value={parsed.fm.title ?? ''} readOnly={locked} data-testid="fm-title" onChange={(e) => patch('title', e.target.value)} />
          </Field>
          <Field label="状态" hint="seedling 未消化 · growing 在长 · evergreen 已定稿">
            <select className="select" value={parsed.fm.status ?? 'seedling'} disabled={locked} data-testid="fm-status" onChange={(e) => patch('status', e.target.value)}>
              {STATUS_OPT.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="类型">
            <select className="select" value={parsed.fm.kind ?? 'point'} disabled={locked} data-testid="fm-kind" onChange={(e) => patch('kind', e.target.value)}>
              {KIND_OPT.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="标签" hint="逗号分隔">
            <input className="input" value={parsed.fm.tags ?? ''} readOnly={locked} onChange={(e) => patch('tags', e.target.value)} />
          </Field>
        </div>

        {unknown.length > 0 && (
          <div className="small muted" style={{ marginTop: 8 }}>
            以下字段表单不认识，保存时会原样保留：{unknown.map((k) => <Chip key={k}>{k}</Chip>)}
          </div>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          <span className="small muted">修订 r{(data.rep as unknown as { rev?: number }).rev ?? 1} · 保存时会带上基准版本，撞车会给你三方对比</span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => openSheet('derive', { srcId: id, title: `${parsed.fm.title ?? ''} · 衍生` })} data-testid="editor-derive">衍生</button>
          <button className="btn btn-sm" onClick={() => openSheet('review', { id, title: parsed.fm.title ?? '' })}>回顾</button>
        </div>
      </Card>
    </div>
  );
}
