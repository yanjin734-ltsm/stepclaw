# StepClaw 多账号资源池方案（VM + Sticky Session + 自动切换）

## 背景与目标

现状：本项目将本机单个 StepClaw 桌面端账号暴露的 OpenAI 兼容接口（默认 `127.0.0.1:3199/v1`）反向代理到 `127.0.0.1:8080/v1` 给 OpenCode 使用。由于正常情况下只能同时运行一个 StepClaw 实例，导致只能使用单账号配额。

目标：在不改变 OpenCode 侧统一入口的前提下，让多个 StepClaw 账号轮流/分担提供资源：
- OpenCode 始终只使用同一个入口：`http://127.0.0.1:8080/v1`
- 同一个对话/会话需要粘到同一个账号（sticky session）
- 当该账号额度用完或被限流/异常时，允许迁移到其他账号继续提供服务
- 采用多虚拟机路线（每个账号一台 VM）避免多实例冲突

约束（已确定）：
- sticky key 使用 OpenCode 请求中的 `Authorization: Bearer <apiKey>`（即把 apiKey 当会话标识使用）
- 额度用完的判定无法依赖官方接口，只能用“靠谱的启发式错误分类”来驱动切换
- 同一台 OpenCode 里不同项目不需要用不同账号

## 非目标（本阶段不做）

- 不尝试在同一 Windows 会话中运行多个 StepClaw 实例（端口/单实例锁风险高）
- 不实现跨账号“无缝续写流式响应”（SSE 一旦开始输出就不应换 upstream）
- 不做分布式部署（仅本机 `127.0.0.1` 使用）

---

## 总体架构

```
OpenCode
  |
  |  OpenAI compatible
  v
本地统一代理 (Host) 127.0.0.1:8080/v1
  |
  |  OpenAI compatible, with routing/scheduler
  +--> Upstream A: 127.0.0.1:3199/v1  -> VM#1 StepClaw (Account A) :3199
  +--> Upstream B: 127.0.0.1:3200/v1  -> VM#2 StepClaw (Account B) :3199
  +--> Upstream C: 127.0.0.1:3201/v1  -> VM#3 StepClaw (Account C) :3199
```

关键点：
- VM 内部 StepClaw 仍监听 `127.0.0.1:3199`
- 宿主机通过端口映射把各 VM 的 3199 映射为不同本机端口（3199/3200/3201...）
- 本地统一代理维护一个 upstream 列表，并对每个 session 做粘性绑定与迁移

---

## VM 资源池搭建（每账号一台 VM）

### 1. VM 准备清单
对每个 StepClaw 账号：
1. 新建 Windows VM（Hyper-V / VMware / VirtualBox 任意；优先 Hyper-V 稳定性）
2. VM 内安装 StepClaw / StepFun Desktop
3. 登录对应账号并确保能正常对话（确认有可用额度）
4. 验证 VM 内本地 API 可用：
   - `POST http://127.0.0.1:3199/v1/chat/completions`
   - Header：`Authorization: Bearer stepfun-model-proxy`
   - 能返回 200 且内容为 OpenAI 兼容格式

### 2. 宿主机端口映射策略
目标：让宿主机看到 N 个不同端口的上游：
- VM#1 映射到宿主：`127.0.0.1:3199 -> VM#1:127.0.0.1:3199`
- VM#2 映射到宿主：`127.0.0.1:3200 -> VM#2:127.0.0.1:3199`
- VM#3 映射到宿主：`127.0.0.1:3201 -> VM#3:127.0.0.1:3199`

实现方式随虚拟化平台而定（NAT/端口转发）。原则：
- 只绑定到宿主机回环 `127.0.0.1`，不暴露到局域网
- 每个 VM 固定一个端口，便于监控与故障定位

---

## 代理侧调度设计

### 1. 会话标识（Sticky Key）
- 从请求头取 `Authorization`，解析 `Bearer <token>`
- 将 `<token>` 视为 `sessionKey`
- sessionKey 的语义：一组对话的“粘性路由钥匙”
  - 同一个 sessionKey 的所有请求默认落到同一个 upstream
  - 若该 upstream 被判定为不可用/额度耗尽，则迁移绑定到其他 upstream

注意：
- 这意味着 sticky 粒度是“apiKey 级别”。同一台 OpenCode 配置内所有对话共享同一 apiKey，因此会共享同一账号绑定（这是预期行为）。

### 2. Upstream 列表配置
当前项目通过环境变量只支持单 upstream。为支持多 upstream，新增配置文件 `config/upstreams.json`。

示例：
```json
{
  "upstreams": [
    { "name": "vm-a", "baseUrl": "http://127.0.0.1:3199/v1", "apiKey": "stepfun-model-proxy", "weight": 1 },
    { "name": "vm-b", "baseUrl": "http://127.0.0.1:3200/v1", "apiKey": "stepfun-model-proxy", "weight": 1 },
    { "name": "vm-c", "baseUrl": "http://127.0.0.1:3201/v1", "apiKey": "stepfun-model-proxy", "weight": 1 }
  ],
  "routing": {
    "strategy": "rendezvous-hash",
    "sessionTtlSeconds": 86400
  },
  "retries": {
    "maxRetries": 2,
    "twoFailuresWindowSeconds": 60,
    "twoFailuresToMigrate": 2
  },
  "cooldowns": {
    "rateLimitSeconds": 1800,
    "transportErrorSeconds": 300,
    "serverErrorSeconds": 300
  }
}
```

### 3. Session -> Upstream 的绑定与持久化
需要维护状态：
- `binding[sessionKey] = upstreamName`
- `bindingUpdatedAt`
- `cooldown[sessionKey][upstreamName] = untilTimestamp`（会话级冷却，可选但很实用）
- `failCountWindow[sessionKey][upstreamName]`（60 秒窗口计数）

持久化建议：
- 初期可用本地文件（如 `data/session-bindings.json`）定时落盘
- 或用 sqlite（更稳，后续再做）
原则：代理重启后最好不要打乱绑定，否则会话会在账号间跳来跳去。

### 4. 初次分配策略（Rendezvous Hashing）
当 sessionKey 首次出现、或原绑定不可用时：
- 用 Rendezvous hashing 在所有“健康且不在冷却”的 upstream 中挑选得分最高者
- 优点：新增/删除 upstream 时，受影响 session 最少

### 5. 失败分类与迁移规则（靠谱的启发式）
由于无法知道“额度剩余”，只能用错误响应推断。建议采用以下分类：

可切换错误（会触发重试/迁移）：
1. HTTP 429
2. 网络层错误：连接拒绝/超时/连接重置
3. HTTP 5xx

不可切换错误（不跨账号重试，直接返回）：
1. HTTP 400/401/403/404 等（除 429 外）
   - 这类通常是请求格式、鉴权、模型名等问题，换账号也不会变好

迁移触发条件：
- 429：立即迁移该 sessionKey 到下一个 upstream；对当前 upstream 进入“会话级冷却” 30 分钟
- 网络/5xx：先允许换 upstream 重试（有界），并记录失败计数
  - 若在 60 秒窗口内，同一 upstream 对该 sessionKey 的失败次数 >= 2，则迁移并对该 upstream 冷却 5 分钟

最大重试次数：
- 非流式：每请求最多 `maxRetries=2`（即最多尝试 3 个 upstream）
- 流式：只允许在“开始向客户端输出任何 SSE chunk 之前”进行重试；一旦输出开始，禁止切换

### 6. 流式（SSE）特别规则
- 代理向客户端开始输出后，若 upstream 中断：
  - 返回错误并结束，不尝试切到另一个 upstream 继续输出（否则输出会拼接/重复/语义错乱）
- 代理在真正开始写响应体前，可以做一次快速重试（如首次连接不上）

---

## 观测与运维

### 1. 日志字段（必须）
每个请求至少记录：
- requestId
- sessionKey（可做 hash/截断，避免泄露完整 token）
- chosenUpstream
- retriesCount
- migrationOccurred（true/false）
- upstreamStatusCode / errorType / latencyMs

### 2. 本地管理接口（仅监听 127.0.0.1）
建议新增：
- `GET /_admin/upstreams`：查看健康状态、失败率、冷却情况
- `GET /_admin/sessions?limit=...`：查看 session 绑定情况（脱敏）
- `POST /_admin/upstreams/<name>/disable`：手动摘除某个 upstream
- `POST /_admin/upstreams/<name>/enable`：恢复

### 3. 健康检查与熔断
- 定时对每个 upstream 做健康检查（例如每 15 秒一次）
- upstream 级别熔断（避免影响新 session）：
  - 连续失败 N 次（例如 3 次）标为 unhealthy
  - 过一段时间 half-open 探测恢复

---

## 安全性注意事项

- 统一代理只监听 `127.0.0.1`
- 不把 VM 上游端口暴露到局域网
- sessionKey 来自 `Authorization Bearer`，日志必须脱敏（只记 hash 或前后几位）
- upstream 的 StepClaw apiKey（`stepfun-model-proxy`）只在代理内部使用，不透传给客户端

---

## 实施里程碑（按可验证顺序）

1. **代理支持多个 upstream 配置**
   - 读取 `config/upstreams.json` 并启动时打印加载结果
2. **实现 sessionKey 粘性绑定**
   - 同一个 apiKey 连续请求都命中同一 upstream
3. **实现失败分类 + 有界重试**
   - 人为断开某个 upstream，确认请求自动切换且重试次数受限
4. **实现“短时间两次失败迁移” + 冷却**
   - 对同一 session 在 60 秒内制造两次失败，确认迁移到其他 upstream 并在冷却期内不回切
5. **流式规则验证**
   - 流式开始输出后断开 upstream，确认不会拼接其他 upstream 的输出
6. **补齐管理接口与日志脱敏**
   - 能查看当前 upstream 健康状态与 session 绑定概况

---

## 验证清单（建议的测试方式）

- 非流式：连续发 20 个请求，确认同 sessionKey 始终落同 upstream
- 多 sessionKey：不同 sessionKey 分配到不同 upstream（近似均衡）
- 429 模拟：当 upstream 返回 429，确认 session 迁移且冷却生效
- 连接失败：停一台 VM，确认非流式可重试成功
- 流式：正常与断连场景都符合规则

---

## 风险与已知限制

- 由于 sticky key 仅来自 apiKey：同一 OpenCode 配置里如果所有请求共享同一 apiKey，则它们会共享同一账号绑定（这是预期行为）。
- “额度用完”的判断只能基于 429/错误信息启发式，可能存在误判或延迟切换。
- 跨账号重试会导致一次用户请求可能落到不同账号（已通过“有界重试 + 流式禁切换”控制风险）。
