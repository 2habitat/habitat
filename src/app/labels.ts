/** 枚举值说人话：界面上不该出现 seedling / book / draft 这种字段名 */
export const WORK_KIND: Record<string, string> = {
  book: '书',
  article: '文章',
  dossier: '文集',
};

export const NOTE_STATUS: Record<string, string> = {
  seedling: '幼苗',
  growing: '生长',
  evergreen: '常青',
};

export const WORK_STAGE: Record<string, string> = {
  capture: '采集',
  derive: '衍生',
  digest: '消化',
  review: '回顾',
  settle: '沉淀',
};

export const JOB_STATE: Record<string, string> = {
  draft: '草稿',
  queued: '排队',
  running: '执行中',
  'waiting-approval': '待人确认',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

export const CHANGE_STATE: Record<string, string> = {
  draft: '草稿',
  validated: '已校验',
  committed: '已提交',
  reverted: '已撤销',
  conflict: '冲突',
};

export const ACTION_STATE: Record<string, string> = {
  open: '待办',
  done: '完成',
  blocked: '卡住',
};

export const FLOW_LABEL: Record<string, string> = {
  now: '现在做',
  next: '接着做',
  later: '以后做',
};

export function label(map: Record<string, string>, key?: string | null): string {
  if (!key) return '';
  return map[key] ?? key;
}
