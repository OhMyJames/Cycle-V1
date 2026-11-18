# 0002 session 持久化

状态:已接受(已更新:daemon 自己保存历史)

## 决定

daemon 自己保存会话历史,v1 用 JSONL:每个 session 一个文件,只追加,每行一条带 `seq` 的事件。JSONL 是历史的**唯一来源**,不依赖 agent 通过 `session/resume` 重放。

## 原因

- 后续可能上云。云端 sandbox 销毁后,agent 侧的历史会一起丢掉。
- JSONL 简单、可追加、易于迁移到对象存储或其他后端。
- old-cycle 靠 agent 重放历史,代价是 agent 的 transcript 一旦被删,Cycle 里没有副本。我们不接受这一点。

## 约束

- 存储放在接口后面,daemon 不直接依赖文件系统细节。
- session 列表用独立的索引文件,不靠扫描日志(同时记录哪些 session 属于 Cycle,见 [0006](0006-own-sessions.md))。
- 读取时丢弃崩溃留下的末尾半行。
- 单 session 单写者,由 daemon 保证。
- 索引文件无法读取时,daemon 拒绝启动,而不是覆盖它,因为它无法重建。

## 已知限制

agent 进程是 daemon 的子进程,daemon 退出时进行中的 turn 会中断,还没写入日志的部分输出会丢失。
