#!/bin/bash
# 自愈：确保 agent-hub-receiver 服务存在且在跑。
# 适用于宿主机可能被整体替换/重装、/etc 下手装的 unit 会丢失的环境：
# unit 副本放在持久目录（HUB_DIR）里，本脚本由定时巡检或开机检测调用，
# 缺失即重装。输出 OK 表示健康；REPAIRED 表示刚修复；BROKEN 表示修不好。
# 恢复任一步失败，或启动后服务仍不活跃，都打印 BROKEN 并以非 0 退出。
# 巡检只认输出和退出码，不能在 cp/daemon-reload/start 失败时仍报 REPAIRED。
SVC=agent-hub-receiver.service
UNIT=/etc/systemd/system/$SVC
SRC="${HUB_DIR:-/opt/agent-hub}/$SVC"

broken() {
  echo "BROKEN: $*"
  exit 1
}

if [ ! -f "$UNIT" ]; then
  cp "$SRC" "$UNIT" || broken "copy unit failed"
  systemctl daemon-reload || broken "daemon-reload failed"
  systemctl enable "$SVC" >/dev/null 2>&1 || broken "enable failed"
  systemctl start "$SVC" || broken "start failed"
  # start 返回成功不等于进程还在；以 is-active 复核后再报 REPAIRED。
  systemctl is-active --quiet "$SVC" || broken "service not active after start"
  echo "REPAIRED: unit was missing, reinstalled and started"
  exit 0
fi

if ! systemctl is-active --quiet "$SVC"; then
  systemctl restart "$SVC" || broken "restart failed"
  sleep 5
  systemctl is-active --quiet "$SVC" || broken "restart failed"
  echo "REPAIRED: service was down, restarted"
  exit 0
fi

echo "OK"
