# 0006 只管理 Cycle 自己的 session

状态:已接受(参考 old-cycle 的同名决策)

## 决定

daemon 的索引只记录 Cycle 自己创建的 session。列表、归档和删除都只作用于这些 session。删除要由客户端先确认。

## 原因

agent 侧的 `session/list` 可能返回整台机器上的 session(包括用户在 Claude CLI 里创建的)。如果 UI 能对它们操作,就可能误删用户的 transcript。old-cycle 在测试时见到 975 个 session,所以做了这个限制。

## 约束

- 删除和归档在 session 工作中时拒绝,因为没有 attach 的客户端听不到它的状态。
- 导入外部 session 是以后的功能,v1 不做。
