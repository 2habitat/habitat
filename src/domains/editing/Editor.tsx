/**
 * 编辑器（设计方案 §7）
 * 源码 + 预览 + 元数据表单；未知 frontmatter 字段原样保留；
 * 保存带基准修订；冲突给三方，只提供「重新载入 / 看差异 / 另存副本」；
 * 原件不给保存按钮，而不是保存后报错。
 *
 * 版式上它是一张「工作台」：抬头常驻（标题、路径、保存状态），
 * 两栏纸面并排，元数据收在下面。⌘S 保存、有改动关页会拦一下。
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, Chip, Empty, PageSkeleton, Field, ErrorBox } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { useRep, useRefresh } from '../../services/use.ts';
import { endpoints, ApiError } from '../../services/api.ts';
import { renderMarkdown } from '../../services/markdown.ts';
import { useUi } from '../../app/ui.ts';
import { navigate } from '../../app/router.ts';
import { NOTE_STATUS } from '../../app/labels.ts';

interface Parsed { fm: Record<string, string>; body: string; rawFmKeys: string[] }

function splitDoc(raw: string): Parsed {
  // 文件可能是 CRLF：先归一，否则 `---\r\n` 匹配不上，整块 YAML 会当正文
  const src = raw.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { fm: {}, body: src, rawFmKeys: [] };
  const fm: Record<string, string> = {};
  const keys: string[] = [];
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    // 行内数组 tags: [a, b] → 表单里是「a, b」，改完再按数组写回去
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).trim();
    fm[k] = v;
    keys.push(k);
  }
  return { fm, body: src.slice(m[0].length), rawFmKeys: keys };
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
  // 记住上次选的视图：短笔记用分栏其实是在浪费半屏，长笔记又必须分栏
  const [view, setView] = useState<'split' | 'source' | 'preview'>(() => {
    const v = localStorage.getItem('habitat.editorView');
    return v === 'source' || v === 'preview' || v === 'split' ? v : 'split';
  });
  const pickView = (v: 'split' | 'source' | 'preview') => {
    setView(v);
    try { localStorage.setItem('habitat.editorView', v); } catch { /* 隐私模式 */ }
  };
  // 写正文时不该被 13 行 frontmatter 挤在屏幕下半截：默认只显示正文，要看原文再展开
  const [showFm, setShowFm] = useState(false);
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
  /** 含分隔符的 frontmatter 原文；收起时把它拼回 textarea 之前 */
  const fmBlock = useMemo(() => {
    const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(raw);
    return m ? m[0] : '';
  }, [raw]);
  const bodyOnly = raw.slice(fmBlock.length);
  const fmCount = parsed.rawFmKeys.length;
  const locked = !!data?.locked;
  const unknown = parsed.rawFmKeys.filter((k) => !FORM_FIELDS.includes(k as never) && !['id', 'type', 'schema', 'spaceId', 'createdAt', 'updatedAt', 'author', 'sensitivity', 'rev', 'repId', 'partId'].includes(k));

  function patch(key: string, value: string) {
    setRaw((r) => {
      // 归一换行后再改：CRLF 文件里 `^---\n` 找不到，会把 frontmatter 再插一份
      const src = r.replace(/\r\n/g, '\n');
      const { rawFmKeys } = splitDoc(src);
      if (rawFmKeys.includes(key)) {
        return src.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${JSON.stringify(value)}`);
      }
      return src.replace(/^---\n/, `---\n${key}: ${JSON.stringify(value)}\n`);
    });
    setDirty(true);
  }

  async function save() {
    if (!data || data.locked || !dirty || busy) return;
    setBusy(true);
    try {
      // 正文走 setBody，元数据走 update：两条路都提交，表单里改的才不会白改
      const beforeFm = splitDoc(base.content ?? '').fm;
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'status', 'kind'] as const) {
        const now = parsed.fm[k];
        if (now !== undefined && now !== (beforeFm[k] ?? '')) patch[k] = now;
      }
      if (parsed.fm.tags !== undefined && parsed.fm.tags !== (beforeFm.tags ?? '')) {
        patch.tags = parsed.fm.tags.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const ops: unknown[] = [{ t: 'setBody', id, body: parsed.body }];
      if (Object.keys(patch).length) ops.push({ t: 'update', id, patch });

      const { changeset } = await endpoints.propose(ops, `编辑：${parsed.fm.title ?? id.slice(0, 16)}`, { [id]: base });
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
          toast(`校验没过：${e.detail.blocked.filter((b: { ok: boolean }) => !b.ok).map((b: { label: string; detail: string }) => `${b.label}（${b.detail}）`).join('；')}`, 'err');
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

  // ⌘S / Ctrl+S 保存；有未保存改动时关页拦一下。这是编辑器该有的基本礼貌。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

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

  if (!id) return <Empty title="没有选中对象" desc="从书架、检索或收件箱点进来" action={<button className="btn" onClick={() => navigate('shelf')}>去书架</button>} />;
  if (isLoading) return <PageSkeleton rows={3} />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const lines = raw.split('\n').length;
  // 没有 title 字段时，用正文第一行兜底——比"未命名"有用得多
  const firstLine = parsed.body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l.length > 0) ?? '';
  const title = parsed.fm.title || (firstLine ? firstLine.slice(0, 42) : '未命名');

  return (
    <div className="editor">
      <header className="editor-head">
        <div className="editor-ident">
          <p className="eyebrow">知识 · 编辑</p>
          {locked ? (
            <h1 className="editor-title">{title}</h1>
          ) : (
            <input
              className="editor-title editor-title-input"
              value={parsed.fm.title ?? ''}
              placeholder={title}
              aria-label="标题"
              data-testid="editor-title"
              onChange={(e) => patch('title', e.target.value)}
            />
          )}
          <div className="editor-path mono" title={data.rep.path}>{data.rep.path}</div>
          {noteId && !repId && (
            <div className="editor-hint" data-testid="editor-note-hint">笔记也能像书一样阅读；阅读时点「编辑」回来改。</div>
          )}
        </div>

        <div className="editor-actions">
          {(repId || noteId) && (
            <button
              className="btn btn-sm"
              onClick={() => (
                noteId
                  ? navigate('reader', { note: data.rep.id })
                  : navigate('reader', { work: data.rep.workId, rep: data.rep.id })
              )}
              data-testid="editor-read"
              title={noteId ? '像读书一样阅读这篇笔记' : '在阅读器中打开这一章'}
            >
              <Icon name="shelf" size={13} />
              阅读
            </button>
          )}
          {locked && <Chip tone="warn" data-testid="editor-locked-chip">入库原件 · 只读</Chip>}

          <div className="seg" role="group" aria-label="视图">
            {([['source', '源码'], ['split', '分栏'], ['preview', '预览']] as const).map(([v, label]) => (
              <button key={v} className="seg-item" aria-pressed={view === v} onClick={() => pickView(v)}>{label}</button>
            ))}
          </div>

          {!locked && (
            <label className="btn btn-sm" style={{ cursor: 'pointer' }} data-testid="editor-attach">
              <Icon name="files" size={13} />
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
          {!locked && (
            <button
              className={`btn btn-sm ${dirty ? 'btn-primary' : 'btn-quiet'}`}
              onClick={() => void save()}
              disabled={!dirty || busy}
              data-testid="editor-save"
              title={dirty ? '有未保存的改动' : '已保存'}
            >
              {busy ? '保存中…' : dirty ? '保存' : '已保存'}
              {dirty ? <kbd className="kbd">⌘S</kbd> : <Icon name="check" size={12} />}
            </button>
          )}
        </div>
      </header>

      {locked && (
        <div className="notice">
          <strong>原件不可改，但可批注、可衍生，不改原文。</strong>
          <span>这是入库原件，界面上就不给保存按钮——而不是等你写完再报错。</span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => openSheet('derive', { srcId: id, title: `${parsed.fm.title ?? ''} · 我的版本` })}>衍生一篇可改的</button>
          <button className="btn btn-sm" onClick={() => openSheet('annotate', { repId: id })}>加批注</button>
        </div>
      )}

      <div className="editor-panes" data-view={view}>
        <section className="pane" aria-label="源码">
          <div className="pane-head">
            <span>正文</span>
            <button
              className="pane-toggle mono"
              onClick={() => setShowFm((v) => !v)}
              aria-pressed={showFm}
              data-testid="editor-toggle-fm"
              title={showFm ? '收起元数据，只看正文' : '展开 frontmatter 原文'}
            >
              {showFm ? '收起元数据' : `元数据 ${fmCount} 项`}
            </button>
            <span className="pane-meta mono">{(showFm ? raw : bodyOnly).split('\n').length} 行</span>
          </div>
          <textarea
            className="editor-source"
            value={showFm ? raw : bodyOnly}
            readOnly={locked}
            spellCheck={false}
            data-testid="editor-source"
            onChange={(e) => {
              const v = e.target.value;
              setRaw(showFm ? v : fmBlock + v);
              setDirty(true);
            }}
          />
        </section>

        <section className="pane" aria-label="预览">
          <div className="pane-head">
            <span>预览</span>
            <span className="pane-meta mono">跟随阅读设置</span>
          </div>
          <div
            className="prose editor-preview"
            data-testid="editor-preview"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.body) }}
          />
        </section>
      </div>

      <Card className="panel editor-meta" title="元数据" desc="表单只覆盖自己认识的字段，其余原样保留">
        <div className="grid grid-2">
          <Field label="标题">
            <input className="input" value={parsed.fm.title ?? ''} readOnly={locked} data-testid="fm-title" onChange={(e) => patch('title', e.target.value)} />
          </Field>
          <Field label="状态" hint="幼苗未消化 · 生长中 · 常青已定稿">
            <select className="select" value={parsed.fm.status ?? 'seedling'} disabled={locked} data-testid="fm-status" onChange={(e) => patch('status', e.target.value)}>
              {STATUS_OPT.map((s) => <option key={s} value={s}>{NOTE_STATUS[s] ?? s}</option>)}
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
          <div className="small muted" style={{ marginTop: 4 }}>
            以下字段表单不认识，保存时会原样保留：
            {unknown.map((k) => <Chip key={k} style={{ marginLeft: 4 }}>{k}</Chip>)}
          </div>
        )}

        <div className="editor-meta-foot">
          <span className="mono">修订 r{(data.rep as unknown as { rev?: number }).rev ?? 1} · 保存带基准版本，撞车给三方对比</span>
          <span className="spacer" />
          <button className="btn btn-sm btn-quiet" onClick={() => openSheet('derive', { srcId: id, title: `${parsed.fm.title ?? ''} · 衍生` })} data-testid="editor-derive">衍生</button>
          <button className="btn btn-sm btn-quiet" onClick={() => openSheet('review', { id, title: parsed.fm.title ?? '' })}>回顾</button>
        </div>
      </Card>
    </div>
  );
}
