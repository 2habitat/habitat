/**
 * 列表键盘导航：J/K 选行，Enter 打开，Space 开关预览，X 完成，Esc 收起。
 *
 * 选中状态只写在 DOM（data-nav-active）上，不进 React state——
 * 列表会随数据重渲染，存 state 就得处理「选中的那条没了怎么办」，
 * 而 DOM 标记天然跟着行走。
 */
import { useEffect } from 'react';
import { openPeek, closePeek, peekTarget } from './router.ts';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function visibleRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-nav-row]'));
}

function activeIndex(list: HTMLElement[]): number {
  return list.findIndex((r) => r.dataset.navActive === '1');
}

function setActive(list: HTMLElement[], idx: number): void {
  const next = Math.max(0, Math.min(list.length - 1, idx));
  list.forEach((r, i) => {
    if (i === next) r.dataset.navActive = '1';
    else delete r.dataset.navActive;
  });
  list[next]?.scrollIntoView({ block: 'nearest' });
}

export function useListNav(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;

      const list = visibleRows();
      const peeked = peekTarget();
      const idx = activeIndex(list);

      const move = (to: number) => {
        e.preventDefault();
        setActive(list, to);
        const row = list[Math.max(0, Math.min(list.length - 1, to))];
        // 预览已经开着就跟着走：一边看一边挑，比「关掉再点下一条」少一半动作
        if (row && peeked) openPeek(row.dataset.navRow!);
      };

      switch (e.key) {
        case 'j':
        case 'J':
        case 'ArrowDown':
          if (!list.length) return;
          move(idx < 0 ? 0 : idx + 1);
          return;
        case 'k':
        case 'K':
        case 'ArrowUp':
          if (!list.length) return;
          move(idx < 0 ? list.length - 1 : idx - 1);
          return;
        case 'Enter': {
          if (idx < 0) return;
          e.preventDefault();
          openPeek(list[idx].dataset.navRow!);
          return;
        }
        case ' ': {
          e.preventDefault();
          if (peeked) closePeek();
          else if (idx >= 0) openPeek(list[idx].dataset.navRow!);
          return;
        }
        case 'x':
        case 'X': {
          if (idx < 0) return;
          const btn = list[idx].querySelector<HTMLElement>('[data-done-btn]');
          if (btn) {
            e.preventDefault();
            btn.click();
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
