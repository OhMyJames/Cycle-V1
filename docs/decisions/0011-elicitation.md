# 0011 agent 向用户提问(elicitation):只发给声明了能力的客户端,没有就回退

状态:已接受(2026-11-18)

## 背景

ACP v2 有 `elicitation/create`(agent 向用户要结构化输入)。Claude 有两处会问用户:MCP 服务器的 elicitation,以及 `AskUserQuestion` 工具。现在的桌面客户端没有声明这个能力,也没有对应的界面;而 daemon 对 agent 的请求有"没人附着就挂起"的规则(协议 §9)。

## 决定

1. **能力来自客户端**:`initialize` 的 `capabilities.elicitation.form`。daemon 按连接记住它。daemon 对 agent 的 `initialize` 一律声明 `elicitation.form`:路由还是拒绝,是 daemon 的事,agent 不需要知道谁连着。
2. **只发给声明了能力的、已附着的客户端**。规则和权限请求一样:先写日志(占序号),第一个答案生效,其余客户端收到 `_cycle/request_resolved`,agent 退出或 `session/cancel` 时以 `cancel` 结束。
3. **没有这样的客户端时,立即回答,不挂起**(最后一个有能力的客户端断开时,等着的表单也这样结束):`{action: "cancel", _meta: {"cycle/noClient": true}}`。理由:权限请求挂起是因为 agent 在等一个必须由人做的决定,而 elicitation 通常是可选的补充输入,挂住整个 turn 比放弃它代价大;而且挂起会让一个没有这个界面的客户端永远看不到它。
4. **回退保持现有行为**:
   - MCP 的 elicitation 收到 `cycle/noClient` 时按 `decline` 回给 MCP 服务器(和 SDK 没有回调时的默认一样)。
   - `AskUserQuestion` 收到 `cycle/noClient` 时走原来的权限请求(用户看到的是"允许 AskUserQuestion?"的卡片和它的参数)。有能力的客户端在时,它变成一个表单:每个问题一个字段,单选是 `enum`(`oneOf` 带 label 和说明),多选是 `array`,答案写回 `answers`。
5. URL 模式的 elicitation(MCP 服务器的网页授权)v1 不支持:agent 一侧直接 `decline`,daemon 不声明 `url`。

## 为什么不是别的

- 一律挂起:没有界面的客户端(现在的桌面端)会让 turn 永远停在 `requires_action`,用户只能取消。这比现状更差。
- 一律拒绝、不做:前端做好界面后还得改后端;现在的做法让后端先就位,前端只需声明能力并回答。
