# 0010 附件以 ACP 内容块内联发送,有大小上限

> 日志里的字节后来落盘了,见 [0013](0013-attachment-blobs.md);协议和客户端看到的不变。

状态:已接受(2026-11-18)。**这是在用户没有明确选择的情况下做的默认:改成落盘方案不需要动协议,见"以后怎么换"。**

## 背景

composer 要能带图片和文件。agent 可能在远端机器上(L1 走 SSH 隧道),客户端的本地路径对它没有意义,所以附件的内容必须随 `session/prompt` 一起走,或者由 daemon 在 agent 那一侧落盘。

## 决定

附件用 ACP v2 已有的内容块,不另造事件模型(AGENTS.md:L1 以 ACP v2 为蓝本):

| 块                                          | 含义                                | Claude 适配的处理          |
| ------------------------------------------- | ----------------------------------- | -------------------------- |
| `text`                                      | 文字                                | 原样                       |
| `resource_link`                             | 一个引用(ACP 要求每个 agent 都接受) | 变成一行文字 `[name](uri)` |
| `image`(`image/png`、`jpeg`、`gif`、`webp`) | 内联 base64 的图片                  | Claude 的 image 块         |
| `resource`,文本(`text` 字段)                | 嵌入的文本文件                      | 文字块,带 uri 和内容       |
| `resource`,二进制,`application/pdf`         | 嵌入的 PDF                          | Claude 的 document 块      |

其余一律拒绝(`audio`、别的 MIME、别的二进制),**不静默丢弃**:之前适配只取文本块,别的块会悄悄消失。

**上限**(常量在 `@cycle/protocol`,客户端可在发送前自查,daemon 在 `session/prompt` 里强制):

- 文本块也按 UTF-8 字节数计入这两个上限(一大段粘贴的文本在线路上和图片一样大)。
- 一块解码后不超过 5 MiB(Anthropic 单张图片的上限也是 5 MB)。
- 一个 prompt 全部块解码后合计不超过 12 MiB,最多 32 块。base64 之后约 16 MB,低于 ACP SDK 单条消息 32 MiB 的默认上限(`DEFAULT_MAX_MESSAGE_BYTES`);L1、daemon 到 agent 的两段都用这个 SDK。
- 超限或不支持:`-32602`(invalid params),`data` 里带 `{reason, index}`,`reason` 是机器可读的短码。

**能力协商**:agent 能收什么由 agent 声明(ACP 的 `promptCapabilities`:`image`、`embeddedContext`)。daemon 的 `initialize` 不依赖具体 agent,所以放在 `_cycle/agents/list` 每个 agent 的 `promptCapabilities` 里。客户端据此决定是否显示附件按钮;daemon 按它校验,不依赖客户端自觉。

## 为什么内联

- 远端和本地走同一条路径,不需要在远端管理文件的生命周期(清理、权限、磁盘配额)。
- 不需要新的方法或新的事件;历史补发时图片就在 `user_message` 里,客户端已有 `image` 的显示。
- 与 ACP 一致,换别的 agent 时不用改协议。

## 代价

- 附件进了 JSONL 日志(`user_message` 的内容),每个 session 的日志会变大,补发时要把它们再发一遍。上限就是为了限制这一点;按 12 MiB 上限,一个 prompt 最多往日志里加约 16 MB。
- 超过上限的东西(大 PDF、整个仓库)不能这样发:那是"让 agent 自己去读"的场景,用 `resource_link` 指向 agent 所在机器上的路径。

## 以后怎么换

若日志体积成为问题:daemon 在收到 `session/prompt` 时把大块写到 `<数据目录>/attachments/<sessionId>/`,日志和给 agent 的内容里换成 `resource_link`(`file://`)。协议上只多一条能力(`attachments: ["inline","spooled"]`),块的类型和客户端的发送方式都不变。现在不做,因为没有数据说明需要它。
