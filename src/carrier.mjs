// carrier —— 特殊语境的代跑进程与客户端（设计 §9）。
//
// 为什么需要它：macOS 的本地网络隐私按「进程所属语境」授权。launchd 拉起的
// 守护进程树访问局域网会被系统拦截（No route to host），且裸 CLI 在隐私设置
// 里没有可授权的条目。同一个命令从用户自己的终端会话里跑则完全正常。
// carrier 就是常驻在用户终端里的同用户进程：守护进程经本地 unix socket
// 把命令发给它代跑，执行语义（shell、stdin、超时、输出捕获）与直跑一致。
//
// 铁律（§9）：carrier 只能由用户在终端里手动启动（hub-node host），
// 守护进程只连接、从不拉起它——被守护进程拉起的进程会回到受限语境，
// 那正是要避开的。carrier 不在线时对应能力标离线，绝不静默改走直跑。
//
// 协议：unix socket 上的 NDJSON，一行一个请求/响应。
//   请求 {"type":"ping"}
//   响应 {"type":"pong","pid":123}
//   请求 {"type":"exec","id":"...","command":"...","cwd":"...","input":"...","timeout_sec":600}
//   响应 {"id":"...","code":0,"signal":null,"stdout":"...","stderr":"..."}

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function carrierSocketPath(configDir, rawNodeJson) {
  const v = rawNodeJson?.carrierSocket;
  if (typeof v === "string" && v) return v.replace(/^~/, os.homedir());
  return path.join(configDir, "carrier.sock");
}

function readNodeJson(configDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
  } catch {
    return null;
  }
}

// 向 carrier 发一帧并等一帧响应。连不上/超时都返回 null（供探活使用）。
function carrierRoundTrip(socketPath, frame, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已断开 */ }
      resolve(v);
    };
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    let buf = "";
    sock.on("error", () => { clearTimeout(timer); finish(null); });
    sock.on("connect", () => sock.write(JSON.stringify(frame) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish(null); }
    });
    sock.on("close", () => { clearTimeout(timer); finish(null); });
  });
}

export async function pingCarrier(socketPath, timeoutMs = 800) {
  const r = await carrierRoundTrip(socketPath, { type: "ping" }, timeoutMs);
  return r?.type === "pong";
}

// 经 carrier 执行命令，返回形状与内核 runShell 一致：{code, signal, stdout, stderr}。
export async function execViaCarrier(socketPath, { command, cwd, input, timeoutSec }) {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const r = await carrierRoundTrip(
    socketPath,
    { type: "exec", id, command, cwd: cwd ?? "", input: input ?? null, timeout_sec: timeoutSec },
    (timeoutSec + 15) * 1000,
  );
  if (!r) throw new Error("carrier 无响应（不在线或执行超时）");
  if (r.id !== id) throw new Error("carrier 响应 id 不匹配");
  if (r.error) throw new Error("carrier 执行错误：" + r.error);
  return { code: r.code, signal: r.signal ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// 与内核 runShell 语义一致的本地执行（shell、PATH 前缀、超时、双流捕获）。
function runLocal(command, stdinText, timeoutSec, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const extra = ["/opt/homebrew/bin", path.join(os.homedir(), ".local/bin"), "/usr/local/bin"];
    env.PATH = [...extra, env.PATH ?? "/usr/bin:/bin"].join(":");
    const p = spawn(command, {
      shell: true, cwd: cwd || os.homedir(), env,
      timeout: timeoutSec * 1000,
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code, signal) => resolve({ code, signal, stdout: out, stderr: err }));
    if (stdinText != null) p.stdin.write(stdinText);
    p.stdin.end();
  });
}

// hub-node host：carrier 进程本体。在用户终端里前台常驻。
export async function startCarrier(configDir) {
  const raw = readNodeJson(configDir);
  const node = String(raw?.node || "default");
  const socketPath = carrierSocketPath(configDir, raw);

  if (fs.existsSync(socketPath)) {
    if (await pingCarrier(socketPath)) {
      console.log(`carrier 已在运行（socket：${socketPath}），本进程退出。`);
      return 1;
    }
    fs.unlinkSync(socketPath); // 陈旧 socket 文件，清理后重建
  }

  // 执行串行化：一台节点同时只代跑一条命令，与守护进程的串行执行对齐。
  let chain = Promise.resolve();
  const enqueue = (fn) => (chain = chain.then(fn, fn));

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === "ping") {
          sock.write(JSON.stringify({ type: "pong", pid: process.pid }) + "\n");
        } else if (frame.type === "exec") {
          enqueue(async () => {
            const t0 = new Date().toISOString().slice(11, 19);
            console.log(`[${t0}] exec: ${String(frame.command).slice(0, 100)}`);
            try {
              const r = await runLocal(
                String(frame.command),
                frame.input ?? null,
                Number(frame.timeout_sec || 600),
                frame.cwd || undefined,
              );
              console.log(`[${t0}] done: code=${r.code}`);
              sock.write(JSON.stringify({ id: frame.id, ...r }) + "\n");
            } catch (e) {
              sock.write(JSON.stringify({ id: frame.id, error: String(e?.message ?? e) }) + "\n");
            }
          });
        }
      }
    });
    sock.on("error", () => { /* 客户端断开，忽略 */ });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try { fs.chmodSync(socketPath, 0o600); } catch { /* 权限设置失败不阻塞 */ }

  console.log(`hub-node carrier 已启动（节点 ${node}，pid ${process.pid}）`);
  console.log(`  socket：${socketPath}`);
  console.log("  本终端保持开启即可；Ctrl-C 退出。守护进程只连接这里、不会自己拉起 carrier。");

  const shutdown = () => {
    server.close();
    try { fs.unlinkSync(socketPath); } catch { /* 已清理 */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return await new Promise(() => { /* 常驻 */ });
}
