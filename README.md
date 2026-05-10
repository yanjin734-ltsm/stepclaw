# stepclaw-opencode-proxy

将 StepClaw（stepchat.cn）的免费额度转换为 OpenAI 兼容 API，供 OpenCode 使用。

## 原理

```
OpenCode  ──→  本地代理 (localhost:8080)  ──→  stepchat.cn 内部 API
         OpenAI 格式                        Session Cookie 认证
```

本项目逆向 stepchat.cn 网页端的对话接口，将其包装为标准的 OpenAI `/v1/chat/completions` 格式，使 OpenCode 可以直接调用 StepClaw 的免费 token 额度。

## 快速开始

### 1. 获取 Token

1. 打开 https://stepchat.cn 并登录
2. 按 F12 打开 DevTools → Application → Cookies
3. 找到 `token` 字段，复制其值

### 2. 安装依赖

```bash
cd stepclaw_opencode
npm install
```

### 3. 配置

复制 `.env.example` 为 `.env`，填入你的 token：

```bash
cp .env.example .env
```

编辑 `.env`：

```
STEP_TOKENS=你的token值
```

支持多个 token 轮换（逗号分隔）：

```
STEP_TOKENS=token1,token2,token3
```

### 4. 启动

```bash
# 开发模式
npm run dev

# 或编译后运行
npm run build
npm start
```

服务启动后监听 `http://127.0.0.1:8080`。

### 5. 配置 OpenCode

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
            "name": "Step 3.5 Flash (Free)",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 262144,
            "maxTokens": 65536
          }
        ]
      }
    }
  }
}
```

### 6. 验证

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "step-3.5-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

## 抓包指南

如果 stepchat.cn 更新了接口，你需要重新抓包分析。步骤：

### 网页端抓包（推荐）

1. 打开 https://stepchat.cn，登录
2. F12 → Network 面板，勾选 "Preserve log"
3. 发送一条消息
4. 在 Network 中找到关键请求：
   - `POST /api/chat/create` — 创建会话
   - `POST /api/chat/completion` — 发送消息（SSE 流式）
   - `POST /api/chat/delete` — 删除会话
5. 查看 Request Headers 中的认证字段（Cookie 中的 token）
6. 查看 Request Body 和 Response 格式

### APP 端抓包

如果需要抓 APP 的包：

1. 安装 mitmproxy：`pip install mitmproxy`
2. 启动：`mitmweb --listen-port 8888`
3. 手机设置代理为电脑 IP:8888
4. 安装 mitmproxy CA 证书
5. 打开阶跃 AI APP，操作 StepClaw
6. 在 mitmweb 界面分析请求

## 注意事项

- ⚠️ 逆向 API 不稳定，阶跃可能随时更改接口
- ⚠️ 有封号风险，建议使用小号
- ⚠️ 免费额度有限（5000 万 token），用完即止
- ⚠️ Session token 有有效期，过期需重新获取
- 仅供学习研究使用，请遵守相关服务条款

## 项目结构

```
src/
├── index.ts            # 入口，Express 服务器
├── stepchat-client.ts  # StepChat 内部 API 客户端
├── openai-handler.ts   # OpenAI 兼容格式转换
├── token-manager.ts    # 多 token 轮换管理
└── logger.ts           # 日志工具
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `STEP_TOKENS` | stepchat.cn 的 session token，多个用逗号分隔 | 必填 |
| `PORT` | 代理服务端口 | 8080 |
| `STEP_BASE_URL` | stepchat.cn 地址 | https://stepchat.cn |
| `LOG_LEVEL` | 日志级别：debug/info/warn/error | info |

## License

MIT
