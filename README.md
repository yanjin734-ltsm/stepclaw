# stepclaw-opencode-proxy

将阶跃AI桌面伙伴（StepClaw）的本地免费额度转发给 OpenCode 使用。

## 原理

```
OpenCode  ──→  本地代理 (localhost:8080)  ──→  StepClaw 桌面端本地代理 (localhost:3199)
         OpenAI 兼容格式                      OpenAI 兼容格式（已内置认证）
```

**关键发现**：阶跃AI桌面伙伴在本地 `127.0.0.1:3199` 暴露了一个标准的 OpenAI 兼容 API，使用固定 API Key `stepfun-model-proxy`。它内部处理了与阶跃云端的认证，我们只需要把 OpenCode 的请求转发过去即可。

## 前置条件

- 安装并运行 **阶跃AI桌面伙伴**（StepFun Desktop）
- 确保 StepClaw 已激活（有免费额度）

## 快速开始

### 1. 安装依赖

```bash
cd stepclaw_opencode
npm install
```

### 2. 启动代理

```bash
# 开发模式（无需编译）
npm run dev

# 或编译后运行
npm run build
npm start
```

启动后会自动检测阶跃AI桌面端是否在运行。

### 3. 配置 OpenCode

编辑 `~/.config/opencode/opencode.json`：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "stepclaw": {
        "baseUrl": "http://127.0.0.1:8080/v1",
        "api": "openai-completions",
        "apiKey": "not-needed",
        "models": [
          {
            "id": "step-3.5-flash",
            "name": "Step 3.5 Flash (StepClaw Free)",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 32000
          }
        ]
      }
    }
  }
}
```

### 4. 验证

```bash
# 测试非流式
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"step-3.5-flash","messages":[{"role":"user","content":"你好"}]}'

# 测试流式
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"step-3.5-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 无需代理的直连方案

如果你不需要模型名映射，可以跳过本代理，直接让 OpenCode 连接 StepClaw 本地端口：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "stepclaw": {
        "baseUrl": "http://127.0.0.1:3199/v1",
        "api": "openai-completions",
        "apiKey": "stepfun-model-proxy",
        "models": [
          {
            "id": "step-alpha",
            "name": "StepClaw Alpha (Free)",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 32000
          }
        ]
      }
    }
  }
}
```

## 技术细节

### StepClaw 桌面端本地架构

| 组件 | 端口 | 用途 |
|------|------|------|
| Model Proxy | 3199 | OpenAI 兼容 API，转发模型请求到阶跃云端 |
| OpenClaw Gateway | 30999 | OpenClaw 控制面板和 Agent 管理 |
| Event Bridge | 31091 | 内部事件通信 |
| DevTools | 9224 | Electron 调试端口 |

### 配置文件位置

- StepClaw 数据目录：`D:\StepClaw\data\`（由 `~/.stepclaw/stepclaw-install-state.json` 指定）
- OpenClaw 配置：`D:\StepClaw\data\openclaw.json`
- Gateway Token：`~/.stepclaw/runtime/gateway-auth-token`

### 可用模型

| 模型 ID | 说明 |
|---------|------|
| `step-alpha` | 主力编程模型（Step 3.5 Flash 的内部代号） |
| `vision-model` | 图像理解模型 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `STEPCLAW_BASE_URL` | StepClaw 本地代理地址 | `http://127.0.0.1:3199/v1` |
| `STEPCLAW_API_KEY` | 本地代理 API Key | `stepfun-model-proxy` |
| `STEPCLAW_DEFAULT_MODEL` | 默认模型 | `step-alpha` |
| `PORT` | 本代理监听端口 | `8080` |
| `LOG_LEVEL` | 日志级别 | `info` |

## 项目结构

```
src/
├── index.ts            # 入口，Express 服务器
├── stepclaw-client.ts  # StepClaw 本地代理客户端
├── openai-handler.ts   # 请求处理和转发
└── logger.ts           # 日志工具
```

## 注意事项

- 必须保持阶跃AI桌面伙伴在后台运行
- 免费额度有限，用完即止
- 本地代理仅监听 127.0.0.1，不会暴露到网络

## License

MIT
