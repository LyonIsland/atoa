# ATOA Collaborative Coding

[English](README.md) | **简体中文**

ATOA 是一个 Agent-native 项目共创平台：用户的本地 Coding Agent 发起修改请求，当前版本
由确定性的服务端控制平面负责合同预检、Context、权限、Context 冲突队列、安全扫描、固定
测试、原子合并和最终 revision。本地 Agent 只执行被授权的实现，不拥有服务端合并权限。

这个开源发行版只包含一个示例项目：`courseplanner`（学生选课助手）。它展示课程筛选、
推荐、工作量统计、时间冲突检测、自动规划和课程评价，并带有固定 Node.js 测试。

## ATOA 的理念与优势

ATOA 希望建立一种协作式 Vibe Coding 模式：创作过程仍属于每个用户自己的 Agent 和私密
会话，而项目事实、运行环境与最终交付由统一的云端服务管理。用户不需要把完整
仓库、全部对话或模型凭据交给平台；客户端只发送当前任务所需的目标、验收标准、进度、
候选变更与证据。云端把通过审查的结果合并为所有参与者都能直接体验的在线版本。

> **当前架构：** 服务端是规则驱动的 Node.js 控制平面，不是 Agent，后续也不会承担 Agent
> 的推理或实现职责。当前版本已经按源码 Context 路径进行同步调度：Context 不重叠的任务可
> 同时执行，存在路径重叠的任务继续排队。更细粒度的符号与显式依赖分析仍在开发中。

服务端不调用模型，也不启动服务端 Agent。它通过标准 REST API 提供项目元数据、任务合同、
Context、权限、队列状态、候选提交、验证结果和版本历史；Agent Kit 再把这些接口包装成客户端
Agent 可调用的 CLI 命令、Skill 和 MCP tools。服务端只执行预先声明的固定测试与确定性规则，
代码理解、方案选择和实现始终发生在客户端 Agent。

它围绕四个核心优势展开：

1. **无需配置环境，验收后直接部署。** 客户端不必 clone 完整项目、安装依赖、配置运行时
   或手工上线。服务端持有权威环境，负责固定测试、安全扫描、原子合并和 Demo 部署。
2. **私密会话，共享成果。** 用户的原始 Prompt、实验过程和开发对话只对任务参与者可见；
   公开侧只展示脱敏后的开发意图、实现摘要、验证结果、revision 和可运行 Demo。
3. **即时但有边界的协作。** 控制平面用源码 Context 路径作为当前的并发占用单元：不重叠的
   任务可以同时派发；重叠任务按创建顺序等待，占用释放后再基于最新 revision 生成 Context。
   增量 Context 请求也必须通过相同冲突检查。提交时即使全局 revision 已由不相关贡献推进，
   只要候选目标文件仍匹配原 SHA-256，就可在当前项目上重新验证并安全合并；目标文件变化则
   返回 revision conflict。更细粒度的符号依赖分析仍在开发中。
4. **自带 Agent 与模型能力。** 用户选择自己的 Coding Agent、模型和 Token，并自行控制模型
   成本；平台不转售模型能力，也不会接管客户端的 Agent launcher 或模型凭据。

当前已经落地的是“个人 Agent + 服务端控制平面”：个人 Agent 负责理解意图、规划、实现并
返回候选；控制平面按照固定策略负责合同预检、Context 选择、文件权限、队列、base revision、
验证、合并和最终版本。客户端提供的检查只是证据，只有服务端验证通过的候选才能改变公开
项目。任务排队时，按需本地 Worker 会继续等待；任务被派发后，它会启动新的客户端 Agent，
因此最初发起请求的 Agent 不需要保持本轮阻塞。

已经实现的是基于源码 Context 的第一阶段同步协作规则，而不是服务端 Agent：控制平面根据
Context、写权限和文件 hash 决定哪些任务可以并行，并在候选返回后处理验证顺序与 revision
兼容性。后续会加入更细粒度的符号和显式依赖分析。每次接受的贡献仍会形成可审计的 revision 和不可变的可运行
Demo，让协作者无需拉取代码和搭建环境，就能直接理解并体验这个版本解决了什么问题。

## 开源发行边界

发行包不包含以下私有或运行时内容：

- 真实 Agent 身份、会话、任务、Prompt、候选和贡献数据库；
- 已部署服务的域名、内部宿主控制脚本或访问令牌；
- `.env`、Demo 历史、日志、缓存、`node_modules` 和旧 Git 历史；
- 选课助手以外的内置平台项目。

`npm run check:release` 会检查项目数量、禁止文件、私有域名、宿主集成痕迹、私钥和常见
Token 格式。发布前仍应使用你所在组织的 secret scanner，并单独审计 Git 历史。

## 部署服务端

当前版本保持为单一 Node.js 服务，使用内嵌 SQLite 持久化身份、Session、任务和贡献记录，不需要
另行部署数据库服务。要求 Node.js 22 或更高版本：

```bash
npm ci
mkdir -p data/demo-history
cp .env.example .env
npm start
```

`.env.example` 默认把运行时数据放在源码目录下被 Git 忽略的 `data/` 中。部署时至少修改：

```dotenv
PUBLIC_URL=https://atoa.example.com
ATOA_INVITE_CODE=使用密码管理器生成的长随机字符串
```

互联网生产部署不要沿用开发目录布局。仓库提供了独立数据卷、专用系统账户、`UMask=0077`、
systemd 文件系统限制、Nginx 防下载规则和启动前配置审计模板；完整安装步骤见
[生产部署安全基线](deploy/README.zh-CN.md)。生产启动前检查可通过 `npm run check:production`
运行，开发环境不需要通过该检查。

也可以通过环境变量启动：

```bash
PORT=7000 \
PUBLIC_URL=http://localhost:7000 \
ATOA_SQLITE_FILE="$PWD/data/atoa.sqlite" \
ATOA_MANAGED_PROJECTS_ROOT="$PWD/data/projects" \
ATOA_DEMO_HISTORY_ROOT="$PWD/data/demo-history" \
ATOA_CLOUD_ROOT="$PWD/cloud-projects" \
ATOA_INVITE_CODE='replace-with-a-long-random-value' \
npm start
```

在长期运行的服务器上，可使用 systemd、Supervisor 或部署方现有的 Node.js 进程管理机制保持
`npm start` 运行。把 7000 端口放在 Caddy、Nginx 或云负载均衡之后，并只对外提供 HTTPS；
反向代理需要保留 `Host` 和 `X-Forwarded-Proto`。`PUBLIC_URL` 必须是用户实际访问的 HTTPS
origin，不能包含尾部 `/`。

部署完成后检查：

```bash
curl https://atoa.example.com/api/v1
curl -I https://atoa.example.com/agent-kit/install.sh
curl -I https://atoa.example.com/cloud-apps/courseplanner/
```

SQLite 启用 WAL、外键、5 秒 busy timeout、完整同步和 schema migration。当前应用仍按单个
Node.js 实例运行；不要使用 PM2 cluster 或让多个服务进程同时读写同一个数据库。需要横向扩展时，
应先迁移到共享数据库和跨实例事务模型。

升级前停止 ATOA 进程并备份整个 `data/`，这样数据库、WAL、托管项目和 Demo 历史会处于同一个
恢复点。恢复时停止服务、替换完整 `data/`，再启动并检查 `/api/v1`。不要只在服务运行期间复制
`atoa.sqlite` 主文件，也不要把 `.env`、数据库、项目运行时目录或 Demo 历史提交到 Git。

### 从 2.2 JSON 数据迁移

2.3 首次启动会自动创建 SQLite schema。旧部署保留原来的 `ATOA_DB_FILE=...json` 也可以启动：
服务会把该配置识别为只读迁移源，在同目录或默认 `data/atoa.sqlite` 中创建 SQLite 数据库，并一次性
导入用户、Session、任务和贡献。也可以显式配置：

```dotenv
ATOA_SQLITE_FILE=./data/atoa.sqlite
ATOA_LEGACY_JSON_FILE=./data/atoa-data.json
```

导入记录和源文件 SHA-256 会写入 `legacy_imports`，后续重启不会重复导入。原 JSON 文件不会自动
删除；确认账户、项目和历史正常后，将它移入受保护的离线备份。JSON 损坏或 collection 结构错误时
服务会拒绝启动，不会再静默生成空数据库。

`ATOA_INVITE_CODE` 只允许创建新账户，不能用于登录或冒用现有账户。注册密码使用随机 salt
和 scrypt 保存；客户端登录只接受已经注册的邮箱与密码。如果需要验证邮箱所有权或企业身份，
请在 ATOA 前面部署 identity-aware proxy。完整注意事项见 [SECURITY.md](SECURITY.md)。

### 当前验证边界

服务端只接受任务合同授权的文件，并对 `base_revision`、逐文件 SHA-256、文件白名单、源码大小、
危险能力和固定测试进行确定性校验。候选先物化到临时副本；失败候选不会修改公开项目，合并
过程保持原子性，已接受版本可以从 Demo 历史恢复。

当前版本的固定测试由服务端启动受限的本地子进程执行，设置超时和输出上限，但不提供操作系统
级的不可信代码沙箱。它适用于由部署方管理项目、Skill、固定测试和受邀成员的当前产品阶段。
若要开放给完全不可信的任意代码执行，应由部署方接入自己的隔离运行或发布机制；这不是当前
数据通信协议的一部分。

## 浏览器登录、注册与项目权限

访问服务端首页时，未登录用户会被重定向到 `/login`。注册需要部署方邀请码；登录只接受已经
注册的邮箱和密码。浏览器 Session 使用 Secure HttpOnly Cookie，不把访问 Token 写入
localStorage、sessionStorage 或页面 JavaScript。项目目录、Dashboard、预览、Demo、文件、
Context、任务和贡献接口都经过服务端项目 ACL，不能依赖隐藏按钮代替授权检查。

内置 `courseplanner` 声明为所有注册用户可参与。用户创建的托管项目默认私有，仅创建者和创建者
明确添加的成员可以发现和参与；只有创建者可以管理成员和项目 Skill。

## 使用 CLI 创建项目、添加成员与 Skill

邀请码只在注册时使用：

```bash
read -rsp "ATOA invite code: " ATOA_INVITE_CODE; echo
read -rsp "New ATOA password: " ATOA_PASSWORD; echo
export ATOA_INVITE_CODE ATOA_PASSWORD
atoa auth register --email user@example.com --name "Your name"
unset ATOA_INVITE_CODE
atoa auth login --email user@example.com
unset ATOA_PASSWORD
```

登录不会自动创建账户。未注册邮箱、错误密码和弱密码都会被拒绝。创建一个持久化项目并添加
项目 Skill：

```bash
atoa cloud create \
  --id release-notes \
  --name "Release Notes" \
  --description "A shared project for preparing reviewed product release notes."

atoa cloud skill-add \
  --project release-notes \
  --id release-checklist \
  --name "Release Checklist" \
  --description "Conventions for reviewable release notes" \
  --instructions "Preserve headings, identify compatibility changes, and include validation evidence." \
  --triggers '["release","发布","changelog"]'
```

项目创建者可以把另一个已注册账户加入私有项目：

```bash
atoa cloud member-add --project release-notes --email teammate@example.com
atoa cloud member-list --project release-notes
# member-list 返回稳定 member id 后，可以撤销访问
atoa cloud member-remove --project release-notes --member agt_xxx --confirm
```

撤销成员会同步取消该成员在项目中的活动任务。新项目自动包含初始页面、四个可编辑文件和固定
测试，创建后即可用于委派、Context 下发、验证、合并和可运行版本发布。

## 向目标用户分发 Agent Kit

服务端会从 `/agent-kit/` 直接发布与当前协议匹配的 CLI、Skill 和 Codex 插件。把下面的
`https://atoa.example.com` 换成你的域名，再发送给受邀用户。

Linux / macOS：

```bash
curl -fsSL https://atoa.example.com/agent-kit/install.sh \
  | env ATOA_BASE_URL=https://atoa.example.com/agent-kit \
        ATOA_ENDPOINT=https://atoa.example.com \
        bash

atoa auth login --email user@example.com
atoa doctor
```

Windows PowerShell：

```powershell
$env:ATOA_BASE_URL = "https://atoa.example.com/agent-kit"
$env:ATOA_ENDPOINT = "https://atoa.example.com"
irm https://atoa.example.com/agent-kit/install.ps1 | iex
atoa auth login --email user@example.com
atoa doctor
```

安装器会保存目标服务端地址、安装 `atoa` CLI、同步 `atoa-cocreation` Skill；检测到 Codex
CLI 时，还会注册仓库内的 marketplace 并安装 `atoa-codex` 插件。Codex 用户应先按
[OpenAI 官方 Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli)完成 Codex 安装与登录。
插件安装后必须新建 Codex 会话，新的 Skill 和 MCP 工具才会加载。

如果用户没有 Codex，也可以直接使用 `atoa` CLI；本地 Worker 的默认 Agent launcher 是
`codex exec`，可由用户在本机通过 `ATOA_WORKER_AGENT_COMMAND` 和
`ATOA_WORKER_AGENT_ARGS_JSON` 选择受信任的其他 launcher。服务端不能下发或修改该命令。

### 建议发给用户的最短引导

1. 安装 Node.js 22+ 和自己的 Coding Agent。
2. 运行管理员提供的 Agent Kit 安装命令。
3. 管理员先邀请用户完成注册；用户使用已注册邮箱和自己的密码登录。
4. 新开 Agent 会话后说：“列出 ATOA 当前开放的共创项目”。
5. 对 `courseplanner` 提出明确修改目标和验收标准。

## 验证开源副本

```bash
npm ci
node --check server.js
npm test
npm run check:release
git diff --check
```

协议说明见 [CLOUD_PROTOCOL.md](CLOUD_PROTOCOL.md)，客户端细节见
[agent-kit/README.md](agent-kit/README.md)。

## License

MIT，见 [LICENSE](LICENSE)。
