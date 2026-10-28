# Bytebot 接入 Agnx

## 上游嵌入

- 上游：`bytebot-ai/bytebot` @ commit `3d37894ce07ef8d8b40adc7fd309ad96c2a71313`（main，2025-09-11）；**非 npm 包**，整仓 git clone；许可证 **Apache-2.0**
- 上游原生平台：桌面 ✅ | 网页 ✅ | 移动 ❌
  - 依据：`packages/bytebot-ui` 是 Next.js 15 App Router 应用（浏览器形态）；上游没有 Electron / Capacitor / React Native 壳，桌面能力靠「容器化 Ubuntu 桌面 + noVNC 流」在浏览器里提供，不是原生桌面应用。故 `platforms.mobile = "unsupported"`。
- 工作方式：**Wrap + Sidecar**（上游自带 `packages/bytebot-ui` 原样 iframe + 薄胶水面板 + ensure sidecar）
- 上游改动清单：**无**
  - 改动 `git status` 为空（`.next/`、`node_modules/` 均被上游 `.gitignore` 覆盖）
  - 端口通过上游 `server.ts` **既有**环境变量 `PORT` / `HOSTNAME` 注入，未改一行源码
  - 后端地址通过上游既有 `BYTEBOT_AGENT_BASE_URL` / `BYTEBOT_DESKTOP_VNC_URL` 注入

## 上游架构事实（决定了接入形态）

Bytebot 是**四容器**架构（`docker/docker-compose.yml`）：

| 组件 | 端口 | 作用 | 本接入是否拉起 |
| --- | --- | --- | --- |
| `bytebot-desktop` | 9990 | Ubuntu 22.04 + XFCE + noVNC 虚拟桌面（**privileged，2G shm**） | ❌ |
| `postgres` | 5432 | 任务/消息存储 | ❌ |
| `bytebot-agent` | 9991 | NestJS，调度 LLM 与桌面动作 | ❌ |
| `bytebot-ui` | 9992 | Next.js Web UI（用户看到的界面） | ✅ 以 **standalone** 模式 |

**本接入只起第 4 个（UI）**，并按作业单要求优先走自托管 UI 路线，而不是整套 Docker。

## 启动

```
ensureTool = .agnx/tools/ensure-bytebot-ui.mjs
默认端口    = 8103
上游命令    = <packages/bytebot-ui>/node_modules/.bin/tsx server.ts
              （cwd = packages/bytebot-ui，env: NODE_ENV=production PORT=8103 HOSTNAME=127.0.0.1）
```

等价于上游 `npm run start`，只是省掉了每次启动前的 `shared` 重建（shared 已在接入时构建好）。

### 构建前置（一次性）

```bash
cd packages/shared        && npm install && npm run build      # 产出 dist/index.js
cd packages/bytebot-ui    && npm install && npx next build     # 产出 .next/
```

ensure-tool 会检查 `packages/bytebot-ui/.next` 是否存在，缺失时给出可读错误而不是空转超时。

### 两种运行模式（ensure-tool 自动探测，不伪造数据）

| 模式 | 判定 | 表现 |
| --- | --- | --- |
| `full` | 9991 与 9990 都可连 | 可新建任务、看实况桌面 |
| `standalone` | 任一不可连 | **首屏完整渲染**，导航/输入框/任务页/桌面页可进；任务列表空、新建任务报 500、socket.io 连不上 |

`standalone` 是**上游四容器架构的既定依赖**，不是接入缺陷：UI 全部是 client component，后端调用只在用户交互或挂载后的 `fetch` 中发生，因此没有任何后端也能出首屏。ensure-tool 会把该限制写进 `warnings` 字段。

## 挂载

- `guest.kind = "web"`、`guest.auth = "none"`、`preferStrategy = "auto"`
- 能力：`cookies`（上游 API 代理转发 Cookie）、`websocket`（socket.io 任务实时流 + noVNC websockify）
- 面板与 Tab：`bytebot.main`（走 ensureTool），命令 `bytebot.open`，侧栏按钮 order 61
- 数据落盘：`$AGNX_HOME/apps/data/bytebot/`（`bytebot.json` 状态文件 + `logs/ui.out.log`）
  - UI 层本身无状态；真正的任务数据在 `postgres` 里（本接入未拉起）

## 验收证据

| 项 | 结果 |
| --- | --- |
| **正式端口启动**（8103 空出后） | `{"ok":true,"port":8103,"mode":"standalone"}` |
| **`curl -o /dev/null -w '%{http_code}' 127.0.0.1:8103/`** | **200** |
| **首屏 `<title>`（正式端口）** | **Bytebot** |
| 复用路径（服务在跑时再调） | `{"ok":true,"reused":true,...}` |
| 强制重启（`--force-restart`） | 旧 pid 杀死 → 新 pid 起 → `/` 200 |
| 端口守卫（`--port 6767`） | `{"ok":false,"error":"端口 6767 是 Agnx 主守护进程专用端口…"}` exit 1 |
| 兄弟端口守卫（`--port 8104`） | `{"ok":false,"error":"端口 8104 已分配给其他 Agnx 子应用…"}` exit 1 |
| 开发期临时端口自测（8193，8103 尚被 openbot 占用时） | `{"ok":true,"reused":false,"port":8193,"mode":"standalone","pid":7620}`；`/` 200 ×3（3-40 ms）。临时实例**已清理** |
| 首屏 `<title>` | **Bytebot** |
| `/desktop` | 200，渲染 `Live Desktop View` |
| `/tasks` | 200，渲染任务列表骨架（`All / Active / Completed / Cancelled-Failed`） |
| 无头浏览器（Chrome channel，1280×800） | 首屏完整渲染：导航 Home/Tasks/Desktop/Docs、任务输入框、Latest Tasks 空态、配图；**pageerror = 0** |
| console error | 14 条，全部来自后端缺失（`/api/tasks?limit=5` 500、`/api/tasks/models` 非 JSON、`ws://…/api/proxy/tasks` 握手失败）——standalone 模式的预期噪声 |
| `node .agnx/scripts/build.mjs` | 产出 `.agnx/dist/index.js`（5.1 KB），含 `bytebot.main` / `bytebot.open` |
| `python3 -m json.tool` × manifest / config / package | 全部通过 |

## ✅ 端口冲突：8103 曾被 openbot 占用（已解决）

接入过程中 `8103` 一度被 **openbot 的内部后端**占着（不是本应用的进程）：

- `lsof -iTCP:8103` → pid 76600 = `bun --env-file=../.env src/index.ts`，cwd = `~/.agnx-dev/apps/openbot/server`
- openbot 的 `.agnx/tools/ensure-openbot.mjs:15` 注释原文：「server 内部端口取 APP_PORT+2（8103）避开同批子应用 8100–8104 的占用」——它把 8103 当成空闲内部端口，但 8103 已分配给 bytebot
- openbot 对外端口是 8101（`/` 200，`<title>OpenBot</title>`），8103 只是它的 Hono 回环后端（`/` 返回 404）

处置（已落地）：

1. Bytebot 侧**未杀他人进程**。ensure-tool 检测到「端口被非 Bytebot 服务占用」时明确报错（`端口 8103 已被其他进程占用且不是 Bytebot UI`），既不误杀也不假装成功。
2. 冲突根因定位在 openbot 的 `pickServerPort(externalPort) { return externalPort + 2; }`（`ensure-openbot.mjs:351`），已由上层裁决改成固定 **8199** 并 `--force-restart` 验证（8101 对外 200 / 内部 8199）。
3. 8103 空出后，Bytebot 的 ensure-tool **零改动**接管，实测 `/` 200、`<title>Bytebot</title>`。


## 已知限制

1. **无后端（standalone）——当前实际运行态**：ensure-tool 返回的 `warnings` 已明示：
   > `Bytebot Agent(http://127.0.0.1:9991) 或 Desktop(9990) 未运行：UI 首屏可渲染，但任务列表为空、无法新建任务。属上游「四容器架构」既定依赖，非接入缺陷。`

   具体表现：首屏、`/desktop`、`/tasks` 三个路由都可进入并完整渲染（pageerror = 0），但 `/api/tasks?limit=5` 返回 500、`/api/tasks/models` 非 JSON、`ws://…/api/proxy/tasks` 握手失败，因此任务列表恒为 `No tasks available`、`Select a model` 无选项、提交任务失败。这是**上游四容器架构的既定依赖**，不是接入缺陷——上游 UI 全部是 client component，后端调用只发生在挂载后 `fetch` 与用户交互时，所以没有后端也能出完整首屏。要完整体验需自行 `docker compose -f docker/docker-compose.yml up -d`（需 `privileged` + 2G shm，约数 GB 镜像）；本接入不代跑 Docker，避免在 Agnx 退出后留下容器与 privileged 桌面。
2. **ghcr 镜像可用**：已实测 `docker manifest inspect ghcr.io/bytebot-ai/bytebot-ui:edge` 成功（amd64 + arm64 双架构），本机 Docker 29.2.1 可用——即「整仓 Docker」路线技术上可走，只是与「子应用按需启停」的形态冲突（容器起停慢、占资源、需提权）。
3. **模型凭证**：上游要 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`（agent 容器）。未注入，属用户账号范畴。
4. **构建产物体积**：`packages/bytebot-ui/node_modules` ≈ 664 MB（上游依赖较全）。上游升级后需重跑 `next build`。
5. **移动端**：`platforms.mobile = "unsupported"`。上游没有移动壳，且虚拟桌面 noVNC 在移动 WebView 里体验不可用，按「能力上限」原则不做。
6. **`npm install` 警告**：本机 npm 对 `sharp` / `esbuild` / `prisma` 的 postinstall 脚本默认拦截（`allow-scripts`）。实测 `next build` 与 `tsx server.ts` 均正常，未受影响。

## 嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 | 主路径 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 虚拟桌面实况（noVNC / websockify） | `/desktop` 页 `react-vnc` → `/api/proxy/websockify` | 需 WebSocket；iframe 沙箱若剥离 upgrade 头则画面黑屏 | manifest 声明 `websocket`；直接 iframe 直连上游端口 8103，不经 Agnx 代理 | direct-iframe | 桌面容器未起时该页空转，不崩 |
| 任务实时流（socket.io） | `/api/proxy/tasks` → `ws://…/socket.io` | 同上 | 同上 | direct-iframe | standalone 下握手失败，属预期 |
| 文件上传（拖入 PDF / 附件按钮） | 首屏输入框回形针 | 跨域 iframe 下 `<input type=file>` 可用；但提交需后端 | 未特殊处理 | iframe | 无后端时提交失败 |
| Cookie 透传（`credentials: "include"`） | `src/utils/taskUtils.ts` `API_CONFIG` | 同源直连下无问题；若宿主改成代理模式需补 cookie | `guest.auth = "none"`，能力含 `cookies` | direct-iframe | — |
| Docker 化桌面（privileged 容器、系统通知） | `docker/docker-compose.yml` | 与「按需启停子应用」冲突，且需提权 | 不拉起；由用户自行 Docker | — | 上游原生能力上限即容器形态 |
| 移动端 | 无（无 Capacitor / RN 工程） | — | `platforms.mobile = "unsupported"` | — | 上游原生能力上限 |
