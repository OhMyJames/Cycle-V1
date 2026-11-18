# 0003 L1 schema 的事实来源

状态:已接受

## 决定

用 TypeScript 的 zod 作为 L1 协议的唯一事实来源,类型从 schema 推导,必要时生成 JSON Schema。语义说明仍在 `docs/protocol.md` 手写。
