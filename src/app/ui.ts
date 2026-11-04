/** 只放 UI 状态，不镜像服务端数据 */
import { create } from 'zustand';
import { openPeek as navOpenPeek, closePeek as navClosePeek } from './router.ts';

export type Theme = 'ningzhi' | 'piaoqing' | 'xuanmo';
export type SheetKind =
  | 'capture' | 'derive' | 'annotate' | 'task' | 'event' | 'project'
  | 'review' | 'conflict' | 'journal' | 'proposal' | 'notifications' | null;

export interface AiContext {
  kind: 'work' | 'part' | 'rep' | 'note' | 'action' | 'none';
  id: string;
  title: string;
  quote?: string;
}

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
  /** 阅读行宽，方案要求「可调」 */
  readingWidth: 'narrow' | 'normal' | 'wide';
  /** 书架默认展示：封面墙还是紧凑列表 */
  shelfView: 'grid' | 'list';
  aiOpen: boolean;
  aiCtx: AiContext;
  paletteOpen: boolean;
  sheet: { kind: SheetKind; props: Record<string, unknown>; onDone?: () => void } | null;
  toasts: Toast[];

  setTheme: (t: Theme) => void;
  setFontSize: (t: 'sm' | 'md' | 'lg') => void;
  setRadius: (t: 'sharp' | 'soft' | 'round') => void;
  toggleCollapsed: () => void;
  setDrawer: (v: boolean) => void;
  setReadingWidth: (w: 'narrow' | 'normal' | 'wide') => void;
  setShelfView: (v: 'grid' | 'list') => void;
  openAi: (ctx?: Partial<AiContext>) => void;
  closeAi: () => void;
  setAiCtx: (ctx: Partial<AiContext>) => void;
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

function persist(s: Pick<UiState, 'theme' | 'fontSize' | 'radius' | 'collapsed' | 'readingWidth' | 'shelfView'>): void {
  try {
    localStorage.setItem('habitat.ui', JSON.stringify({
      theme: s.theme, fontSize: s.fontSize, radius: s.radius, collapsed: s.collapsed,
      readingWidth: s.readingWidth, shelfView: s.shelfView,
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
  shelfView: saved.shelfView ?? 'grid',
  drawer: false,
  radius: saved.radius ?? 'soft',
  collapsed: saved.collapsed ?? false,
  aiOpen: false,
  aiCtx: { kind: 'none', id: '', title: '全局' },
  paletteOpen: false,
  sheet: null,
  toasts: [],

  setTheme: (theme) => { set({ theme }); persist(get()); },
  setFontSize: (fontSize) => { set({ fontSize }); persist(get()); },
  setDrawer: (drawer) => set({ drawer }),
  setReadingWidth: (readingWidth) => { set({ readingWidth }); persist(get()); },
  setShelfView: (shelfView) => { set({ shelfView }); persist(get()); },
  setRadius: (radius) => { set({ radius }); persist(get()); },
  toggleCollapsed: () => { set({ collapsed: !get().collapsed }); persist(get()); },

  openAi: (ctx) => set({ aiOpen: true, aiCtx: { ...get().aiCtx, ...ctx } as AiContext }),
  closeAi: () => set({ aiOpen: false }),
  setAiCtx: (ctx) => set({ aiCtx: { ...get().aiCtx, ...ctx } as AiContext }),
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
}

useUi.subscribe(applyUiToDocument);
