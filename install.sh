#!/bin/sh
# lark-a2a-hub 一行安装：
#   curl -fsSL https://raw.githubusercontent.com/backtomyfuture/lark-a2a-hub/main/install.sh | sh
# 布局：~/.hub-node/ 是配置目录，~/.hub-node/app/ 是程序本体，
#       ~/.local/bin/hub-node 是命令入口。
# 不在这里种 node.json / commands.json：example 里的占位符和 lan-exec
# 会让随后的 hub-node setup --yes 拒绝覆盖，或让 doctor 因 carrier 离线失败。
# 正式配置（含绝对路径 echo 种子）由 hub-node setup 生成。
# 重跑本脚本 = 更新程序（git pull 或重新下载），已有配置不覆盖。
set -eu

REPO_GIT="https://github.com/backtomyfuture/lark-a2a-hub.git"
REPO_TAR="https://codeload.github.com/backtomyfuture/lark-a2a-hub/tar.gz/refs/heads/main"
HOME_DIR="${HUB_NODE_HOME:-$HOME/.hub-node}"
APP="$HOME_DIR/app"

command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js >= 20" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 版本过低（当前 $(node -v)），需要 >= 20" >&2; exit 1; }

mkdir -p "$HOME_DIR"

if [ -d "$APP/.git" ]; then
  echo "更新已有安装…"
  git -C "$APP" pull --ff-only
elif [ -e "$APP" ]; then
  echo "$APP 已存在但不是 git 检出，请先移走它再重跑" >&2
  exit 1
elif command -v git >/dev/null 2>&1; then
  git clone --depth 1 "$REPO_GIT" "$APP"
else
  echo "未找到 git，改用压缩包安装…"
  TMP="$(mktemp -d)"
  curl -fsSL "$REPO_TAR" | tar xz -C "$TMP"
  mv "$TMP"/lark-a2a-hub-main "$APP"
  rm -rf "$TMP"
fi

cd "$APP"
npm install --omit=dev --no-audit --no-fund

# 凭据文件可以先摆一个空壳（600）；node.json / commands.json 留给 setup，
# 避免把带占位符和 lan-exec 的 example 当成正式配置。
if [ ! -f "$HOME_DIR/app.env" ]; then
  printf 'APP_ID=\nAPP_SECRET=\n' > "$HOME_DIR/app.env"
  chmod 600 "$HOME_DIR/app.env"
  echo "已生成凭据文件：$HOME_DIR/app.env（需填入飞书应用的 APP_ID / APP_SECRET）"
fi

chmod +x "$APP/bin/hub-node.mjs"
mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/hub-node.mjs" "$HOME/.local/bin/hub-node"

cat <<EOF

安装完成。接下来只需一条命令完成全部配置：
  hub-node setup
（自动装/复用 lark-cli、发现 Base 表、写好配置并自检；细节见 README）
若 hub-node 命令找不到，把 \$HOME/.local/bin 加入 PATH。
EOF
