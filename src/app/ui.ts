/** 只放 UI 状态，不镜像服务端数据 */
import { create } from 'zustand';
import { openPeek as navOpenPeek, closePeek as navClosePeek } from './router.ts';
import type { ApprovalPolicy, ContextRef } from '../../shared/agent.ts';

export type Theme = 'ningzhi' | 'piaoqing' | 'xuanmo';
export type ReaderFont = 'serif' | 'sans';
export type SheetKind =
  | 'capture' | 'derive' | 'annotate' | 'task' | 'event' | 'project'
  | 'review' | 'conflict' | 'journal' | 'proposal' | 'notifications' | null;

export interface AiContext {
  kind: 'work' | 'part' | 'rep' | 'note' | 'action' | 'none';
  id: string;
  title: string;
  quote?: string;
  revision?: number;
}

export type AiSurface = 'dock' | 'float';
export interface AiFloatBox { x: number; y: number; w: number; h: number }

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err' | 'info';
}

interface UiState {
  theme: Theme;
  fontSize: 'sm' | 'md' | 'lg';
  radius: 'sharp' | 'soft' | 'round';
  collapsed: boolean;
  /** 移动端抽屉是否打开；桌面端不用它 */
  drawer: boolean;
  /** 阅读行宽，方案要求「可调」；full = 铺满可用宽度（宽表格/多列文档） */
  readingWidth: 'narrow' | 'normal' | 'wide' | 'full';
  /** 正文字号（px），Aa 面板可调；行宽会跟着字号一起缩放 */
  readerSize: number;
  /** 正文字体：黑体（默认）/ 宋体 */
  readerFont: ReaderFont;
  /** 段首缩进 2em：中文书籍习惯，默认关 */
  readerIndent: boolean;
  /** 书架默认展示：封面墙还是紧凑列表 */
  shelfView: 'grid' | 'list';
  aiOpen: boolean;
  aiCtx: AiContext;
  aiSurface: AiSurface;
  aiDockWidth: number;
  aiFloat: AiFloatBox;
  aiHarnessId: string;
  aiSkillId: string;
  aiRefs: ContextRef[];
  aiApprovals: ApprovalPolicy;
  paletteOpen: boolean;
  sheet: { kind: SheetKind; props: Record<string, unknown>; onDone?: () => void } | null;
  toasts: Toast[];

  setTheme: (t: Theme) => void;
  setFontSize: (t: 'sm' | 'md' | 'lg') => void;
  setRadius: (t: 'sharp' | 'soft' | 'round') => void;
  toggleCollapsed: () => void;
  setDrawer: (v: boolean) => void;
  setReadingWidth: (w: 'narrow' | 'normal' | 'wide' | 'full') => void;
  setReaderSize: (n: number) => void;
  setReaderFont: (f: ReaderFont) => void;
  setReaderIndent: (v: boolean) => void;
  setShelfView: (v: 'grid' | 'list') => void;
  openAi: (ctx?: Partial<AiContext>) => void;
  closeAi: () => void;
  setAiCtx: (ctx: Partial<AiContext>) => void;
  setAiSurface: (s: AiSurface) => void;
  setAiDockWidth: (n: number) => void;
  setAiFloat: (b: Partial<AiFloatBox>) => void;
  setAiHarness: (id: string) => void;
  setAiSkill: (id: string) => void;
  addAiRef: (ref: ContextRef) => void;
  removeAiRef: (id: string) => void;
  clearAiRefs: () => void;
  setAiApprovals: (p: Partial<ApprovalPolicy>) => void;
  setPalette: (v: boolean) => void;
  openSheet: (kind: Exclude<SheetKind, null>, props?: Record<string, unknown>, onDone?: () => void) => void;
  closeSheet: () => void;
  openPeek: (id: string) => void;
  closePeek: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('habitat.ui') ?? '{}') as Partial<UiState>;
  } catch {
    return {};
  }
})();

function persist(s: Pick<UiState,
  'theme' | 'fontSize' | 'radius' | 'collapsed' | 'readingWidth' | 'readerSize' | 'readerFont' | 'readerIndent' | 'shelfView'
  | 'aiSurface' | 'aiDockWidth' | 'aiFloat'
>): void {
  try {
    localStorage.setItem('habitat.ui', JSON.stringify({
      theme: s.theme, fontSize: s.fontSize, radius: s.radius, collapsed: s.collapsed,
      readingWidth: s.readingWidth, readerSize: s.readerSize, readerFont: s.readerFont,
      readerIndent: s.readerIndent, shelfView: s.shelfView,
      aiSurface: s.aiSurface, aiDockWidth: s.aiDockWidth, aiFloat: s.aiFloat,
    }));
  } catch {
    /* 隐私模式下写不了就算了 */
  }
}

let toastSeq = 1;

export const useUi = create<UiState>((set, get) => ({
  theme: saved.theme ?? 'ningzhi',
  fontSize: saved.fontSize ?? 'md',
  readingWidth: saved.readingWidth ?? 'normal',
  readerSize: typeof saved.readerSize === 'number' ? Math.min(20, Math.max(15, saved.readerSize)) : 17,
  readerFont: saved.readerFont === 'serif' ? 'serif' : 'sans',
  readerIndent: saved.readerIndent === true,
  shelfView: saved.shelfView ?? 'grid',
  drawer: false,
  radius: saved.radius ?? 'soft',
  collapsed: saved.collapsed ?? false,
  aiOpen: false,
  aiCtx: { kind: 'none', id: '', title: '全局' },
  aiSurface: saved.aiSurface === 'float' ? 'float' : 'dock',
  aiDockWidth: typeof saved.aiDockWidth === 'number' ? Math.min(520, Math.max(320, saved.aiDockWidth)) : 380,
  aiFloat: saved.aiFloat && typeof saved.aiFloat === 'object'
    ? {
        x: Number(saved.aiFloat.x) || 24, y: Number(saved.aiFloat.y) || 80,
        w: Math.min(720, Math.max(360, Number(saved.aiFloat.w) || 440)),
        h: Math.min(900, Math.max(420, Number(saved.aiFloat.h) || 640)),
      }
    : { x: 24, y: 80, w: 440, h: 640 },
  aiHarnessId: '',
  aiSkillId: 'none',
  aiRefs: [],
  aiApprovals: { annotations: 'ask', body: 'ask' },
  paletteOpen: false,
  sheet: null,
  toasts: [],

  setTheme: (theme) => { set({ theme }); persist(get()); },
  setFontSize: (fontSize) => { set({ fontSize }); persist(get()); },
  setDrawer: (drawer) => set({ drawer }),
  setReadingWidth: (readingWidth) => { set({ readingWidth }); persist(get()); },
  setReaderSize: (readerSize) => { set({ readerSize: Math.min(20, Math.max(15, readerSize)) }); persist(get()); },
  setReaderFont: (readerFont) => { set({ readerFont }); persist(get()); },
  setReaderIndent: (readerIndent) => { set({ readerIndent }); persist(get()); },
  setShelfView: (shelfView) => { set({ shelfView }); persist(get()); },
  setRadius: (radius) => { set({ radius }); persist(get()); },
  toggleCollapsed: () => { set({ collapsed: !get().collapsed }); persist(get()); },

  openAi: (ctx) => set({ aiOpen: true, aiCtx: { ...get().aiCtx, ...ctx } as AiContext }),
  closeAi: () => set({ aiOpen: false }),
  setAiCtx: (ctx) => set({ aiCtx: { ...get().aiCtx, ...ctx } as AiContext }),
  setAiSurface: (aiSurface) => { set({ aiSurface }); persist(get()); },
  setAiDockWidth: (n) => {
    set({ aiDockWidth: Math.min(520, Math.max(320, n)) });
    persist(get());
  },
  setAiFloat: (b) => {
    const cur = get().aiFloat;
    set({ aiFloat: { ...cur, ...b } });
    persist(get());
  },
  setAiHarness: (aiHarnessId) => set({ aiHarnessId }),
  setAiSkill: (aiSkillId) => set({ aiSkillId }),
  addAiRef: (ref) => {
    const cur = get().aiRefs.filter((r) => r.id !== ref.id);
    set({ aiRefs: [...cur, ref].slice(-5) });
  },
  removeAiRef: (id) => set({ aiRefs: get().aiRefs.filter((r) => r.id !== id) }),
  clearAiRefs: () => set({ aiRefs: [] }),
  setAiApprovals: (p) => set({ aiApprovals: { ...get().aiApprovals, ...p } }),
  setPalette: (paletteOpen) => set({ paletteOpen }),

  openSheet: (kind, props = {}, onDone) => set({ sheet: { kind, props, onDone }, paletteOpen: false }),
  closeSheet: () => set({ sheet: null }),

  // Peek 的真相在 URL 里，这里只转发命令，不存副本——两份状态迟早会不一致
  openPeek: (id) => navOpenPeek(id),
  closePeek: () => navClosePeek(),

  toast: (text, kind = 'info') => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => get().dismissToast(id), kind === 'err' ? 6000 : 3000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (text: string, kind?: Toast['kind']) => useUi.getState().toast(text, kind);
export const openSheet = useUi.getState().openSheet;
export const closeSheet = useUi.getState().closeSheet;
export const openPeek = useUi.getState().openPeek;
export const closePeek = useUi.getState().closePeek;

/** 把 UI 偏好写到 <html> 上，CSS 变量才会生效 */
export function applyUiToDocument(): void {
  const s = useUi.getState();
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.fs = s.fontSize;
  root.dataset.reading = s.readingWidth;
  root.dataset.radius = s.radius;
  root.dataset.readerFont = s.readerFont;
  root.dataset.readerIndent = s.readerIndent ? '1' : '0';
  root.style.setProperty('--reader-size', `${s.readerSize}px`);
}

useUi.subscribe(applyUiToDocument);
