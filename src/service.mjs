// service —— 把守护进程注册为开机自启（M3）。
//   macOS：写 LaunchAgent 并 launchctl bootstrap（用户级，无需 sudo）
//   Linux：写 systemd 用户单元并 enable --now（用户级，无需 sudo）
// --remove 反向卸载。carrier 语境进程是另一个概念（设计 §9），不在此命令内。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function nodeNameOf(configDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
    return String(raw.node || "default").replace(/[^A-Za-z0-9_.-]/g, "-");
  } catch {
    return "default";
  }
}

function xmlEscape(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function run(cmd, args, { ignore = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (ignore) return "";
    throw new Error(`${cmd} ${args.join(" ")} 失败：${(e.stderr || e.message || "").toString().slice(0, 300)}`);
  }
}

export async function service(configDir, { remove = false } = {}, appDir) {
  const node = nodeNameOf(configDir);
  const appBin = path.join(appDir, "bin", "hub-node.mjs");
  const logPath = path.join(configDir, "daemon.log");

  if (process.platform === "darwin") {
    const label = `hub-node.${node}`;
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const uid = String(process.getuid());
    if (remove) {
      run("launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      console.log(`已卸载自启：${label}`);
      return 0;
    }
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>ProgramArguments</key><array>
<string>${xmlEscape(process.execPath)}</string>
<string>${xmlEscape(appBin)}</string>
<string>daemon</string>
<string>--config</string>
<string>${xmlEscape(configDir)}</string>
</array>
<key>WorkingDirectory</key><string>${xmlEscape(configDir)}</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>${xmlEscape(path.dirname(process.execPath))}:${xmlEscape(path.join(os.homedir(), ".local", "bin"))}:/usr/local/bin:/usr/bin:/bin</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    run("launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
    run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    console.log(`自启已安装并启动：${label}`);
    console.log(`  plist：${plistPath}`);
    console.log(`  日志：${logPath}`);
    console.log(`  卸载：hub-node service --remove --config ${configDir}`);
    return 0;
  }

  if (process.platform === "linux") {
    const unit = `hub-node-${node}.service`;
    const unitPath = path.join(os.homedir(), ".config", "systemd", "user", unit);
    if (remove) {
      run("systemctl", ["--user", "disable", "--now", unit], { ignore: true });
      if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
      run("systemctl", ["--user", "daemon-reload"], { ignore: true });
      console.log(`已卸载自启：${unit}`);
      return 0;
    }
    const text = `[Unit]
Description=hub-node daemon (${node})
After=network-online.target

[Service]
ExecStart=${process.execPath} ${appBin} daemon --config ${configDir}
WorkingDirectory=${configDir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, text);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", unit]);
    console.log(`自启已安装并启动：${unit}`);
    console.log(`  单元：${unitPath}`);
    console.log(`  日志：journalctl --user -u ${unit}`);
    console.log(`  卸载：hub-node service --remove --config ${configDir}`);
    return 0;
  }

  console.log(`暂不支持在 ${process.platform} 上自动注册自启；请用任务计划程序手动安排：`);
  console.log(`  ${process.execPath} ${appBin} daemon --config ${configDir}`);
  return 1;
}
