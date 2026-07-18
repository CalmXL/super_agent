# Skill

## Skill 不是 tool

- tool 是一个可执行的函数，Agent 可以调用它, 拿到返回值，然后继续推理。
  tool 本质是一个原子操作。

- skill 是一份知识文档，使用 markdown 写的行为指导。他不注册到 tools 列表里，而是注入到 system prompt 里。

Tool 是 Agent 的锤子和扳手，Skill 则是脑子里的手册。

## 实现一个 skill

Skill 的存储很简单，一个目录下放一个 SKILL.md 文件。

SKILL.md 用 YAML 记录名称和描述，正文则是 Markdown 格式的行为指导。

```md
---
name: code-review
description: '以高级工程师视角审视代码变更'
---

# Code Review

## 审查流程

**1) 收集范围变更**
用 list_directory 和 glob 扫描项目结构

**2) 架构设计审查**
关注 SRP、OCP、DIP 等问题...
```
