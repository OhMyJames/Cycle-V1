# Agent Note: 输入框可以附加任意文件:文本和 PDF 作为嵌入资源，名字放在 `attachment:` uri 里

Status: accepted
Date: 2026-11-22
Basis: 2026-11-22 UX 对齐批次的任务("Attach any file, not only images");决策 [0010](../../docs/decisions/0010-attachments-inline.md) 已定下的块类型和上限;`packages/protocol/src/prompt.ts` 的 `checkPrompt` 与 `harness/claude/src/content.ts` 的映射已经支持文本和 PDF 的 `resource`。

## Problem

0010 在协议、daemon 校验和 Claude 适配上已经允许 `resource`(文本，或 `application/pdf` 的 blob),但客户端只让人附加 PNG/JPEG/GIF/WebP:其余的文件要么被按钮的 `accept` 挡掉，要么拖进来时只说"只能附加图片"。0010 的范围因此在界面上只落实了图片。补上时要决定三件事：哪些文件能发、发成什么块、ACP 的 `resource` 没有 `name` 字段时文件名放哪里。

## Decision

扩展 0010 在客户端的范围，协议、上限、daemon 和 Claude 适配都不改:

- **能发什么**:图片照旧(agent 声明 `image`)。agent 声明 `embeddedContext` 时，再加文本文件和 PDF。PDF 按类型或 `.pdf` 后缀认;其余文件读出字节，严格按 UTF-8 解码(`TextDecoder` 的 `fatal`)且不含 NUL 才算文本，不看扩展名(系统常把 `.ts` 标成 `video/mp2t`)。别的一律在输入框里就地拒绝并说原因，不发给 daemon 再被 `-32602` 退回。
- **发成什么**:文本是 `{type: "resource", resource: {uri, mimeType, text}}`,`mimeType` 用文件自己的文本类型，否则 `text/plain`;PDF 是 `{uri, mimeType: "application/pdf", blob}`。大小按 `PROMPT_LIMITS` 在加入时检查，文本按 UTF-8 字节数。
- **名字放哪里**:`uri` 是 `attachment:///` 加 `encodeURIComponent(文件名)`。不用 `file://` 加本机路径:agent 可能在远端(0010 的前提),本机路径对它没有意义还会误导它去读盘，也会把本机目录结构交给 agent;页面本来也拿不到路径。scheme 告诉 agent 内容就在消息里，最后一段就是名字(客户端解码后显示)。
- **怎么显示**:输入框里是带名字、大小和移除按钮的小片;对话里用户消息中的 `resource` 只画一个带名字的小片，内容从不渲染(可能是 HTML)。`attachment:` 的块被退回(发送失败、编辑重发、取回排队)时还原成附件;别的来源的 `resource` 仍按原样保留(`kept`)。
- **埋点**:`attachment_added` 只报 `kind`(`image`/`text`/`pdf`)和来源(`button`/`paste`/`drop`),`attachment_refused` 只报原因的词，`prompt_sent` 加 `files` 个数;从不报名字、路径或 MIME 类型。

## Alternatives considered

- 文件名放进 `_meta["cycle/name"]`:多一个 Cycle 扩展字段，Claude 适配和别的 agent 都看不到它，模型也就不知道文件叫什么。放在 uri 里，现有适配写进 `<file uri="…">` 和 document 的 `title`,不用改。
- 用 `file://` 加本机路径:见上，远端无意义，且暴露本机路径。
- 只按扩展名或 MIME 判断文本:漏判多(无类型、`.ts`)、也会把二进制当文本发;按字节解码更准，代价是读一遍文件(上限 5 MiB)。
- 其他二进制(Office 文档、压缩包)转成文字或 blob 发出:Claude 适配只有 PDF 能作为 document 交给模型，别的会在适配那里被整条拒绝，所以在客户端就拒绝。

## Consequences

- 一个 prompt 可以带进最多约 5 MiB 的文本，会进 JSONL 日志(大的 blob 按 0013 落盘);这和 0010 对图片的代价相同。
- agent 没有声明 `embeddedContext`(更早的 daemon 或别的 agent)时，界面行为和以前一样只收图片。
- 不检查文本的编码以外的东西：一个很大的、恰好是 UTF-8 的数据文件也会作为文本发出，由上限兜底。

## Related

- [决策 0010](../../docs/decisions/0010-attachments-inline.md):块类型和上限;本笔记扩展它在客户端的范围，不取代它。
- [mentions-are-resource-links](2026-11-18-mentions-are-resource-links.md):`@` 提及仍是 `resource_link`,不是嵌入内容。
