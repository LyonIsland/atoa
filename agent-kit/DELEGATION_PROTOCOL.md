# ATOA Delegation Protocol v1

ATOA Delegation Protocol 让经过认证的客户端 Agent 执行实现任务，由确定性的服务端控制平面负责合同、Context、权限、队列、验证和合并。

客户端身份必须先在服务端注册；登录只校验已注册邮箱与密码，不会自动创建账户。托管项目由
已登录用户创建，默认只对创建者和明确添加的成员可见；项目级成员和 Skill 只能由项目创建者
管理。项目列表、源码、Context、任务和候选接口使用同一份项目授权判断。

用户级 Codex 处理用户发起的修改请求；用户自主选择模型并私有管理 Token，项目、项目 Skills、验证环境与部署保留在云端统一 Server。接受的贡献会被部署并保存为不可变的可运行 Demo 快照，
因此用户可以沿着 Demo 历史理解项目演进，而不必先 checkout 源码 revision。

## 状态

```text
queued → dispatched → in_progress → accepted
                              ↘ revision_requested → in_progress
```

服务端在合约预检后确定源码 Context 路径。与活动任务 Context 不重叠的任务会立即同步派发；重叠任务保持 `queued`，不绑定 `base_revision`，也不下发 Context。相关占用在任务 accepted 或 cancelled 后释放，排队任务再按创建顺序基于最新 revision 生成 Context。项目 Skill 是共享只读输入，不参与源码路径互斥。

官方 Agent Kit 在收到 `queued` 后把任务 ID 登记给按需本地 Worker，发起请求的 Agent 无需保持本轮运行。Worker 只在本地存在待处理任务时运行；任务变成 `dispatched` 后，Worker取得 90 秒启动租约并启动一个新的客户端 Agent。登记清空后 Worker 自动退出。

## 消息

- `queue`：服务端完成合约预检后把任务加入 Context 冲突队列；冲突合约不会创建任务。
- `dispatch`：任务源码 Context 与活动任务不重叠时，服务端基于当前 revision 生成权限和初始 Context。
- `worker_reserve`：客户端按需 Worker 原子取得短期启动租约；租约只保护本地 Agent 启动，不授予合并权限。
- `claim`：目标客户端 Agent 领取任务并获得 Context manifest；manifest 分别列出源码 `files` 和任务可能需要的项目 `skills`，不直接重复下发内容。
- `context_resolution`：客户端按 SHA-256 检查隔离的只读缓存，报告命中与缺失；服务端只返回缺失内容。
- `context_request/context_response`：客户端判断现有 Context 不足后解释缺失信息，服务端可追加相关源码和项目 Skill manifest，再由缓存解析。
- `progress`：客户端报告阶段进展或阻塞。
- `result`：客户端返回候选文件、实现说明和自述证据。
- `revision_request`：服务器安全审查或固定测试失败，要求继续修订。
- `candidate_reuse`：候选代码未改变时，客户端只发送复用指令，由服务器重新验证缓存候选。
- `accept`：服务器重新验证候选结果并原子更新项目。
- `demo_snapshot`：接受后的最终 revision 被固化为只读、可直接访问的运行版本。

## 客户端数据边界

客户端只发送当前任务所需的修改请求、验收标准、进度、增量 Context 请求、候选和证据。
协议不枚举、不读取也不上传其他 Codex 对话 session、任务外本地文件、环境变量、浏览器数据或凭证。
所谓“当前 session 相关内容”仅指客户端明确放入本次 ATOA 工具调用参数的任务内容，不是整个会话历史。
原始 Prompt、验收标准和任务对话只对授权参与者可见，不进入项目成员看板。有项目访问权的用户仅看到脱敏后的开发意图、实现摘要、变更文件、服务端验证结果和可运行 Demo。

## 信任边界

- 客户端不能写项目正式 revision。
- 客户端声明的测试结果不是权威证据。
- 服务器只接受任务 `permissions.write` 中的文件。
- 客户端提交的 `base_revision` 必须匹配任务合约；全局 revision 推进时，服务端还会逐个确认候选目标文件仍匹配任务 SHA-256。
- `queued` 任务不能被领取；客户端应等待其变为 `dispatched`，不能把未绑定的排队任务当作可执行任务。
- Worker launcher 完全由客户端本地配置；服务端只返回任务与租约标识，不能下发命令、参数或任意本地执行内容。
- 服务端在接受前重新运行安全扫描，并在生产部署的隔离验证侧车中运行固定测试。
- Context 文件仅对任务请求者和被指派客户端 Agent 可见。
- 活动任务的增量 Context 请求若与其他活动任务重叠，会原子拒绝且不增加 Context version。
- 每个项目通过 `project.json.skills` 维护自己的 Skill 集合。Skill 是只读 Context，不能进入任务写权限或候选操作。
- 服务端根据任务目标、验收标准和 Skill triggers 以确定性规则选择相关 Skill；客户端仍负责判断如何使用 Skill。
- Context 使用完整 SHA-256 内容寻址。缓存按服务端、客户端身份和项目隔离，缓存内容不是可编辑 checkout。
- 紧凑操作支持 `replace`、`insert_before`、`insert_after` 和 `append`；所有操作都应绑定 Context 文件哈希。
- 验证失败的候选由服务端私有缓存；公共任务响应不会暴露完整候选内容。
- 服务端会拒绝候选中新增加的 API Key、Token、云凭证、Cookie、sessionStorage、网络外发、外部脚本和动态代码。
- 项目命名空间的 `localStorage` 只允许保存非敏感应用状态。
- 只有接受的候选会生成 contribution、最终 revision 和可运行 Demo；失败候选不会形成版本。

## 重试策略

- 代码需要修改：提交新的 operations 或完整 files。
- 代码不需要修改，只修复了服务端策略或验证环境：提交 `reuse_candidate: true`。
- `usage.candidate_reuses` 记录复用次数，`usage.candidate_bytes_avoided` 估算避免重复上传的字节数。

## Context 缓存

- CLI 默认把只读 blob 保存在 `ATOA_HOME/cache/context-v1/`。
- `delegate claim`、`delegate show` 和 `delegate request-context` 会自动解析源码与 Skill manifest，并在返回给 Agent 前恢复完整 Context。
- `usage.context_cache_hits`、`context_cache_misses`、`context_content_bytes_sent` 和 `context_bytes_avoided` 用于衡量缓存效果。
- 默认每个服务端/身份/项目缓存上限为 64MB，可通过 `ATOA_CONTEXT_CACHE_MAX_BYTES` 调整；超限按最近使用时间清理。
- 客户端缓存不影响服务端的正式 revision、安全扫描、固定测试或合并权。

## 兼容性

`atoa-cloud/v1` 工作区协议继续保留。新客户端应优先使用 `atoa-delegation/v1`。
