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

function roleOf(configDir, opts = {}) {
  if (opts?.role === "node" || opts?.role === "hub") return opts.role;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--role") {
      const v = process.argv[i + 1];
      if (v === "node" || v === "hub") return v;
    } else if (a.startsWith("--role=")) {
      const v = a.slice("--role=".length);
      if (v === "node" || v === "hub") return v;
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
    if (raw.role === "hub" || raw.role === "node") return raw.role;
  } catch {}
  return "node";
}

function xmlEscape(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// systemd 按空白切 ExecStart。配置目录含空格时若不引用，--role 会被吃进路径，
// 守护进程看不到角色参数，退回默认 node，等于把 hub 覆盖成 node。
function systemdArg(value) {
  return '"' + String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function run(cmd, args, { ignore = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (ignore) return "";
    throw new Error(`${cmd} ${args.join(" ")} 失败：${(e.stderr || e.message || "").toString().slice(0, 300)}`);
  }
}

export function renderPlist({ label, appBin, configDir, role, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>ProgramArguments</key><array>
<string>${xmlEscape(process.execPath)}</string>
<string>${xmlEscape(appBin)}</string>
<string>daemon</string>
<string>--config</string>
<string>${xmlEscape(configDir)}</string>
<string>--role</string>
<string>${xmlEscape(role)}</string>
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
}

export function renderSystemdUnit({ role, node, appBin, configDir, isSystem = false, user = "", home = "" }) {
  const serviceLines = [
    `ExecStart=${systemdArg(process.execPath)} ${systemdArg(appBin)} daemon --config ${systemdArg(configDir)} --role ${systemdArg(role)}`,
    `WorkingDirectory=${systemdArg(configDir)}`,
    `Restart=on-failure`,
    `RestartSec=5`,
  ];
  if (isSystem) {
    if (user) serviceLines.unshift(`User=${user}`);
    if (home) serviceLines.unshift(`Environment="HOME=${home}"`);
  }
  return `[Unit]
Description=hub-node daemon (${role}: ${node})
After=network-online.target

[Service]
${serviceLines.join("\n")}

[Install]
WantedBy=${isSystem ? "multi-user.target" : "default.target"}
`;
}

export async function service(configDir, { remove = false, role: explicitRole } = {}, appDir) {
  const role = roleOf(configDir, { role: explicitRole });
  const node = nodeNameOf(configDir);
  const appBin = path.join(appDir, "bin", "lah.mjs");
  const logPath = path.join(configDir, "daemon.log");

  if (process.platform === "darwin") {
    const label = `hub-node-${role}.${node}`;
    const legacyLabel = `hub-node.${node}`;
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const legacyPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${legacyLabel}.plist`);
    const uid = String(process.getuid());
    if (remove) {
      run("launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      if (legacyPlistPath !== plistPath && fs.existsSync(legacyPlistPath)) {
        run("launchctl", ["bootout", `gui/${uid}/${legacyLabel}`], { ignore: true });
        fs.unlinkSync(legacyPlistPath);
      }
      console.log(`已卸载自启：${label}`);
      return 0;
    }
    const plist = renderPlist({ label, appBin, configDir, role, logPath });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    run("launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
    run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    console.log(`自启已安装并启动：${label}（role: ${role}）`);
    console.log(`  plist：${plistPath}`);
    console.log(`  日志：${logPath}`);
    console.log(`  卸载：lah service --remove --role ${role} --config ${configDir}`);
    return 0;
  }

  if (process.platform === "linux") {
    const unit = `hub-node-${role}-${node}.service`;
    const legacyUnit = `hub-node-${node}.service`;
    const unitPath = path.join(os.homedir(), ".config", "systemd", "user", unit);
    const legacyUnitPath = path.join(os.homedir(), ".config", "systemd", "user", legacyUnit);
    const sysUnitPath = `/etc/systemd/system/${unit}`;
    const legacySysUnitPath = `/etc/systemd/system/${legacyUnit}`;
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    let hasSudo = false;
    if (!isRoot) {
      try {
        execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
        hasSudo = true;
      } catch {}
    }

    if (remove) {
      run("systemctl", ["--user", "disable", "--now", unit], { ignore: true });
      if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
      if (legacyUnitPath !== unitPath && fs.existsSync(legacyUnitPath)) {
        run("systemctl", ["--user", "disable", "--now", legacyUnit], { ignore: true });
        fs.unlinkSync(legacyUnitPath);
      }
      run("systemctl", ["--user", "daemon-reload"], { ignore: true });

      // 系统级卸载尝试
      if (isRoot) {
        run("systemctl", ["disable", "--now", unit], { ignore: true });
        if (fs.existsSync(sysUnitPath)) fs.unlinkSync(sysUnitPath);
        if (fs.existsSync(legacySysUnitPath)) fs.unlinkSync(legacySysUnitPath);
        run("systemctl", ["daemon-reload"], { ignore: true });
      } else if (hasSudo) {
        try {
          execFileSync("sudo", ["systemctl", "disable", "--now", unit], { stdio: "ignore" });
          execFileSync("sudo", ["rm", "-f", sysUnitPath, legacySysUnitPath], { stdio: "ignore" });
          execFileSync("sudo", ["systemctl", "daemon-reload"], { stdio: "ignore" });
        } catch {}
      }

      console.log(`已卸载自启：${unit}`);
      return 0;
    }

    // 检查 systemctl --user 是否真正可用
    let hasUserSession = false;
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      hasUserSession = true;
    } catch {
      hasUserSession = false;
    }

    if (hasUserSession) {
      try {
        const text = renderSystemdUnit({ role, node, appBin, configDir });
        fs.mkdirSync(path.dirname(unitPath), { recursive: true });
        fs.writeFileSync(unitPath, text);
        run("systemctl", ["--user", "daemon-reload"]);
        run("systemctl", ["--user", "enable", "--now", unit]);
        console.log(`自启已安装并启动：${unit}（role: ${role}）`);
        console.log(`  单元：${unitPath}`);
        console.log(`  日志：journalctl --user -u ${unit}`);
        console.log(`  卸载：lah service --remove --role ${role} --config ${configDir}`);
        return 0;
      } catch (e) {
        hasUserSession = false;
      }
    }

    // 回退路径 1：若具有 root 或免密 sudo 权限，写入系统级 systemd
    const curUser = os.userInfo().username;
    const curHome = os.homedir();
    if (isRoot || hasSudo) {
      try {
        const text = renderSystemdUnit({ role, node, appBin, configDir, isSystem: true, user: curUser, home: curHome });
        if (isRoot) {
          fs.writeFileSync(sysUnitPath, text);
          run("systemctl", ["daemon-reload"]);
          run("systemctl", ["enable", "--now", unit]);
        } else {
          const tmpUnit = path.join(os.tmpdir(), unit);
          fs.writeFileSync(tmpUnit, text);
          execFileSync("sudo", ["cp", tmpUnit, sysUnitPath]);
          fs.unlinkSync(tmpUnit);
          execFileSync("sudo", ["systemctl", "daemon-reload"]);
          execFileSync("sudo", ["systemctl", "enable", "--now", unit]);
        }
        console.log(`自启已作为系统服务安装并启动：${unit}（role: ${role}）`);
        console.log(`  单元：${sysUnitPath}`);
        console.log(`  日志：journalctl -u ${unit}`);
        console.log(`  卸载：sudo systemctl disable --now ${unit} && sudo rm -f ${sysUnitPath}`);
        return 0;
      } catch {}
    }

    // 回退路径 2：无 systemd user session 且无系统级权限时，以后台进程方式拉起守护，不抛错阻断 setup
    try {
      const { spawn } = await import("node:child_process");
      fs.mkdirSync(configDir, { recursive: true });
      const outFd = fs.openSync(logPath, "a");
      const child = spawn(process.execPath, [appBin, "daemon", "--config", configDir, "--role", role], {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        cwd: configDir,
      });
      child.unref();
      console.log(`· 当前环境未提供 systemd user session，已后台拉起守护进程（PID: ${child.pid}）`);
      console.log(`  日志：${logPath}`);
      console.log(`  提示：若需开机自启，请由管理员以 root 权限写入 /etc/systemd/system/：`);
      console.log(`        sudo tee ${sysUnitPath} << 'EOF'`);
      console.log(renderSystemdUnit({ role, node, appBin, configDir, isSystem: true, user: curUser, home: curHome }));
      console.log(`EOF`);
      console.log(`        sudo systemctl daemon-reload && sudo systemctl enable --now ${unit}`);
      return 0;
    } catch (e) {
      console.error(`  ✗ 后台拉起守护进程失败：${e.message}`);
      return 1;
    }
  }

  console.log(`暂不支持在 ${process.platform} 上自动注册自启；请用任务计划程序手动安排：`);
  console.log(`  ${process.execPath} ${appBin} daemon --config ${configDir} --role ${role}`);
  return 1;
}
