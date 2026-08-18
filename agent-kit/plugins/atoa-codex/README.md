# ATOA Collaborative Coding for Codex

该插件只提供分布式 Agent 项目共创能力：

- 发现和检查 ATOA 托管项目
- 按用户明确授权创建持久化项目，并由项目创建者添加只读项目 Skill
- 把目标和验收标准发送给服务端控制平面，由固定规则检查并派发任务
- 排队时把任务交给按需本地 Worker；Worker 在派发后启动新的本地 Codex run，并在任务清空后退出
- 以授权客户端 Agent 身份领取 Context manifest，通过 SHA-256 本地只读缓存只下载缺失内容
- Context 不足时双向请求补充
- 返回候选文件和执行证据
- 由服务端重新验证、要求修订或原子合并
- 接受后返回可直接运行的不可变 Demo 版本

插件只把当前用户授权的共创任务内容放入 ATOA 工具调用，包括目标、验收标准、进度、Context 请求、候选和证据。
它不得读取或上传其他 Codex session、任务外本地文件、环境变量、浏览器数据或本地凭证。API Key、Token 和私有 AI 服务配置不得进入候选代码。

本地 Context 缓存不是 checkout。Agent 先检查缓存恢复的文件能否支持本次编辑，不足时再请求服务端补充；测试和最终验收始终由服务端执行。

推荐工具顺序：

```text
atoa_cloud_projects
optional owner action: atoa_cloud_create_project
optional owner action: atoa_cloud_add_project_skill
atoa_delegate_create
queued: verify worker_handoff and end the current turn
dispatched: atoa_delegate_claim
atoa_delegate_request_context
atoa_delegate_submit_result
atoa_cloud_history
```
