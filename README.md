# 小剧场网页走词台（Theater Teleprompter）

为小剧场演出现场设计的网页走词台：**编辑器**录入有序字幕并发布固化的演出版本；**操作员**在限时独占控制权下开始演出、推进 / 回退 / 清屏；**观众屏**实时显示当前字幕。

- **零外部服务**：Node.js + SQLite（better-sqlite3）+ WebSocket（ws），无需 Redis、消息队列或数据库服务器
- **版本固化**：发布即不可修改；发布后的再编辑只进入草稿，演出中的场次永远锁定开演时的版本
- **限时独占控制权**：同一场次同时仅一人持控；持控需心跳续期，过期后任何人可接管
- **乐观并发控制**：每次操作都必须携带页面所见的 `stateVersion`（baseVersion）；重复提交、旧版本、失效控制权一律拒绝，并向操作员提示具体原因
- **实时与恢复**：浏览器断线自动重连；服务重启后从 SQLite 恢复最新已确认状态
- **一键启动**：提供多阶段 Dockerfile 与 Docker Compose（含数据卷与健康检查）

---

## 一、快速开始（Docker Compose，推荐）

前置条件：已安装 Docker 与 Docker Compose 插件。

```bash
# 在项目根目录
docker compose up -d --build
```

启动后访问（默认端口 **8080**）：

| 页面 | 地址 | 说明 |
| --- | --- | --- |
| 首页 | http://localhost:8080/ | 三个角色入口 |
| 编辑器 | http://localhost:8080/editor.html | 录入字幕、发布版本、创建场次 |
| 操作员台 | http://localhost:8080/operator.html | 取控、开演、推进/回退/清屏 |
| 观众屏 | http://localhost:8080/audience.html | 全屏看词，默认跟随**最新场次** |

观众屏指定场次：`http://localhost:8080/audience.html?session=1`
操作员台直达场次：`http://localhost:8080/operator.html?session=1`
编辑器指定剧本：`http://localhost:8080/editor.html?script=1`

停止：

```bash
docker compose down            # 停止并移除容器（数据保留在命名卷中）
docker compose down -v         # 连同数据卷一起删除（清空全部数据）
```

查看日志 / 健康状态：

```bash
docker compose logs -f
curl http://localhost:8080/healthz
```

## 二、不使用 Docker（本地 Node.js 运行）

需要 Node.js >= 20（better-sqlite3 会使用预编译二进制；个别平台无预编译包时需要 python3 / make / g++）。

```bash
npm ci          # 或 npm install
npm start
```

然后访问 http://localhost:8080/ 。SQLite 数据库默认生成在 `./data/teleprompter.db`（首次启动自动建库建表并播种一个空的“默认剧本”）。

## 三、典型使用流程

1. 打开 **编辑器** → 在字幕草稿中按序号录入台词（序号须为正整数、同一版本内不可重复、文本不能为空）→ 草稿自动保存。
2. 填写版本备注 → 点击 **发布新版本**。发布内容立即固化，之后对草稿的任何修改都不会影响它。
3. 在编辑器右侧 **创建演出场次** 并选择要使用的已发布版本（开场前可切换；演出开始后版本锁定）。
4. 打开 **操作员台** → 选择场次 → 填写操作员名称 → **取得控制权** → **开始演出**。
5. 演出中使用 **推进 / 回退 / 清屏**；控制权倒计时结束前页面会自动心跳续期。倒计时归零未续期时，其他操作员可点击“取得控制权”接管。
6. 观众打开 **观众屏**，字幕实时跟随；刷新页面、网络抖动重连、甚至服务重启，都会恢复到最新已确认画面。

## 四、配置（环境变量）

所有配置均有默认值，**开箱即用**；Compose 下可复制 `.env.example` 为 `.env` 后调整。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 与 WebSocket 监听端口（容器内固定 8080） |
| `HOST_PORT` | `8080` | **仅 Compose 使用**：宿主机暴露端口，如想改成 9000 就设 `HOST_PORT=9000` |
| `DB_PATH` | `/app/data/teleprompter.db`（容器）/ `./data/teleprompter.db`（本地） | SQLite 数据库文件路径 |
| `CONTROL_TTL_SECONDS` | `60` | 控制权有效期（秒），自取得或上次心跳起算；到期后他人可接管 |
| `SWEEP_INTERVAL_SECONDS` | `1` | 服务端扫描并释放过期控制权的间隔 |
| `IDEMPOTENCY_TTL_SECONDS` | `3600` | 操作幂等记录（opId）保留时长，超时自动清理 |

示例：把宿主机端口改为 9000、控制权有效期改为 30 秒：

```bash
HOST_PORT=9000 CONTROL_TTL_SECONDS=30 docker compose up -d --build
# 访问 http://localhost:9000/
```

数据持久化：Compose 使用命名卷 `teleprompter-data` 挂载到容器 `/app/data`；
本地运行时数据在项目 `data/` 目录。只要保留数据库文件，重启 / 重建容器后全部剧本、版本、场次与演出位置都会恢复。

## 五、并发与一致性规则（如何保证“不被错误操作改变状态”）

- 每个场次维护单调递增的 **`stateVersion`**，每次**生效**的演出操作 +1。
- 操作员页面始终显示当前状态版本（如 `页面状态版本 #3`）；发起 `开始 / 推进 / 回退 / 清屏` 时必须带上该版本号 `baseVersion`。
- 每次操作还要带前端生成的唯一 **`opId`**，服务端在事务内按 `(sessionId, opId)` 去重。
- 服务端按以下顺序裁决（全部在单个 SQLite 事务内完成）：
  1. **重复提交**：同一 `opId` 已处理 → 不改变状态，回放当时的成功/拒绝结论；
  2. 场次已结束 → 拒绝；
  3. **控制权失效或非持控者**（令牌不匹配 / 已过期 / 被接管）→ 拒绝；
  4. **旧版本**（`baseVersion ≠ 当前 stateVersion`）→ 拒绝，并回传当前版本号供页面刷新；
  5. 业务边界（已在最后一条还推进、片头还回退、重复清屏等）→ 拒绝并说明原因；
  6. 全部通过才更新位置 / 清屏标记并令 `stateVersion + 1`，随后通过 WebSocket 广播新快照。
- **发布固化**：场次行保存 `version_id`，新版本只追加；演出中切换版本返回 `VERSION_LOCKED` 拒绝。
- 被拒绝的操作同样记录幂等键（且与状态更新在同一事务提交），因此“先被拒、网络重试”也不会意外二次执行。

WebSocket 端点：`ws://<主机>:<端口>/ws`（浏览器页面已内置，无需手动使用）。
HTTP 只读接口：`GET /healthz`、`GET /api/scripts`、`GET /api/scripts/:id`、`GET /api/sessions/:id`、`GET /api/latest`。

## 六、自动化冒烟测试

仓库附带基于真实 WebSocket 连接的端到端测试（无需测试框架），覆盖：空字幕/重复序号拒绝、独占控制权、过期接管、旧版本拒绝、重复 opId 幂等、推进/回退/清屏边界、观众实时推送与重启恢复。

```bash
# 终端 1：以短 TTL 起一个测试实例
PORT=8099 DB_PATH=/tmp/tp-test.db CONTROL_TTL_SECONDS=4 SWEEP_INTERVAL_SECONDS=1 node src/server.js

# 终端 2：
TEST_PORT=8099 node test/smoke.js
```

预期输出结尾为 `✅ 全部冒烟断言通过`。

## 七、目录结构

```
.
├── Dockerfile              # 多阶段构建：编译 better-sqlite3 -> 精简运行镜像
├── docker-compose.yml      # 一键启动（端口、TTL、数据卷、健康检查）
├── .env.example            # 可选环境变量样例
├── package.json
├── src/
│   ├── server.js           # HTTP + WebSocket 入口、REST、静态页面
│   ├── config.js           # 环境变量配置
│   ├── db.js               # SQLite 初始化、表结构、数据访问
│   ├── state.js            # 条目校验、控制权判定、快照构造
│   ├── store.js            # 业务事务：发布/场次/控制权/演出操作
│   └── realtime.js         # WebSocket 订阅、RPC、广播、过期扫描
├── public/                 # 首页 / 编辑器 / 操作员台 / 观众屏（原生 JS）
└── test/smoke.js           # 端到端冒烟测试
```
