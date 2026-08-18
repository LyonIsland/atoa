# 学生选课助手

这是 ATOA Cloud Protocol 的第一个示例项目。源代码始终保存在 ATOA
服务器，本地 Coding Agent 无需 clone 仓库即可读取并提交贡献。

应用提供课程筛选、选课方案、学分与工作量统计、时间冲突检查及个性化推荐。

可修改文件仅限 `project.json` 中的 `editable_files`。每次变更会先复制到临时工作区，
通过安全规则和固定的 Node.js 测试后才写入在线版本。

在线入口：`/cloud-apps/courseplanner/`
