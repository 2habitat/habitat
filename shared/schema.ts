/** Zod schema —— 与服务端共用同一份对象定义 */
import { z } from 'zod';

export const Sensitivity = z.enum(['private', 'work', 'public']);
export const Author = z
  .string()
  .refine(
    (v) => v === 'human' || v === 'system' || v === 'external:unknown' || v.startsWith('agent:'),
    'author 必须是 human / system / external:unknown / agent:<name>',
  );

export const Base = z.object({
  id: z.string().min(1),
  schema: z.number().int().nonnegative(),
  spaceId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: Author,
  sensitivity: Sensitivity,
  archivedAt: z.string().optional(),
  rev: z.number().int().nonnegative(),
  path: z.string().optional(),
});

const mk = <T extends z.ZodRawShape>(type: string, shape: T) =>
  Base.extend({ type: z.literal(type) }).extend(shape);

export const SpaceS = mk('space', {
  name: z.string(),
  root: z.string(),
  tz: z.string(),
  layout: z.number().int(),
  defaultSensitivity: Sensitivity,
});

export const WorkS = mk('work', {
  title: z.string(),
  kind: z.enum(['book', 'dossier', 'article']),
  desc: z.string().optional(),
  slug: z.string(),
});

export const EditionS = mk('edition', {
  workId: z.string(),
  label: z.string(),
  language: z.string().optional(),
});

export const PartS = mk('part', {
  editionId: z.string(),
  workId: z.string(),
  order: z.number().int(),
  title: z.string(),
  supplemental: z.boolean().optional(),
});

export const Carrier = z.enum(['md', 'html', 'pdf', 'epub']);
export const RepS = mk('rep', {
  partId: z.string(),
  workId: z.string(),
  carrier: Carrier,
  path: z.string(),
  hash: z.string(),
  bytes: z.number().int(),
  locked: z.boolean(),
});

export const LocatorS = z.object({
  kind: z.enum(['char', 'page', 'block']),
  from: z.number().int(),
  to: z.number().int(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  page: z.number().int().optional(),
  blockId: z.string().optional(),
});

export const AnnotationS = mk('annotation', {
  targetRepId: z.string(),
  revision: z.number().int(),
  locator: LocatorS,
  quote: z.string(),
  note: z.string().optional(),
  color: z.string(),
  origin: z.enum(['human', 'ai']).optional(),
  skillId: z.string().optional(),
  sessionId: z.string().optional(),
  derivedIds: z.array(z.string()).optional(),
});

export const NoteS = mk('note', {
  title: z.string(),
  body: z.string(),
  status: z.enum(['seedling', 'growing', 'evergreen']),
  srcIds: z.array(z.string()),
  kind: z.enum(['point', 'summary', 'outline', 'question', 'report']),
  tags: z.array(z.string()).optional(),
});

export const CollectionS = mk('collection', {
  title: z.string(),
  desc: z.string().optional(),
  memberIds: z.array(z.string()),
  query: z.string().optional(),
});

export const ActionS = mk('action', {
  text: z.string(),
  due: z.string().optional(),
  scheduled: z.tuple([z.string(), z.string()]).optional(),
  flow: z.enum(['now', 'next', 'later']),
  state: z.enum(['open', 'doing', 'blocked', 'done']),
  projectId: z.string().optional(),
  doneAt: z.string().optional(),
});

export const ProjectS = mk('project', {
  title: z.string(),
  desc: z.string().optional(),
  areaId: z.string().optional(),
  state: z.enum(['active', 'someday', 'done', 'dropped']),
});

export const AreaS = mk('area', {
  title: z.string(),
  standard: z.string().optional(),
});

export const EventS = mk('event', {
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean().optional(),
  projectId: z.string().optional(),
});

/* ---- 变更 ---- */

export const OpS = z.discriminatedUnion('t', [
  z.object({ t: z.literal('create'), obj: z.record(z.unknown()) }),
  z.object({ t: z.literal('update'), id: z.string(), patch: z.record(z.unknown()) }),
  z.object({ t: z.literal('setBody'), id: z.string(), body: z.string() }),
  z.object({ t: z.literal('append'), id: z.string(), text: z.string(), anchor: z.enum(['end', 'start']).optional() }),
  z.object({ t: z.literal('move'), id: z.string(), to: z.string() }),
  z.object({ t: z.literal('archive'), id: z.string(), archived: z.boolean() }),
]);

export const ChangeS = z.object({
  op: OpS,
  target: z.string(),
  label: z.string(),
  diff: z.string().optional(),
});

export const ConflictTripleS = z.object({
  id: z.string(),
  base: z.object({ rev: z.number(), content: z.string() }),
  mine: z.object({ content: z.string() }),
  theirs: z.object({ rev: z.number(), content: z.string(), updatedAt: z.string(), author: Author }),
});

export const ChangeSetS = mk('changeset', {
  baseRevisions: z.record(z.number()),
  ops: z.array(OpS),
  changes: z.array(ChangeS).optional(),
  state: z.enum(['draft', 'validated', 'committed', 'reverted', 'conflict']),
  reason: z.string().optional(),
  committedAt: z.string().optional(),
  revertedAt: z.string().optional(),
  conflict: ConflictTripleS.optional(),
  inverse: z.array(OpS).optional(),
  baseHashes: z.record(z.string()).optional(),
  checks: z
    .array(
      z.object({
        name: z.enum(['schema', 'readonly', 'links', 'version']),
        label: z.string(),
        ok: z.boolean(),
        level: z.enum(['error', 'warn']),
        detail: z.string(),
      }),
    )
    .optional(),
  snapshot: z
    .record(
      z.object({
        baseRev: z.number(),
        base: z.string(),
        mine: z.string(),
        hash: z.string(),
      }),
    )
    .optional(),
});

export const ProposalS = mk('proposal', {
  kind: z.enum(['group', 'link', 'rewrite', 'derive']),
  title: z.string(),
  rationale: z.string().optional(),
  changes: z.array(ChangeS),
  evidence: z.array(z.string()),
  scope: z.string(),
  budgetCny: z.number(),
  risk: z.enum(['low', 'med', 'high']),
  state: z.enum(['pending', 'applied', 'rejected']),
  changesetId: z.string().optional(),
});

export const JobS = mk('job', {
  name: z.string(),
  trigger: z.string(),
  state: z.enum(['queued', 'running', 'waiting-approval', 'waiting-device', 'done', 'failed']),
  checkpoint: z.string(),
  leaseUntil: z.string().optional(),
  idempotencyKey: z.string(),
  steps: z.array(z.object({ name: z.string(), state: z.enum(['pending', 'done', 'skipped']) })),
  waitingReason: z.string().optional(),
  error: z.string().optional(),
});

export const JournalEventS = z.object({
  id: z.string(),
  at: z.string(),
  actor: Author,
  op: z.enum([
    'capture', 'ingest', 'read', 'annotate', 'derive', 'edit', 'propose',
    'review', 'settle', 'commit', 'build', 'import', 'revert', 'external_edit', 'reconcile',
  ]),
  phase: z.enum(['intent', 'done', 'detected']),
  target: z.string(),
  summary: z.string(),
  payload: z.record(z.unknown()).optional(),
  claimedBy: z.string().optional(),
  claimedAt: z.string().optional(),
  spaceId: z.string().optional(),
});

export const CursorS = z.object({
  repId: z.string(),
  current: z.number(),
  furthest: z.number(),
  updatedAt: z.string(),
  readCount: z.number().int().optional(),
});

const BY_TYPE: Record<string, z.ZodTypeAny> = {
  space: SpaceS, work: WorkS, edition: EditionS, part: PartS, rep: RepS,
  annotation: AnnotationS, note: NoteS, collection: CollectionS, action: ActionS,
  project: ProjectS, area: AreaS, event: EventS, changeset: ChangeSetS,
  proposal: ProposalS, job: JobS,
};

export function schemaFor(type: string): z.ZodTypeAny | null {
  return BY_TYPE[type] ?? null;
}

export const OBJECT_TYPES = Object.keys(BY_TYPE);

/** 校验并给出可读错误；未知 type 直接放过（保留未知对象不被丢弃） */
export function validateObject(obj: Record<string, unknown>): { ok: true } | { ok: false; errors: string[] } {
  const t = String(obj?.type ?? '');
  const s = schemaFor(t);
  if (!s) return { ok: true };
  const r = s.safeParse(obj);
  if (r.success) return { ok: true };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
