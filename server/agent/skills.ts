/**
 * 技能：空间里的 Markdown，不是平台代码。
 *
 * 内置两个：苏格拉底式学习、精读批注。用户可以在 space/skills/<id>/SKILL.md 里覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from '../../shared/frontmatter.ts';
import type { AgentSkill } from '../../shared/agent.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.resolve(HERE, '..', '..', 'skills', 'builtin');

export const BUILTIN_SKILLS: AgentSkill[] = [
  {
    id: 'socratic',
    name: '苏格拉底式学习',
    version: 1,
    appliesTo: ['reading'],
    context: ['focus', 'selection', 'outline', 'section'],
    tools: ['kb_session', 'kb_outline', 'kb_read', 'kb_search'],
    output: 'questions',
    starters: ['用苏格拉底法带我把这一节想透', '别直接告诉我答案，先问我三个问题'],
    builtin: true,
    body: [
      '你是引导者，不是答题器。学习者正在读《{{focus.title}}》的「{{section.title}}」。',
      '',
      '规则：',
      '1. 每轮只问一个问题，不超过两句。',
      '2. 不替学习者下结论；学习者直接要答案时，先反问依据，再给「先看结论」的出口。',
      '3. 每个问题必须落在原文的具体句子上，引用不超过 60 字。',
      '4. 学习者连续两次答不上来，给一个提示或反例，仍然不给答案。',
      '5. 5 轮后请学习者用自己的话总结，你只指出缺口，不代写。',
      '6. 结束时可以提议生成「学习小结」笔记，内容必须是学习者说过的，你只做整理。',
    ].join('\n'),
  },
  {
    id: 'annotate',
    name: '精读批注',
    version: 1,
    appliesTo: ['reading'],
    context: ['focus', 'selection', 'section'],
    tools: ['kb_session', 'kb_read', 'kb_annotate_suggest'],
    output: 'annotations',
    starters: ['给这一节提三条批注建议', '把这段里值得回看的地方标出来'],
    builtin: true,
    body: [
      '你是精读批注助手。学习者正在读《{{focus.title}}》的「{{section.title}}」。',
      '',
      '规则：',
      '1. 只对原文里真实存在的句子提批注，quote 必须逐字来自原文。',
      '2. 每条批注只讲一件事：一个判断、一个疑问或一个关联，不超过 80 字。',
      '3. 优先标出让论证成立或失效的关键句，不标形容词堆砌的句子。',
      '4. 一次最多 3 条；不确定就不提。',
      '5. 调用 kb_annotate_suggest 提交建议，不要直接写正文。',
    ].join('\n'),
  },
];

function readSkillFile(file: string): AgentSkill | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const { fm, body } = parseDoc(raw);
    const id = String(fm.id ?? path.basename(path.dirname(file)));
    if (!id) return null;
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    return {
      id,
      name: String(fm.name ?? id),
      version: Number(fm.version) || 1,
      appliesTo: arr(fm.appliesTo),
      context: arr(fm.context),
      tools: arr(fm.tools),
      output: (fm.output === 'annotations' || fm.output === 'chat' ? fm.output : 'questions') as AgentSkill['output'],
      starters: arr(fm.starters),
      body,
      builtin: false,
    };
  } catch {
    return null;
  }
}

export function loadSkills(root: string): AgentSkill[] {
  const byId = new Map<string, AgentSkill>();
  for (const s of BUILTIN_SKILLS) byId.set(s.id, s);

  // 内置文件优先于代码常量：升级技能不用改代码
  try {
    for (const dir of fs.readdirSync(BUNDLED, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const s = readSkillFile(path.join(BUNDLED, dir.name, 'SKILL.md'));
      if (s) byId.set(s.id, { ...s, builtin: true });
    }
  } catch { /* 没有内置目录就用常量 */ }

  const spaceDir = path.join(root, 'skills');
  try {
    for (const dir of fs.readdirSync(spaceDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const s = readSkillFile(path.join(spaceDir, dir.name, 'SKILL.md'));
      if (s) byId.set(s.id, s);
    }
  } catch { /* 空间里没有技能目录是常态 */ }

  return [...byId.values()];
}

export function skillById(root: string, id?: string): AgentSkill | null {
  if (!id) return null;
  return loadSkills(root).find((s) => s.id === id) ?? null;
}

export function compileSkill(skill: AgentSkill, vars: { focusTitle: string; sectionTitle: string }): string {
  const body = skill.body
    .replace(/\{\{focus\.title\}\}/g, vars.focusTitle || '当前内容')
    .replace(/\{\{section\.title\}\}/g, vars.sectionTitle || '当前小节');
  return `【技能：${skill.name}】\n${body}`;
}
