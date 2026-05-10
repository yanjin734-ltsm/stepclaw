# StepClaw 多账号多开实操指南

## 前提

StepClaw（阶跃AI桌面伙伴）默认只能同时运行一个实例。要实现"多账号轮流提供服务"，核心思路是：**让每个账号在独立环境中运行，然后把它们的本地代理端口映射到宿主机不同端口**。

## 推荐方案：Hyper-V 虚拟机（Windows 10/11 Pro 自带）

### 为什么选 Hyper-V
- Windows 10/11 Pro 自带，无需额外安装
- 性能开销小（Type-1 虚拟化）
- 网络隔离好，端口映射稳定
- 比 VMware/VirtualBox 更省资源

### 步骤 1：启用 Hyper-V

以管理员身份运行 PowerShell：

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
```

重启电脑。

### 步骤 2：创建虚拟机

每台 VM 对应一个 StepClaw 账号。

```powershell
# 创建虚拟交换机（只需执行一次）
New-VMSwitch -Name "StepClaw-Net" -SwitchType Internal

# 获取交换机接口索引
$ifIndex = (Get-NetAdapter -Name "vEthernet (StepClaw-Net)").ifIndex
New-NetIPAddress -IPAddress 192.168.100.1 -PrefixLength 24 -InterfaceIndex $ifIndex
New-NetNat -Name "StepClaw-NAT" -InternalIPInterfaceAddressPrefix 192.168.100.0/24
```

创建 VM（示例：VM-A）：

```powershell
$vmName = "StepClaw-VM-A"
$vmPath = "D:\VMs\$vmName"

# 创建目录
New-Item -ItemType Directory -Path $vmPath -Force

# 创建 VM（2核4GB内存，可根据需要调整）
New-VM -Name $vmName -MemoryStartupBytes 4GB -Generation 2 -Path $vmPath
Set-VMProcessor $vmName -Count 2

# 连接网络
Connect-VMNetworkAdapter -VMName $vmName -SwitchName "StepClaw-Net"

# 创建虚拟硬盘（40GB）
New-VHD -Path "$vmPath\disk.vhdx" -SizeBytes 40GB -Dynamic
Add-VMHardDiskDrive -VMName $vmName -Path "$vmPath\disk.vhdx"

# 禁用安全启动（如果用 Windows ISO 安装）
Set-VMFirmware $vmName -EnableSecureBoot Off
```

### 步骤 3：安装 Windows 并配置

1. 挂载 Windows ISO 启动安装
2. 安装完成后，在 VM 内：
   - 下载安装 StepClaw / StepFun Desktop
   - 登录对应的 StepClaw 账号
   - 确认可以正常对话（有额度）
   - 确认本地 API 可用：
     ```powershell
     # 在 VM 内测试
     Invoke-RestMethod -Uri "http://127.0.0.1:3199/v1/chat/completions" `
       -Method Post `
       -ContentType "application/json" `
       -Body '{"model":"step-alpha","messages":[{"role":"user","content":"ping"}]}' `
       -Headers @{ "Authorization" = "Bearer stepfun-model-proxy" }
     ```

### 步骤 4：配置端口映射（关键步骤）

假设 VM-A 的内网 IP 是 `192.168.100.10`，VM-B 是 `192.168.100.11`...

在**宿主机**上添加端口映射：

```powershell
# VM-A 的 StepClaw 映射到宿主机的 3199
netsh interface portproxy add v4tov4 `
  listenaddress=127.0.0.1 listenport=3199 `
  connectaddress=192.168.100.10 connectport=3199

# VM-B 的 StepClaw 映射到宿主机的 3200
netsh interface portproxy add v4tov4 `
  listenaddress=127.0.0.1 listenport=3200 `
  connectaddress=192.168.100.11 connectport=3199

# VM-C 的 StepClaw 映射到宿主机的 3201
netsh interface portproxy add v4tov4 `
  listenaddress=127.0.0.1 listenport=3201 `
  connectaddress=192.168.100.12 connectport=3199
```

验证映射：

```powershell
netsh interface portproxy show all
```

### 步骤 5：配置代理的 upstreams.json

在宿主机上，进入项目目录，创建配置文件：

```powershell
cd C:\Users\test\Desktop\stepclaw_opencode
mkdir -Force config
```

创建 `config\upstreams.json`：

```json
{
  "upstreams": [
    {
      "name": "vm-a",
      "baseUrl": "http://127.0.0.1:3199/v1",
      "apiKey": "stepfun-model-proxy",
      "weight": 1
    },
    {
      "name": "vm-b",
      "baseUrl": "http://127.0.0.1:3200/v1",
      "apiKey": "stepfun-model-proxy",
      "weight": 1
    },
    {
      "name": "vm-c",
      "baseUrl": "http://127.0.0.1:3201/v1",
      "apiKey": "stepfun-model-proxy",
      "weight": 1
    }
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
  },
  "healthCheck": {
    "enabled": true,
    "intervalSeconds": 15,
    "consecutiveFailures": 3
  }
}
```

### 步骤 6：启动代理并验证

```powershell
npm run build
npm start
```

你应该看到：

```
Loaded 3 upstream(s)
  - vm-a: http://127.0.0.1:3199/v1 (weight=1)
  - vm-b: http://127.0.0.1:3200/v1 (weight=1)
  - vm-c: http://127.0.0.1:3201/v1 (weight=1)
```

### 步骤 7：验证多账号切换

**测试粘性绑定**（同一个 apiKey 应该始终落在同一个 upstream）：

```powershell
# 第一次请求
Invoke-RestMethod -Uri "http://127.0.0.1:8080/v1/chat/completions" `
  -Method Post -ContentType "application/json" `
  -Body '{"model":"step-3.5-flash","messages":[{"role":"user","content":"test1"}]}' `
  -Headers @{ "Authorization" = "Bearer session-key-1" }

# 第二次请求（应该还是同一个 upstream）
Invoke-RestMethod -Uri "http://127.0.0.1:8080/v1/chat/completions" `
  -Method Post -ContentType "application/json" `
  -Body '{"model":"step-3.5-flash","messages":[{"role":"user","content":"test2"}]}' `
  -Headers @{ "Authorization" = "Bearer session-key-1" }
```

查看日志，确认两次请求的 upstream 相同。

**测试不同 session 分配到不同 upstream**：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8080/v1/chat/completions" `
  -Method Post -ContentType "application/json" `
  -Body '{"model":"step-3.5-flash","messages":[{"role":"user","content":"test"}]}' `
  -Headers @{ "Authorization" = "Bearer session-key-2" }
```

查看日志，确认这次请求的 upstream 与第一次不同。

**测试失败迁移**：

```powershell
# 停止 VM-B
Stop-VM -Name "StepClaw-VM-B"

# 对绑定到 vm-b 的 session 再次请求
# 应该自动迁移到其他可用 upstream
```

### 步骤 8：查看管理面板

```powershell
# 查看 upstream 健康状态
Invoke-RestMethod -Uri "http://127.0.0.1:8080/_admin/upstreams"

# 查看 session 绑定情况
Invoke-RestMethod -Uri "http://127.0.0.1:8080/_admin/sessions"

# 手动禁用某个 upstream
Invoke-RestMethod -Uri "http://127.0.0.1:8080/_admin/upstreams/vm-b/disable" -Method Post
```

---

## 备选方案：Windows Sandbox（轻量但重启丢失）

如果你不想用 Hyper-V，Windows 10/11 Pro 还有 **Windows Sandbox** 功能：

```powershell
# 启用 Windows Sandbox
Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All
```

但 Sandbox 每次关闭都会重置，**不适合长期运行**，只适合做临时测试。

---

## 备选方案：Windows Docker（不推荐）

理论上可以用 Windows Container 跑 StepClaw，但：
- StepClaw 是桌面应用，需要 GUI
- Windows Container 对 GUI 应用支持差
- 配置复杂，不推荐

---

## 常见问题

### Q1: 为什么不用同一系统多用户？
StepClaw 可能会检测全局端口占用或单实例锁，即使不同 Windows 用户也可能冲突。VM 是最稳妥的。

### Q2: 一台电脑能跑几个 VM？
取决于你的硬件：
- 每个 VM 建议 2核 + 4GB 内存
- 如果有 16GB 内存，可以同时跑 2-3 个 VM
- 固态硬盘必备（机械硬盘 VM 会卡死）

### Q3: VM 的 StepClaw 需要保持前台运行吗？
不需要。VM 内的 StepClaw 启动后，可以最小化，只要后台进程在跑就行。

### Q4: 端口映射重启后还在吗？
`netsh interface portproxy` 的配置是持久的，重启后仍然有效。

### Q5: 如何添加更多账号？
重复步骤 2-5，创建新的 VM，映射新端口，在 `upstreams.json` 添加新条目即可。

---

## 快速检查清单

- [ ] Hyper-V 已启用
- [ ] 每个 VM 已创建并安装 Windows
- [ ] 每个 VM 内已安装 StepClaw 并登录对应账号
- [ ] 每个 VM 内的 StepClaw 本地 API 已验证可用
- [ ] 宿主机端口映射已配置（3199/3200/3201...）
- [ ] `config/upstreams.json` 已配置
- [ ] 代理已启动并识别所有 upstream
- [ ] 粘性绑定已验证
- [ ] 失败迁移已验证
- [ ] 管理接口可正常访问
