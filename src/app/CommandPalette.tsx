/** 命令面板：⌘K / Ctrl+K。快速采集、跳转、跑系统动作。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUi } from './ui.ts';
import { navigate, ROUTES } from './router.ts';
import { endpoints } from '../services/api.ts';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const openSheet = useUi((s) => s.openSheet);
  const setTheme = useUi((s) => s.setTheme);
  const toast = useUi((s) => s.toast);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const cmds = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = ROUTES.filter((r) => !['reader', 'editor'].includes(r.id)).map((r) => ({
      id: `go-${r.id}`, label: `去「${r.title}」`, hint: `${r.group} · ${r.path}`, group: '跳转', run: () => navigate(r.id),
    }));
    const acts: Cmd[] = [
      { id: 'capture', label: '采集一条', hint: '落到收件箱', group: '新建', run: () => openSheet('capture') },
      { id: 'task', label: '新建任务', hint: '加入 work/actions/tasks.md', group: '新建', run: () => openSheet('task') },
      { id: 'event', label: '新建日程', hint: '排进 work/events/', group: '新建', run: () => openSheet('event') },
      { id: 'project', label: '新建项目', hint: 'work/projects/', group: '新建', run: () => openSheet('project') },
      { id: 'journal', label: '补一条事件', hint: '外部 Agent 记账', group: '新建', run: () => openSheet('journal') },
      { id: 'proposal', label: '生成 AI 提案', hint: '要人确认才落盘', group: '新建', run: () => openSheet('proposal') },
      {
        id: 'reconcile', label: '对账一次', hint: '找出没留痕的改动', group: '系统',
        run: async () => {
          const r = await endpoints.reconcile();
          toast(r.report.unsigned.length ? `发现 ${r.report.unsigned.length} 处未署名改动` : '没有未署名改动', r.report.unsigned.length ? 'err' : 'ok');
          navigate('agent');
        },
      },
      {
        id: 'reindex', label: '重建索引', hint: 'SQLite 是派生的，随时可重建', group: '系统',
        run: async () => { await endpoints.reindex(); toast('索引已重建', 'ok'); },
      },
      { id: 'theme-1', label: '主题：凝脂', group: '外观', run: () => setTheme('ningzhi') },
      { id: 'theme-2', label: '主题：漂青', group: '外观', run: () => setTheme('piaoqing') },
      { id: 'theme-3', label: '主题：玄墨', group: '外观', run: () => setTheme('xuanmo') },
    ];
    const searchCmd: Cmd[] = q.trim()
      ? [{ id: 'search', label: `全库检索「${q.trim()}」`, hint: '打开检索页', group: '检索', run: () => navigate('search', { q: q.trim() }) }]
      : [];
    return [...searchCmd, ...acts, ...nav];
  }, [q, openSheet, setTheme, toast]);

  const hits = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return cmds.slice(0, 60);
    const hit = (c: Cmd) => (c.label + c.hint + c.group).toLowerCase().includes(k);
    const list = cmds.filter(hit);
    // 「全库检索」只是顺手带的，真正的命令要排前面，否则输「对账」回车会跳到检索页去
    const score = (c: Cmd) => (c.id === 'search' ? 2 : c.label.toLowerCase().includes(k) ? 0 : 1);
    return list.sort((a, b) => score(a) - score(b)).slice(0, 60);
  }, [cmds, q]);

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  if (!open) return null;

  function run(i: number) {
    const c = hits[i];
    if (!c) return;
    setOpen(false);
    void c.run();
  }

  return (
    <div className="overlay overlay-center" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" data-testid="palette">
        <input
          className="palette-input"
          placeholder="输入命令，或输入关键词检索全库…"
          value={q}
          data-testid="palette-input"
          data-autofocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === 'Enter') { e.preventDefault(); run(active); }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {hits.length === 0 && <div className="empty small">没有匹配的命令</div>}
          {hits.map((c, i) => (
            <button
              key={c.id}
              className="palette-item"
              data-active={i === active ? '1' : '0'}
              data-testid="palette-item"
              onMouseEnter={() => setActive(i)}
              onClick={() => run(i)}
            >
              <span className="chip">{c.group}</span>
              <span>{c.label}</span>
              {c.hint && <span className="palette-kbd">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
