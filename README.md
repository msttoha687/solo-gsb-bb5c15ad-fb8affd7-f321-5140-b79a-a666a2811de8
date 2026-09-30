# 网页走词台（Stage Prompter）

为小剧场设计的**网页走词/提词系统**：编辑者录入有序字幕并发布不可变的演出版本；操作员
取得**有时限的控台权**后推进、回退、清屏；观众页通过浏览器实时连接看到当前字幕。

- **纯单机、零外部服务**：Node.js + SQLite（better-sqlite3）+ 原生 WebSocket（`ws`），
  无 Redis、无消息队列、无 CDN 依赖。
- **版本安全**：发布后的版本永久固化；发布之后的修改只进入草稿，演出中字幕保持原版本，
  演出过程中无法切换版本。
- **乐观并发 + 幂等**：每次操作必须基于「页面所见」的状态版本号（revision）；重复提交、
  旧版本提交、失效/被接管的控制权一律拒绝并返回明确原因。
- **断线/重启恢复**：全部现场状态持久化在 SQLite；观众页断线自动重连，服务重启后恢复到
  最新一条已确认状态。

---

## 一、快速启动（Docker Compose 一键）

需要 Docker 20.10+（含 Compose v2）。

```bash
# 1.（可选）按需调整配置
cp .env.example .env
#   编辑 .env：HOST_PORT / CONTROL_TTL_MS / EDITOR_TOKEN

# 2. 构建并后台启动（首次会自动 npm install 并初始化数据库表）
docker compose up -d --build

# 3. 查看状态
docker compose ps
docker compose logs -f
```

停止 / 升级：

```bash
docker compose down            # 停止（数据保留在 Docker 卷 prompter-data 中）
docker compose up -d --build   # 改完代码后重新构建启动
```

数据保存在命名卷 `prompter-data`（容器内 `/data/prompter.db`）。
如需改用宿主机目录，把 `docker-compose.yml` 中的卷改为：

```yaml
    volumes:
      - ./data:/data
```

---

## 二、访问地址与端口

默认端口 **8080**（可用 `.env` 中的 `HOST_PORT` 修改宿主机映射端口）：

| 角色 | 地址 | 说明 |
| --- | --- | --- |
| 首页 / 场次列表 | <http://localhost:8080/> | 创建场次、进入各工作台 |
| 编辑台 | `http://localhost:8080/editor.html?show=<场次ID>` | 录入字幕、保存草稿、发布版本 |
| 操作员台 | `http://localhost:8080/operator.html?show=<场次ID>` | 取得控制权、开演/推进/回退/清屏/结束 |
| 观众投屏 | `http://localhost:8080/audience.html?show=<场次ID>` | 大字投屏，只读，自动重连 |

典型现场布局：舞台监督/提词员在笔记本上开「操作员台」，给演员看的屏幕（或投影）开
「观众投屏」全屏；编辑可在另一台机器上准备下一场的草稿。

---

## 三、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT`（仅 compose） | `8080` | 宿主机映射端口；容器内服务固定监听 `8080` |
| `PORT`（仅裸机运行） | `8080` | HTTP / WebSocket 监听端口 |
| `DB_PATH` | `/data/prompter.db` | SQLite 数据库文件路径，首次启动自动建库建表 |
| `CONTROL_TTL_MS` | `30000` | 控台权有效时长（毫秒）。到期自动失效，任何人可接管；持有者可点「续期」 |
| `EDITOR_TOKEN` | （空） | 编辑令牌。**留空 = 内网信任模式**；设置后创建场次/保存草稿/发布需在页面填入令牌（Bearer） |

> 控台权不需要预置令牌：操作员在页面填写自己的名字即可取得，服务器颁发随机令牌存于
> 浏览器会话中；观众与编辑无法操控现场。

`.env` 示例：

```env
HOST_PORT=8080
CONTROL_TTL_MS=30000
EDITOR_TOKEN=change-me-on-shared-network
```

---

## 四、使用流程

1. **编辑者**：首页创建场次 → 编辑台按每行 `序号|字幕内容` 录入（空行忽略）→
   「保存草稿」→「发布为演出版本」。可多次发布，产生 v1、v2… 历史版本。
   - 校验：空字幕、重复序号、非正整数序号都会被拒绝并指出位置。
   - 草稿随时可改；演出期间也可以改草稿、发布新版本，但**不会影响正在演出的版本**。
2. **操作员**：打开操作员台 → 填名字 →「取得控制权」→ 选择演出版本 →「开始演出」。
   - 同一时间全场只有一人持有控制权；别人会看到持有者姓名与过期时间。
   - 控制权到期后，任何人点「取得控制权」即完成接管；原持有者的操作随即失效。
   - 操作：**推进 / 回退 / 清屏 / 结束演出**（快捷键：空格或 → 推进、← 回退、C 清屏）。
   - 页面顶部显示当前所见的状态版本 `rN`。
3. **观众**：打开观众投屏页即可。字幕变化实时推送；网络中断自动指数退避重连；
   服务重启后首帧即恢复最新已确认字幕（另有 HTTP 轮询兜底）。

### 拒绝规则（每次操作都会校验，并在页面提示原因）

| 场景 | 返回错误码 | 含义 |
| --- | --- | --- |
| 重复提交（同一 `opId`） | `DUPLICATE_OP` | 该操作已生效，忽略重复请求，状态不变 |
| 页面状态过期 | `STALE_REVISION` | `expectedRevision` 与服务器不一致，响应附带当前状态 |
| 无控制权 / 令牌错误 | `NO_CONTROL` / `CONTROL_HELD_BY_OTHER` | 无权操作，指出当前持有者 |
| 控制权过期 | `CONTROL_EXPIRED` | 需重新取得或接管 |
| 演出中再次开始（切版本） | `ALREADY_LIVE` | 演出中不允许切换演出版本 |
| 未发布即开演 | `NO_PUBLISHED_VERSION` | 必须先发布至少一个版本 |
| 空字幕 / 重复序号 | `EMPTY_TEXT` / `DUPLICATE_SEQ` | 草稿保存与发布时拒绝 |

---

## 五、不使用 Docker 的裸机运行

需要 Node.js ≥ 20（better-sqlite3 使用预编译二进制，通常无需编译工具链）。

```bash
npm install
PORT=8080 DB_PATH=./data/prompter.db CONTROL_TTL_MS=30000 npm start
# 然后访问 http://localhost:8080/
```

---

## 六、HTTP / WebSocket 接口摘要

- `GET  /api/health` 健康检查
- `GET  /api/shows` / `POST /api/shows`（POST 需编辑令牌）
- `GET  /api/shows/:id` 场次详情（草稿、版本列表、现场状态）
- `PUT  /api/shows/:id/draft` 整表保存草稿（需编辑令牌）
- `POST /api/shows/:id/publish` 草稿固化为新演出版本（需编辑令牌）
- `POST /api/shows/:id/control/acquire|renew|release` 控台权取得 / 续期 / 释放
- `POST /api/shows/:id/ops` 现场操作，请求体：
  ```json
  { "action": "advance", "token": "<控台令牌>",
    "opId": "<客户端生成的唯一ID>", "expectedRevision": 12 }
  ```
  `action` ∈ `start | stop | advance | retreat | clear`；`start` 可带 `versionId`。
- `GET  /ws?showId=<id>[&controlToken=<令牌>]` WebSocket：
  入房首帧推送当前 `state`，之后现场每次确认操作或控制权变化都会广播。

---

## 七、设计要点（为什么这样实现）

- **不可变版本**：每次发布把草稿整体复制为新的 `versions + entries` 行；现场状态只保存
  `active_ver_id`，从发布那一刻起内容就不再可能被任何编辑改动。
- **乐观版本号 revision**：现场状态每次确认操作 +1。服务端在同一个 SQLite 事务内
  比对 `expectedRevision` 与当前 revision，不一致即回滚，杜绝两人/多标签页互相覆盖。
- **幂等 opId**：客户端为每次操作生成唯一 ID（UUID），服务端 `op_log` 唯一约束去重，
  网络重试、双击按钮、重连重放都不会让字幕跳两次。该记录在服务重启后仍然有效。
- **控台权**：`controls` 表每场一行（UPSERT），令牌为 24 字节随机；过期由惰性校验 +
  每秒巡检共同保证，过期后他人的 acquire 直接覆盖（接管）并广播。
- **恢复**：SQLite WAL 模式持久化全部状态；WebSocket 连上即推送当前状态，因此观众页
  刷新、断线重连、服务重启看到的都是同一条「最新已确认」字幕。

## 目录结构

```
.
├── Dockerfile              # 含依赖安装与数据库自动初始化
├── docker-compose.yml      # 一键启动 + 数据卷 + 健康检查
├── .env.example            # 配置样例
├── package.json
├── src/
│   ├── server.js           # HTTP API + WebSocket + 事务/并发控制
│   └── db.js               # SQLite 连接与建表脚本
└── public/
    ├── index.html          # 场次列表 / 创建
    ├── editor.html         # 编辑台（草稿 + 发布）
    ├── operator.html       # 操作员台（控制权 + 现场操作）
    ├── audience.html       # 观众投屏
    ├── client.js           # 公共库：API / 自动重连 / 提示
    └── style.css
```
