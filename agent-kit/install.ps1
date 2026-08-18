$ErrorActionPreference = "Stop"
$BaseUrl = if ($env:ATOA_BASE_URL) { $env:ATOA_BASE_URL.TrimEnd('/') } else { "http://localhost:7000/agent-kit" }
$Endpoint = if ($env:ATOA_ENDPOINT) { $env:ATOA_ENDPOINT.TrimEnd('/') } else { $BaseUrl -replace '/agent-kit$', '' }
$ServerName = if ($env:ATOA_SERVER_NAME) { $env:ATOA_SERVER_NAME } else { "atoa" }
$InstallDir = if ($env:ATOA_INSTALL_DIR) { $env:ATOA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "ATOA" }
$BinDir = Join-Path $InstallDir "bin"
$RepositoryDir = Join-Path $InstallDir "repository"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "ATOA CLI 需要 Node.js 22 或更高版本。" }
$NodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 22) { throw "当前 Node.js 版本过低；ATOA CLI 需要 22 或更高版本。" }
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$LocalManifest = Join-Path $PSScriptRoot "distribution-manifest.json"
if ($PSScriptRoot -and (Test-Path $LocalManifest) -and (Test-Path (Join-Path $PSScriptRoot "cli/atoa.mjs"))) {
  $KitRoot = $PSScriptRoot
} else {
  $Bootstrap = Join-Path ([System.IO.Path]::GetTempPath()) ("atoa-bootstrap-" + [guid]::NewGuid() + ".mjs")
  try {
    Invoke-WebRequest "$BaseUrl/bootstrap.mjs" -OutFile $Bootstrap
    & node $Bootstrap --base $BaseUrl --target $RepositoryDir
    if ($LASTEXITCODE -ne 0) { throw "ATOA Agent Kit 下载失败。" }
  } finally {
    Remove-Item $Bootstrap -Force -ErrorAction SilentlyContinue
  }
  $KitRoot = $RepositoryDir
}
Copy-Item (Join-Path $KitRoot "cli/atoa.mjs") (Join-Path $InstallDir "atoa.mjs") -Force
Set-Content -Path (Join-Path $BinDir "atoa.cmd") -Value "@node `"$InstallDir\atoa.mjs`" %*"
& (Join-Path $BinDir "atoa.cmd") server add --name $ServerName --endpoint $Endpoint | Out-Null
& (Join-Path $BinDir "atoa.cmd") server use --name $ServerName | Out-Null
$SkillsSynced = $false
for ($Attempt = 1; $Attempt -le 5; $Attempt++) {
  & (Join-Path $BinDir "atoa.cmd") skills sync
  if ($LASTEXITCODE -eq 0) {
    $SkillsSynced = $true
    break
  }
  if ($Attempt -lt 5) { Start-Sleep -Seconds 1 }
}
if (-not $SkillsSynced) { throw "ATOA Skills 同步失败；请检查 Hub 地址和网络后重试安装。" }
Write-Host "ATOA CLI 已安装到 $BinDir。请将该目录加入 PATH。"
Write-Host "下一步：使用服务端已注册账户运行 atoa auth login --email <你的邮箱>"
if (-not $env:ATOA_SKIP_CODEX_PLUGIN -and (Get-Command codex -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $KitRoot ".agents/plugins/marketplace.json"))) {
  Write-Host "检测到 Codex，正在注册本地 ATOA 插件市场并安装插件……"
  & codex plugin marketplace add $KitRoot
  & codex plugin add atoa-codex@atoa-agent-kit
}
Write-Host "重新打开 Agent 后即可加载 ATOA Skills 和插件。"
