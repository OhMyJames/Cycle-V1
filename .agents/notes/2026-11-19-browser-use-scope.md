# Agent Note: 内置浏览器与 browser use 纳入 v1，页面内容不能授予权限

Status: accepted
Date: 2026-11-19
Basis: 2026-11-19 的 CYCL-51 放开内置浏览器与 browser use；CYCL-100 负责用户确认、提示注入防护和回传协议的设计。

## Problem

桌面浏览器可以打开带登录状态的页面。让远端 agent 读取或操作这些页面，会跨越本地浏览器与 agent 的权限边界。

## Decision

内置浏览器和 agent 操作浏览器均纳入 v1。页面文字按不可信输入处理，不能充当用户对浏览器操作的授权。设计须满足[仓库红线](../../AGENTS.md)：

- daemon 只监听 loopback 或 Unix socket；远端 agent 与本地浏览器之间的回传须在这一限制下设计。
- 账号或 SSO token 不得交给 agent。CYCL-100 需说明读取页面和截图如何避免回传凭证。
- agent 环境变量只取显式白名单，不继承浏览器或桌面进程的环境。
- 埋点只记录操作类型和结果，不上报 URL、页面文字、输入内容或截图。

## Alternatives considered

CYCL-100 提出经 MCP 工具暴露浏览器动作，也保留其他通道供评估。尚未选定协议。

## Consequences

CYCL-100 在本笔记中补充允许的动作、用户能看到和确认的操作、页面内容的处理及远程回传方式。结论通过后，再进入 CYCL-101 的实现。
