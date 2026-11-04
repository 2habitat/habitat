# 技能

这里放可移植的 Agent 技能（[Agent Skills](https://agentskills.io) 格式：一个目录 + `SKILL.md`）。

## habitat-automation

操作 Habitat 知识空间的闭环：看状态、接工单、认领、执行、交账、自检。

```
skills/habitat-automation/SKILL.md
```

安装到支持 Agent Skills 的客户端（任选其一）：

```bash
# 直接把目录复制到用户级技能目录（Claude Code / Codex / Cursor 等）
cp -r skills/habitat-automation ~/.claude/skills/

# 或者用 skills.sh（如果已安装）
npx skills add ./skills/habitat-automation
```

也可以不安装：把 `SKILL.md` 的内容贴进会话，或让 harness 读空间根的 `AGENTS.md`
（`npx habitat loops init` 生成）。三种方式内容一致，入口不同。

## 和 AGENTS.md 的分工

| 文件 | 给谁看 | 回答什么 |
|---|---|---|
| `AGENTS.md`（仓库根） | 改代码的 Agent | 这个项目怎么构建、测试、加闭环 |
| `skills/habitat-automation/SKILL.md` | 操作空间的 Agent | 怎么接闭环、怎么认领、怎么交账 |
| `<空间>/AGENTS.md` | 进入某个空间的外部 harness | 这个空间的三条硬规矩和状态文件在哪 |
