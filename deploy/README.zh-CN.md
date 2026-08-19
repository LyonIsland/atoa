# ATOA 生产部署安全基线

这些文件只用于生产服务器。开发服务器可以继续使用仓库内被 Git 忽略的 `./data`。

## 目录和账户

以管理员身份创建无登录权限的专用账户，并准备彼此分离的代码、配置和数据目录：

```bash
sudo useradd --system --home-dir /var/lib/atoa --shell /usr/sbin/nologin atoa
sudo install -d -o atoa -g atoa -m 0700 /var/lib/atoa
sudo install -d -o atoa -g atoa -m 0700 /var/lib/atoa/cloud-projects
sudo install -d -o atoa -g atoa -m 0700 /var/lib/atoa/projects
sudo install -d -o atoa -g atoa -m 0700 /var/lib/atoa/demo-history
sudo install -d -o root -g atoa -m 0750 /etc/atoa
sudo install -d -o root -g root -m 0755 /opt/atoa/releases
```

把干净的 `git archive` 或构建产物安装到 `/opt/atoa/releases/<version>`，再由部署层维护
`/opt/atoa/current`。不要复制开发机的 `.env` 或 `data/`。

首次部署时，将发行版的内置项目初始化到权威数据卷；以后的代码更新不要覆盖这个目录：

```bash
sudo cp -a /opt/atoa/current/cloud-projects/. /var/lib/atoa/cloud-projects/
sudo chown -R atoa:atoa /var/lib/atoa/cloud-projects
sudo chmod -R go-rwx /var/lib/atoa/cloud-projects
```

复制 `production.env.example` 到 `/etc/atoa/atoa.env`，填入实际 HTTPS origin 和由密码管理器
生成的至少 32 字符邀请码，然后执行：

```bash
sudo chown root:atoa /etc/atoa/atoa.env
sudo chmod 0640 /etc/atoa/atoa.env
```

安装 `atoa.service` 前确认服务器上的 Node 路径是 `/usr/bin/node`。安装并启动后，
`ExecStartPre` 会拒绝相对数据路径、源码树内的数据路径、HTTP origin、弱邀请码和过宽的文件权限。

```bash
sudo install -o root -g root -m 0644 deploy/atoa.service /etc/systemd/system/atoa.service
sudo systemctl daemon-reload
sudo systemctl enable --now atoa
sudo systemctl status atoa
```

将 `nginx.conf.example` 合并到已经启用 TLS 的站点配置。防火墙只向公网开放 HTTPS，不要开放
7000，也不要把 `/opt/atoa` 或 `/var/lib/atoa` 配置成 Web root。

## 更新与备份

每次更新先在开发环境运行 `npm run verify`，只部署干净发行产物。涉及数据库或存储实现的更新，
先在隔离环境用备份副本演练。

一致性备份必须在停止单实例服务后覆盖整个 `/var/lib/atoa`，而不是仅复制主 SQLite 文件：

```bash
sudo systemctl stop atoa
sudo tar --numeric-owner -C /var/lib -czf /var/backups/atoa/atoa-YYYYMMDD-HHMMSS.tar.gz atoa
sudo systemctl start atoa
```

备份目录应为 `0700`，备份文件应为 `0600` 并使用组织的 KMS、加密对象存储、LUKS 或 `age`
加密。恢复时停止服务，恢复完整目录，重新确认 owner/mode，再启动并验证登录、项目 ACL、历史
revision 和 Demo。不要让多个 ATOA 实例或 NFS 客户端共享同一个 SQLite 数据目录。

每次 `systemctl start` 或 `restart` 都会通过 systemd 的 `ExecStartPre` 自动执行生产配置检查；
不需要把环境文件内容展开到命令行或 shell 历史中。
