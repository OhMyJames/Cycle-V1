# 设计决策记录

一条决策一个文件,命名为 `NNNN-标题.md`,编号递增。状态:提议、已接受、已取代。

## 索引

- [0001 Claude 的 ACP 适配](0001-claude-acp-adapter.md):已接受(自己写,不用官方包)
- [0002 session 持久化](0002-session-persistence.md):已接受(daemon 自己存 JSONL,是历史唯一来源)
- [0003 L1 schema 的事实来源](0003-schema-source.md):已接受(zod)
- [0004 v1 鉴权](0004-auth.md):已接受(仅 SSH 和 socket 权限)
- [0005 以 ACP v2 为蓝本,L1 自己定义类型](0005-acp-v2.md):已接受(方案 C)
- [0006 只管理 Cycle 自己的 session](0006-own-sessions.md):已接受
- [0009 应用自己更新自己](0009-self-update.md):已接受(自己写,不用 Squirrel)
