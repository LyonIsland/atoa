# ATOA Agent Kit

ATOA 是面向 Agent Coding 时代的云端共创与可运行版本平台。用户级 Codex 负责理解需求和执行任务；用户继续使用自己的私有 Coding Agent，自主选择模型并管理 Token，不必购买平台 Token、clone 完整项目、配置运行环境或手工上线。云端统一 Server 提供任务合同、最小 Context、项目 Skills、权限、安全扫描、固定验证、原子合并、部署和可运行 Demo 历史。

协议只发送当前共创任务明确需要的请求、验收标准、进度、增量 Context 请求、候选和证据。它不会读取或上传其他 Codex 对话 session、任务外本地文件、环境变量或凭证。原始 Prompt 和任务对话只对参与者可见；有项目访问权的用户只能看到脱敏后的贡献意图、结果、验证和 Demo。服务端会在合并前阻断 API Key、Token、Cookie、网络外发、外部脚本和动态代码风险。

Agent Kit 包含：

- `cli/`：身份认证、任务委派、动态 Context、候选结果和兼容工作区命令
- `skills/atoa-cocreation/`：分布式 Agent 项目共创 Skill
- `plugins/atoa-codex/`：Codex MCP 插件
- ATOA Delegation Protocol：跨网络的任务、Context、进度、修订和接受协议

## 安装

Linux / macOS：

```bash
curl -fsSL https://atoa.example.com/agent-kit/install.sh \
  | env ATOA_BASE_URL=https://atoa.example.com/agent-kit \
        ATOA_ENDPOINT=https://atoa.example.com \
        bash
ATOA_PASSWORD='用户注册时设置的密码' atoa auth login --email you@example.com
```

Windows PowerShell：

```powershell
$env:ATOA_BASE_URL = "https://atoa.example.com/agent-kit"
$env:ATOA_ENDPOINT = "https://atoa.example.com"
irm https://atoa.example.com/agent-kit/install.ps1 | iex
$env:ATOA_PASSWORD = Read-Host "ATOA password" -MaskInput
atoa auth login --email you@example.com
Remove-Item Env:ATOA_PASSWORD
```

把 `atoa.example.com` 替换为平台管理员提供的域名。要求 Node.js 22 或更高版本。安装器会保存该服务端、安装 CLI、同步 `atoa-cocreation` Skill，并在检测到 Codex 时安装 `atoa-codex` 插件。安装插件后需要新建 Codex 会话。

登录只接受服务端已注册账户，不会根据客户端提交的邮箱临时创建身份。首次注册使用部署方提供
的邀请码执行 `atoa auth register`，之后邀请码不再参与登录。密码默认交互式隐藏输入；自动化
环境可临时使用 `ATOA_PASSWORD`，完成后立即删除。

已登录用户可用 `cloud create` 创建持久化项目；项目创建者可用 `cloud skill-add` 添加项目级
只读 Skill，并用 `cloud member-add|member-list|member-remove` 管理已经注册的项目成员。托管项目
默认私有，项目列表只返回当前身份有权访问的项目。对应 MCP 工具包括项目创建、Skill 添加和
成员增删工具。

## 服务端控制平面委派

```bash
atoa delegate create \
  --project courseplanner \
  --objective "推荐课程时排除时间冲突" \
  --acceptance '["现有测试通过","增加冲突场景覆盖"]'

atoa delegate claim --task task_xxx
atoa delegate request-context --task task_xxx --reason "缺少调用方" --query "recommendCourses references"
atoa delegate progress --task task_xxx --message "实现完成，正在审查候选文件"
atoa delegate usage --task task_xxx
atoa delegate submit \
  --task task_xxx \
  --base-revision ed103d0d \
  --message "排除时间冲突课程" \
  --summary "复用现有冲突检测并增加测试" \
  --operations '[{"type":"insert_before","path":"public/app.js","expected_hash":"...","anchor":"if (typeof document","content":"// implementation\n"}]' \
  --evidence '{"client_checks":["reviewed diff"]}' \
  --confirm

# 候选代码未变、仅服务端策略或验证环境修复时
atoa delegate submit \
  --task task_xxx \
  --base-revision ed103d0d \
  --reuse-candidate \
  --confirm
```

标准流程：

1. `delegate create` 把用户目标发送到 ATOA 服务端；服务端先按固定规则检查验收条件与安全策略，再选择源码 Context。与活动任务 Context 不重叠时立即同步派发；重叠时返回 `queued`，CLI 自动登记给按需本地 Worker，当前 Agent 可以结束。
2. 只有 `dispatched` 任务才能执行 `delegate claim`。排队任务会在相关 Context 占用释放后，基于最新 revision 自动生成 Context；Worker 取得短期启动租约并启动一个新的本地 Agent，CLI 随后根据 SHA-256 manifest 恢复完整 Context。
3. ATOA 原生项目在 `project.json.skills` 中维护可复用 Skill；通过 `ATOA_PROGRAM_PROJECTS=id=/absolute/path` 注册的 Program Project 则由服务端直接解析原路径，并自动登记其中已有的 `.claude/skills`、`.agents/skills` 或 `skills`，不复制项目或写入 ATOA 元数据。服务端按任务目标和 triggers 下发可能需要的 Skill；Agent 判断 Context 不足时，可通过 `delegate request-context` 补充相关源码和 Skill，不需要本地 clone。
4. `delegate submit` 优先返回带文件哈希的紧凑原子操作；结构性新增使用短而唯一的 `insert_before/insert_after` 锚点。
5. 服务端控制平面独立进行安全审查和固定测试，随后接受合并或返回修订意见。服务端不是 Agent，也不负责实现任务。
6. 候选未改变而服务端环境已修复时，使用 `--reuse-candidate` 直接重跑验证，避免重复上传。
7. 接受的候选会被直接部署，并保存为与最终 revision 对应的不可变可运行 Demo；失败候选不会生成版本。

Context 缓存位于 `ATOA_HOME/cache/context-v1/`，按服务端、客户端身份和项目隔离，默认每个项目上限 64MB。它只保存经过完整 SHA-256 校验的不可变源码与 Skill 内容，不是工作区；正式测试、验收和合并始终在服务端执行。

旧的 `cloud checkout|validate|submit|cleanup` 工作区流程保留兼容，但默认共创路径是委派协议。

当前版本已按源码 Context 路径同步派发可解耦任务；重叠任务继续排队，增量 Context 扩张也受冲突检查。全局 revision 被不相关贡献推进时，目标文件 SHA-256 未变化的候选仍可重新验证并合并；目标文件变化则必须重新派发。更细粒度的符号和显式依赖分析仍在开发中。

## CLI

```text
auth register|login|logout|status
delegate create|list|show|claim|context|request-context|progress|submit|usage|cancel
worker ensure|run|status
cloud create|skill-add|member-list|member-add|member-remove|list|show|read|test|history
cloud checkout|validate|submit|cleanup|change
server list|add|use
skills sync
doctor
```

## 自建平台

```bash
atoa server add --name local --endpoint http://localhost:7000
atoa server use --name local
atoa skills sync
```

远程自建平台应使用 HTTPS。安装器接受 `ATOA_BASE_URL`、`ATOA_ENDPOINT` 和可选的 `ATOA_SERVER_NAME`，因此分发方无需修改 Agent Kit 源码或写入自己的域名。邀请码只在注册请求中发送；登录使用已注册账户的密码。邀请码和密码都不会写入服务端项目源码。
