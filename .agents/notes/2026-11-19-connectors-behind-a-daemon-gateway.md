# Agent Note: Connector(MCP 服务)是 Cycle 的公共能力:daemon 保管、网关代理,agent 只看到本地地址

Status: accepted
Date: 2026-11-19
Basis: 负责人 2026-11-19 的对话。起因是在 Cycle 里无法给 MCP 服务器授权(适配对 URL 模式的 elicitation 一律拒绝,决策 0011 第 5 条)。负责人同意:授权流程由客户端跑、凭证由 daemon 持有、暂不做 cloud;同意 daemon 做 MCP 代理而不是把 header 交给 agent;同意 stdio 类的密钥可以到达 MCP 进程、但不到达 agent;并要求"MCP 是公共能力,应该有代理层,不应该每个 agent 重新配置一遍",管理逻辑"要兼容未来的 cloud 和多 agent 体系",接口要留好。参考了 old-cycle 的笔记 `2026-11-13-the-connector-is-codex-config`、`2026-11-13-cycle-tools-behind-their-own-key`、`2026-11-16-cycle-keeps-claude-code-s-configuration`。

## Problem

用户想在 Cycle 里添加 MCP 服务器(connector)并完成授权,然后在 session 里使用。有几个约束:

- **浏览器在客户端,MCP 请求从 daemon 的机器发出。** daemon 在远端时,agent 自带的 OAuth 会在远端的 localhost 上等回调,用户的浏览器访问不到。
- **agent 是可替换的。** 如果每个 agent 各存一份配置、各登录一次,接 N 个 agent 就要配 N 遍、授权 N 遍,token 也散落在各个 agent 的配置目录里,agent 自己的命令都读得到。
- **红线**:任何账号的 token 不得到达 agent;环境变量只走白名单;daemon 只绑 loopback。
- **以后要上 cloud**:有用户身份,connector 清单和凭证可能放在云端,agent 可能跑在云端 sandbox。现在的结构不应该在那时推倒重来。

## Decision

**connector 归 Cycle 管,不归 agent 管。** 分成四个部分,每一部分放在一个接口后面:

1. **清单(`ConnectorCatalog`)**:有哪些 connector、怎么连、开没开。不含密钥。v1 存在 daemon 的 `$CYCLE_HOME/connectors.json`。
2. **凭证(`CredentialVault`)**:OAuth 的 token 和 client 注册信息、用户填的 API key、stdio 服务器的环境变量值。v1 存在 daemon 的机器上,文件权限 0600。**refresh token 只有它一个持有者**,只由它来刷新:很多授权服务器会轮换 refresh token,两处各存一份,必然有一份失效。
3. **授权(`AuthBroker`)**:OAuth 的发现、client 注册、PKCE 和换 token 都在 daemon 里做。客户端只负责打开浏览器、接住回调,再把**授权码**交给 daemon。PKCE 的 verifier 一直留在 daemon,所以授权码离开 daemon 就没有用,**token 从不出现在 L1 上**。
4. **网关(`McpGateway`)**:daemon 在 loopback 上为每个 session 开一个 MCP 端点(streamable HTTP),转发给真正的服务器,转发时注入凭证,遇到 401 由 vault 刷新后重试。
   - stdio 类的 connector 由 daemon 自己启动,同样经网关以 HTTP 的形式提供。它的环境变量只含 vault 里给它的值,不继承 daemon 的环境。密钥到达这个 MCP 进程,但不到达 agent。
   - 网关只认每个 session 自己的 bearer key,并检查 `Host`。这个 key 每次启动时生成,只能访问这个 session 用到的 connector。

**agent 那一侧只用 ACP。** daemon 在 L2 的 `session/new` 和 `session/resume` 的 `mcpServers` 里放入网关地址(http)。任何支持 ACP http MCP 的 agent 都能直接用,不需要逐个 agent 配置,适配里也没有 connector 相关的代码。connector 的地址和凭证变了,下次启动 agent 时自然生效。

**L1 的形态与谁提供服务无关。** 客户端用 `_cycle/connectors/*`(protocol.md §14)做增删改查和授权,不知道背后是 daemon 的文件还是 cloud。

**cloud 的扣子**(现在不实现):

- `ConnectorCatalog` 换成账号下的清单,多台机器、多个 daemon 共享。
- `CredentialVault` 换成"向 cloud 领取短期 access token":refresh token 只在云端,daemon 只拿短期 token,还是只有一个刷新者。
- `AuthBroker` 由 cloud 来做,客户端的步骤不变(打开链接、交回授权码)。
- 网关所在的位置跟着 agent 走。agent 在云端 sandbox 里时,网关要是 sandbox 访问得到的地址,这和 §13 里"云端 sandbox 下的连接方向"是同一个问题,到时一起定。网关地址由环境提供,不写死成 loopback。
- 身份:决策 0004 在握手里预留的鉴权扩展位。

**对 L1 上凭证的放宽(有意的)**:`docs/desktop.md` 原来的立场是"不让凭证上线路"。现在只放宽一个方向:**客户端可以把用户填的密钥(API key、stdio 的环境变量值)和 OAuth 授权码送到 daemon;daemon 永远不把任何密钥回传**,读接口只返回"有没有设"。

**项目和 agent 自己的配置不变**:项目 `.mcp.json`(受文件夹信任管,见 [folder-trust 笔记](2026-11-19-folder-trust-is-cycles.md))、Claude 在 `$CYCLE_HOME/claude` 里的用户级配置,以及客户端在 `session/new` 里直接给的 `mcpServers`,都照旧。connector 是在这些之外另加的一层。

状态:负责人 2026-11-19 要求实现("nav bar 增加一个菜单叫 connector……兼顾未来跨 agent 和上云");daemon、协议、桌面端在分支 `feat/connectors` 上一起实现。"授权码而不是 token 经过 L1"是作者在负责人同意"token 单向上线路"之后提出的收紧,比原来同意的更窄。实现时又定了两点:connector 在**每次启动 agent** 时按当时的清单给出(不在 session 创建时记死),这样后来授权或打开的 connector 不用新建 session;session 自己的 `mcpServers` 与 connector 重名时，以 session 自己的为准。

## Alternatives considered

- **用 agent 自己的配置**:old-cycle 2026-11-13 从自己的 gateway 改成直接用 codex 的 `config.toml`,理由是"同一批服务器出现在第二个地方,还要自己保管 token,而 codex 本来就能做"。那时只有一个 agent,而且是透明代理。我们的前提不同:agent 可替换、要接多个,每个 agent 一份配置正是负责人要避免的。远端 daemon 的回调问题它也解决不了。token 存在 agent 的配置目录里,agent 的命令都读得到。
- **把 URL 模式的 elicitation 转给客户端,由 agent 自己授权**:回调落在 agent 那台机器的 localhost 上,远端访问不到;token 归 agent 保管;换一个 agent 就要再授权一次。
- **token 存在客户端(keychain),推给 daemon**:desktop 关了以后 session 仍在 daemon 里跑(prompt 队列在 daemon),token 过期时没人刷新;两边都持有 refresh token 会因轮换互相作废。
- **把 `Authorization` header 直接交给 agent**:实现最快,但 token 会到达 agent,违反红线。负责人选了代理。
- **stdio connector 交给 agent 去启动,通过 ACP 的 `env` 传值**:密钥会出现在交给 agent 的启动参数里(Claude 适配是 `initialize` 消息)。所以改为 daemon 启动、经网关提供。
- **现在就做 cloud**:决策 0004 定了 v1 协议里不做鉴权;目前用户只有我们自己;云端集中保存第三方 token 是高价值目标,需要单独的信任模型。所以先留接口,不实现。

## Consequences

- 每台 daemon 的机器要各自授权一次,直到有 cloud。
- daemon 多了一个 loopback 服务和一个保存密钥的文件,需要和 daemon 本身同样的红线:只绑 loopback、检查 `Host`、bearer、文件 0600、不进日志。
- 网关要实现 streamable HTTP 的转发,包括 SSE 流,以及 stdio 和 HTTP 之间的桥接。这是这一层的主要工作量,还没有评估过具体实现。
- MCP 授权规范里的发现(RFC 9728、RFC 8414)和动态注册(RFC 7591)不是每个服务器都支持;不支持动态注册的服务器,需要用户填 client id。**未验证**:回调用 loopback 随机端口,哪些服务器接受。
- agent 看到的 MCP 服务器名就是 connector 名。daemon 只能保证 connector 之间不重名,不知道 agent 自己的配置里有哪些名字;重名时以哪个为准由 agent 决定,要在适配文档里写明(未验证)。
- 用户能感知的操作(添加、授权、移除 connector)需要埋点,只报传输类型、授权方式、结果和数量,不报名字和 URL。要在实现时和功能同一次提交。
