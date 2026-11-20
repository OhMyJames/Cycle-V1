# Agent Note: 右侧面板纳入 v1，面板本身不授予 agent 权限

Status: accepted
Date: 2026-11-19
Basis: 2026-11-19 的 CYCL-51 将右侧面板纳入 v1，并指定 CYCL-89 负责面板结构。

## Problem

右侧面板将与对话区同时显示。用户打开一个标签就能看到内容，需要区分用户能看到什么和 agent 有权读取什么。

## Decision

右侧面板作为桌面端容器纳入 v1。打开标签只改变用户界面。各标签遵守[仓库红线](../../AGENTS.md)：

- 连接 daemon 时沿用 loopback 或 Unix socket 的监听限制，远端通过 SSH 访问。
- 面板中的登录状态不授予 agent 获取账号或 SSO token 的权限；这些凭证不得到达 agent。
- 打开或切换标签不能让 agent 继承桌面进程的环境变量，agent 环境仍由显式白名单构造。
- 埋点可记录打开、切换或折叠等行为，不含标签标题、路径或面板内容。

## Alternatives considered

尚未选定按窗口还是按会话记住标签，也未决定窄窗口时覆盖还是挤压对话区。CYCL-89 将用对话区和 overview 验证这些选项。

## Consequences

CYCL-89 在本笔记中补充标签结构、宽度、折叠、快捷键及状态保存的结论，再交给 CYCL-66 实现容器。
