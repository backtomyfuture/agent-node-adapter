#!/bin/bash
# 自愈：确保 agent-hub-receiver 服务存在且在跑。
# 适用于宿主机可能被整体替换/重装、/etc 下手装的 unit 会丢失的环境：
# unit 副本放在持久目录（HUB_DIR）里，本脚本由定时巡检或开机检测调用，
# 缺失即重装。输出 OK 表示健康；REPAIRED 表示刚修复；BROKEN 表示修不好。
UNIT=/etc/systemd/system/agent-hub-receiver.service
SRC="${HUB_DIR:-/opt/agent-hub}/agent-hub-receiver.service"
if [ ! -f "$UNIT" ]; then
  cp "$SRC" "$UNIT" && systemctl daemon-reload && systemctl enable agent-hub-receiver.service >/dev/null 2>&1
  systemctl start agent-hub-receiver.service
  echo "REPAIRED: unit was missing, reinstalled and started"
  exit 0
fi
if ! systemctl is-active --quiet agent-hub-receiver.service; then
  systemctl restart agent-hub-receiver.service
  sleep 5
  if systemctl is-active --quiet agent-hub-receiver.service; then
    echo "REPAIRED: service was down, restarted"
  else
    echo "BROKEN: restart failed"
  fi
  exit 0
fi
echo "OK"
