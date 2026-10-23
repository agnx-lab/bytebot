#!/usr/bin/env node
/**
 * 场景：短跑 sidecar — 确保 Bytebot 的 Next.js Web UI 在指定端口起好；未健康则后台起、轮询到健康。
 * 用法：node .agnx/tools/ensure-bytebot-ui.mjs [--port <n>] [--work-dir <dataRoot>] [--force-restart] [--supervised]
 * stdout：末行单行 JSON { ok, port, origin, reused, pid, mode, warnings? }
 *
 * 启动方式：上游自带 `packages/bytebot-ui/server.ts`（Express + Next 自定义 server）。
 *   该 server 原生读 `PORT` / `HOSTNAME` 环境变量 → 改端口**不需要任何上游改动**。
 *   `--no-open` 类副作用不存在；不发任何对外请求。
 *
 * 模式（由后端可达性自动判定，只影响提示文案，不伪造数据）：
 *   - full     : 探测到 Bytebot Agent（9991）与 Bytebot Desktop（9990），UI 可创建任务 / 看实况桌面
 *   - standalone: 只起 UI。首屏可渲染，但任务列表与「新建任务」需要 Agent，会失败
 *
 * 端口纪律：Agnx 主守护进程 6767 硬拒绝；与其他已分配子应用端口冲突时拒绝并给出可读原因。
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "../..");
const DEFAULT_PORT = 8103;
/** Agnx 主守护进程端口，永不占用。 */
const FORBIDDEN_PORTS = new Set([6767]);
/** 兄弟子应用已分配端口（8100-8112 中除本应用外的全部）。 */
const SIBLING_PORTS = new Set([8100, 8101, 8102, 8104, 8105, 8106, 8107, 8108, 8109, 8110, 8111, 8112]);

const UI_DIR = path.join(appRoot, "packages", "bytebot-ui");
const AGENT_BASE_URL = process.env.BYTEBOT_AGENT_BASE_URL || "http://127.0.0.1:9991";
const DESKTOP_VNC_URL = process.env.BYTEBOT_DESKTOP_VNC_URL || "http://127.0.0.1:9990/websockify";

function trace(phase, fields) {
  process.stderr.write(`[ensure-bytebot] ${JSON.stringify({ phase, ...fields })}\n`);
}

function parseArgs(argv) {
  let workDir = process.env.AGNX_APP_DATA_ROOT || path.join(appRoot, ".agnx-runtime");
  let port = DEFAULT_PORT;
  let forceRestart = false;
  let supervised = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--work-dir" || arg === "--workDir") && next) {
      workDir = String(next).trim();
      i += 1;
    } else if (arg === "--port" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) {
        port = Math.floor(n);
      }
      i += 1;
    } else if (arg === "--force-restart" || arg === "--forceRestart") {
      forceRestart = true;
    } else if (arg === "--supervised") {
      supervised = true;
    }
  }
  return { workDir, port, forceRestart, supervised };
}

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}

function httpStatus(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
  });
}

/**
 * 健康判定：`/` 返回 200 且 HTML 含 Bytebot 特征串。
 * 只认「该端口上真的是 Bytebot UI」——避免误复用占用 8103 的别家服务。
 */
function isHealthy(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 3000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 200_000) {
            res.destroy();
          }
        });
        res.on("end", () => resolve(/bytebot/i.test(body)));
        res.on("error", () => resolve(false));
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 端口是否被任意进程占用（含非 HTTP）。 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1200);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function stopPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) {
    return;
  }
  try {
    process.kill(n, "SIGTERM");
  } catch {
    // 进程已退出
  }
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

/** 后端可达性 → 决定 full / standalone 模式。 */
async function probeBackends() {
  const agent = await httpStatus(`${AGENT_BASE_URL}/tasks`, 1500);
  const desktop = await httpStatus(DESKTOP_VNC_URL.replace(/\/websockify$/, "") || "http://127.0.0.1:9990", 1500);
  return {
    agentReachable: agent >= 200 && agent < 500,
    desktopReachable: desktop > 0,
    agentStatus: agent,
    desktopStatus: desktop,
  };
}

/**
 * 后台起服务：stdout/stderr 直接重定向到日志文件（不用 pipe）。
 * 坑：用 pipe 收子进程输出时，Next 自定义 server 在宿主退出后不再响应请求
 * （首个 curl 后挂死）；实测只有 fd 重定向稳定。
 */
function spawnDetached(command, args, { cwd, env, logFile }) {
  const out = openSync(logFile, "a");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.unref();
  return {
    child,
    readLog: () => {
      try {
        return readFileSync(logFile, "utf8").slice(-12000);
      } catch {
        return "";
      }
    },
  };
}

async function waitForHealth(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  if (FORBIDDEN_PORTS.has(cfg.port)) {
    fail(`端口 ${cfg.port} 是 Agnx 主守护进程专用端口，Bytebot 一律改走 ${DEFAULT_PORT}。`);
    return;
  }
  if (SIBLING_PORTS.has(cfg.port)) {
    fail(`端口 ${cfg.port} 已分配给其他 Agnx 子应用，Bytebot 固定使用 ${DEFAULT_PORT}。`);
    return;
  }

  if (!existsSync(path.join(UI_DIR, "server.ts"))) {
    fail(`未找到上游 Bytebot UI：${UI_DIR}/server.ts 不存在。请确认已整仓克隆 bytebot-ai/bytebot。`);
    return;
  }
  const nextBuildDir = path.join(UI_DIR, ".next");
  if (!existsSync(nextBuildDir)) {
    fail(
      `未找到 Next 构建产物 ${nextBuildDir}。请先在 packages/bytebot-ui 执行 npx next build（前置：packages/shared 已 npm run build + npm install）。`,
    );
    return;
  }

  await mkdir(cfg.workDir, { recursive: true });
  const statePath = path.join(cfg.workDir, "bytebot.json");
  const logFile = path.join(cfg.workDir, "logs", "ui.out.log");
  await mkdir(path.dirname(logFile), { recursive: true });

  const origin = `http://127.0.0.1:${cfg.port}`;
  const fingerprint = JSON.stringify({ port: cfg.port, uiDir: UI_DIR, agent: AGENT_BASE_URL });
  const existing = await readState(statePath);
  const backends = await probeBackends();
  const mode = backends.agentReachable && backends.desktopReachable ? "full" : "standalone";
  const warnings = [];
  if (mode === "standalone") {
    warnings.push(
      `Bytebot Agent(${AGENT_BASE_URL}) 或 Desktop(9990) 未运行：UI 首屏可渲染，但任务列表为空、无法新建任务。属上游「四容器架构」既定依赖，非接入缺陷。`,
    );
  }

  trace("start", { port: cfg.port, forceRestart: cfg.forceRestart, mode, ...backends });

  // 端口已经健康且确实是 Bytebot → 复用（除非强制重启）
  if (!cfg.forceRestart && (await isHealthy(cfg.port))) {
    const samePidAlive = existing?.pid ? isPidAlive(existing.pid) : false;
    trace("reuse", { port: cfg.port, pid: existing?.pid ?? null, samePidAlive });
    console.log(
      JSON.stringify({
        ok: true,
        reused: true,
        port: cfg.port,
        origin,
        pid: samePidAlive ? existing.pid : null,
        mode,
        warnings,
      }),
    );
    return;
  }

  // 端口被别的东西占着（且不是 Bytebot）→ 明确报错，绝不误杀他人进程
  if (!cfg.forceRestart && (await isPortBusy(cfg.port))) {
    fail(
      `端口 ${cfg.port} 已被其他进程占用且不是 Bytebot UI。请先释放该端口（lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN）。`,
    );
    return;
  }

  // 状态文件里有旧进程 → 杀掉，避免抢占端口
  if (existing?.pid && isPidAlive(existing.pid)) {
    trace("stop-stale", { pid: existing.pid });
    stopPid(existing.pid);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && isPidAlive(existing.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(cfg.port),
    HOSTNAME: "127.0.0.1",
    BYTEBOT_AGENT_BASE_URL: AGENT_BASE_URL,
    BYTEBOT_DESKTOP_VNC_URL: DESKTOP_VNC_URL,
  };
  // 上游 `npm run start` = (重建 shared) + `tsx server.ts`；shared 已构建好，这里直接跑 server.ts。
  const args = ["server.ts"];

  if (cfg.supervised) {
    // 主管家模式：只交计划，由宿主拉起
    console.log(
      JSON.stringify({
        ok: true,
        reused: false,
        plan: {
          command: path.join(UI_DIR, "node_modules", ".bin", "tsx"),
          args,
          cwd: UI_DIR,
          env,
          fingerprint,
          healthUrl: `${origin}/`,
          port: cfg.port,
          mode,
          launchMode: "dev",
          iframeOriginStderrPrefix: "ensure-bytebot: ",
        },
      }),
    );
    return;
  }

  const tsxBin = path.join(UI_DIR, "node_modules", ".bin", "tsx");
  if (!existsSync(tsxBin)) {
    fail(`未找到 tsx：${tsxBin}。请先在 packages/bytebot-ui 执行 npm install。`);
    return;
  }

  trace("spawn", { bin: tsxBin, args: args.join(" "), cwd: UI_DIR });
  const { child, readLog } = spawnDetached(tsxBin, args, { cwd: UI_DIR, env, logFile });

  const ready = await waitForHealth(cfg.port, 180_000);
  if (!ready) {
    const tail = readLog().trim();
    stopPid(child.pid);
    fail(
      `Bytebot UI 启动超时（端口 ${cfg.port}）。${
        tail ? `最近输出：${tail.slice(-600)}` : "无输出，请检查 packages/bytebot-ui/.next 构建是否完整。"
      }`,
    );
    return;
  }

  await writeFile(
    statePath,
    JSON.stringify(
      {
        fingerprint,
        port: cfg.port,
        pid: child.pid ?? null,
        origin,
        mode,
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    JSON.stringify({
      ok: true,
      reused: false,
      port: cfg.port,
      origin,
      pid: child.pid ?? null,
      mode,
      warnings,
    }),
  );
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  })
  .finally(() => {
    // 服务已 detached 在后台；本进程只负责报告结果，立即退出防止残留句柄拖住宿主。
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
