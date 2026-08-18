#!/usr/bin/env bash
set -euo pipefail

ATOA_BASE_URL="${ATOA_BASE_URL:-http://localhost:7000/agent-kit}"
ATOA_ENDPOINT="${ATOA_ENDPOINT:-${ATOA_BASE_URL%/agent-kit}}"
ATOA_SERVER_NAME="${ATOA_SERVER_NAME:-atoa}"
ATOA_INSTALL_DIR="${ATOA_INSTALL_DIR:-$HOME/.local/share/atoa}"
ATOA_BIN_DIR="${ATOA_BIN_DIR:-$HOME/.local/bin}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)"
REPOSITORY_DIR="$ATOA_INSTALL_DIR/repository"

if ! command -v node >/dev/null 2>&1; then
  echo "ATOA CLI 需要 Node.js 22 或更高版本。请先安装 Node.js，再重新运行。" >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 22 ]; then
  echo "当前 Node.js 版本过低；ATOA CLI 需要 22 或更高版本。" >&2
  exit 1
fi

mkdir -p "$ATOA_INSTALL_DIR/cli" "$ATOA_BIN_DIR"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/distribution-manifest.json" ] && [ -f "$SCRIPT_DIR/cli/atoa.mjs" ]; then
  KIT_ROOT="$SCRIPT_DIR"
else
  bootstrap_temp="$(mktemp)"
  bootstrap_file="${bootstrap_temp}.mjs"
  mv "$bootstrap_temp" "$bootstrap_file"
  trap 'rm -f "$bootstrap_file"' EXIT
  curl -fsSL "$ATOA_BASE_URL/bootstrap.mjs" -o "$bootstrap_file"
  node "$bootstrap_file" --base "$ATOA_BASE_URL" --target "$REPOSITORY_DIR"
  KIT_ROOT="$REPOSITORY_DIR"
fi
install -m 755 "$KIT_ROOT/cli/atoa.mjs" "$ATOA_INSTALL_DIR/cli/atoa.mjs"
chmod 755 "$ATOA_INSTALL_DIR/cli/atoa.mjs"

launcher="$ATOA_BIN_DIR/atoa"
{
  echo '#!/usr/bin/env bash'
  printf 'exec node %q "$@"\n' "$ATOA_INSTALL_DIR/cli/atoa.mjs"
} > "$launcher"
chmod 755 "$launcher"

"$launcher" server add --name "$ATOA_SERVER_NAME" --endpoint "$ATOA_ENDPOINT" >/dev/null
"$launcher" server use --name "$ATOA_SERVER_NAME" >/dev/null

skills_synced=0
for attempt in 1 2 3 4 5; do
  if "$launcher" skills sync; then
    skills_synced=1
    break
  fi
  if [ "$attempt" -lt 5 ]; then sleep 1; fi
done
if [ "$skills_synced" -ne 1 ]; then
  echo "ATOA Skills 同步失败；请检查 Hub 地址和网络后重试安装。" >&2
  exit 1
fi
echo "ATOA CLI 已安装：$launcher"
echo "下一步：使用服务端已注册账户运行 atoa auth login --email <你的邮箱>"

if [ "${ATOA_SKIP_CODEX_PLUGIN:-0}" != "1" ] && command -v codex >/dev/null 2>&1 && [ -f "$KIT_ROOT/.agents/plugins/marketplace.json" ]; then
  echo "检测到 Codex，正在注册本地 ATOA 插件市场并安装插件……"
  codex plugin marketplace add "$KIT_ROOT" || true
  codex plugin add atoa-codex@atoa-agent-kit || true
fi

echo "重新打开 Agent 后即可加载 ATOA Skills 和插件。"
