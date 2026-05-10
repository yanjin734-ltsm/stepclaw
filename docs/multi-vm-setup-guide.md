# StepClaw 多账号多开实操指南（修订版）

> **重要更新**：根据实际测试反馈，原指南中的 VM 配置过于激进（4GB 内存 + 动态内存），导致 VM 启动黑屏。本修订版提供更保守、更稳妥的配置方案。

## 前提

StepClaw（阶跃AI桌面伙伴）默认只能同时运行一个实例。要实现"多账号轮流提供服务"，核心思路是：**让每个账号在独立环境中运行，然后把它们的本地代理端口映射到宿主机不同端口**。

## 你的硬件是否够格？

**最低要求**（能跑 1 个 VM）：
- CPU：4 核以上
- 内存：**16 GB**（宿主机 8GB + VM 4GB + 余量）
- 磁盘：SSD，每个 VM 至少 20GB 可用空间

**推荐配置**（能跑 2-3 个 VM）：
- CPU：8 核以上（你的 i9-12900 完全够用）
- 内存：**32 GB 以上**（你有 64GB，很好）
- 磁盘：SSD，每个 VM 40GB 空间

**如果你的内存 < 16GB，不要尝试 Hyper-V VM 方案**，改用下面的"轻量替代方案"。

---

## 方案一：Hyper-V 虚拟机（推荐，资源充足时）

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

### 步骤 2：创建虚拟交换机（只需执行一次）

```powershell
# 创建内部虚拟交换机
New-VMSwitch -Name "StepClaw-Net" -SwitchType Internal

# 获取交换机接口索引
$ifIndex = (Get-NetAdapter -Name "vEthernet (StepClaw-Net)").ifIndex

# 配置 NAT 网关
New-NetIPAddress -IPAddress 192.168.100.1 -PrefixLength 24 -InterfaceIndex $ifIndex
New-NetNat -Name "StepClaw-NAT" -InternalIPInterfaceAddressPrefix 192.168.100.0/24
```

### 步骤 3：创建虚拟机（保守配置）

**关键教训**：不要给 VM 分配太多资源，也不要开动态内存。StepClaw 是个轻量桌面应用，2GB 内存足够。

```powershell
$vmName = "StepClaw-VM-A"
$vmPath = "D:\VMs\$vmName"

# 创建目录
New-Item -ItemType Directory -Path $vmPath -Force

# 创建 VM（保守配置：2核 + 2GB 静态内存）
New-VM -Name $vmName -MemoryStartupBytes 2GB -Generation 2 -Path $vmPath

# 关闭动态内存！这是导致黑屏的元凶之一
Set-VMMemory $vmName -DynamicMemoryEnabled $false

# 设置处理器（2核足够）
Set-VMProcessor $vmName -Count 2

# 连接网络
Connect-VMNetworkAdapter -VMName $vmName -SwitchName "StepClaw-Net"

# 创建虚拟硬盘（20GB 动态扩展，实际占用取决于使用量）
New-VHD -Path "$vmPath\disk.vhdx" -SizeBytes 20GB -Dynamic
Add-VMHardDiskDrive -VMName $vmName -Path "$vmPath\disk.vhdx"

# 禁用安全启动（如果用 Windows ISO 安装）
Set-VMFirmware $vmName -EnableSecureBoot Off

# 设置自动检查点（可选，会占空间）
Set-VM -Name $vmName -AutomaticCheckpointsEnabled $false
```

**配置说明**：
- **内存 2GB**：StepClaw 是 Electron 应用，2GB 足够运行。不要设 4GB，宿主机会吃紧。
- **静态内存**：关闭 Dynamic Memory，避免内存波动导致卡顿。
- **20GB 磁盘**：Windows 精简安装后约 10GB，留 10GB 给应用和数据。
- **关闭自动检查点**：检查点会占用大量磁盘空间，手动管理更好。

### 步骤 4：安装 Windows（精简版推荐）

**推荐用 Windows 10/11 IoT Enterprise LTSC**：
- 没有多余预装软件，更省资源
- 系统占用约 6-8GB（普通版约 15-20GB）
- 可以从 [Microsoft 官网](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-10-enterprise) 下载评估版

**安装步骤**：
1. 下载 Windows ISO
2. 挂载 ISO 到 VM：
   ```powershell
   Set-VMDvdDrive -VMName $vmName -Path "D:\ISOs\Windows10_LTSC.iso"
   ```
3. 启动 VM：
   ```powershell
   Start-VM -Name $vmName
   ```
4. 用 Hyper-V 管理器连接 VM 完成安装

**安装优化**（安装完成后在 VM 内执行）：
```powershell
# 在 VM 内运行，关闭不必要的视觉效果
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects" -Name "VisualFXSetting" -Value 2

# 禁用 Windows Update（可选，减少后台活动）
Stop-Service wuauserv
Set-Service wuauserv -StartupType Disabled
```

### 步骤 5：安装 StepClaw

在 VM 内：
1. 下载 StepFun Desktop 安装包
2. 安装并登录对应账号
3. 确认可以正常对话（有额度）
4. 验证本地 API：
   ```powershell
   # 在 VM 内测试
   Invoke-RestMethod -Uri "http://127.0.0.1:3199/v1/chat/completions" `
     -Method Post -ContentType "application/json" `
     -Body '{"model":"step-alpha","messages":[{"role":"user","content":"ping"}]}' `
     -Headers @{ "Authorization" = "Bearer stepfun-model-proxy" }
   ```

### 步骤 6：配置静态 IP（VM 内）

为了让端口映射稳定，给 VM 配置静态 IP：

```powershell
# 在 VM 内运行
$adapter = Get-NetAdapter | Where-Object {$_.Status -eq "Up"}
New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress 192.168.100.10 -PrefixLength 24 -DefaultGateway 192.168.100.1
Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses 8.8.8.8
```

### 步骤 7：宿主机端口映射

```powershell
# VM-A 的 StepClaw (192.168.100.10:3199) 映射到宿主 127.0.0.1:3199
netsh interface portproxy add v4tov4 `
  listenaddress=127.0.0.1 listenport=3199 `
  connectaddress=192.168.100.10 connectport=3199

# VM-B 映射到宿主 3200（创建 VM-B 后执行）
netsh interface portproxy add v4tov4 `
  listenaddress=127.0.0.1 listenport=3200 `
  connectaddress=192.168.100.11 connectport=3199
```

验证映射：
```powershell
netsh interface portproxy show all
```

### 步骤 8：配置代理的 upstreams.json

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

---

## 方案二：Windows Sandbox（轻量，临时用）

如果你不想折腾 VM，或者内存不够，可以用 Windows Sandbox：

```powershell
# 启用 Windows Sandbox
Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All
```

**缺点**：
- 每次关闭后重置，需要重新登录 StepClaw
- 不适合长期运行

**适用场景**：临时测试、快速验证

---

## 方案三：同机多用户（不推荐但可行）

在宿主机上创建多个 Windows 用户，每个用户运行一个 StepClaw：

```powershell
# 创建新用户
New-LocalUser -Name "StepClawUser1" -Password (ConvertTo-SecureString "YourPassword" -AsPlainText -Force)
Add-LocalGroupMember -Group "Users" -Member "StepClawUser1"
```

**问题**：
- StepClaw 可能有全局单实例锁
- 需要切换用户会话，操作麻烦
- 端口冲突风险

**不推荐**，除非 VM 方案实在跑不起来。

---

## 常见问题排查

### Q1: VM 黑屏/启动失败

**原因**：
- 内存分配太多，宿主机内存不足
- 动态内存导致波动
- 虚拟硬盘空间不足

**解决**：
- 内存降到 2GB，关闭动态内存
- 确保磁盘有 20GB 可用空间
- 检查 Hyper-V 服务是否运行：
  ```powershell
  Get-Service vmms, vmcompute
  ```

### Q2: VM 启动后很卡

**原因**：
- 磁盘 I/O 瓶颈（机械硬盘）
- 内存不足导致频繁换页

**解决**：
- 必须使用 SSD
- 关闭 VM 内的视觉效果
- 禁用 Windows Update

### Q3: 端口映射不生效

**检查**：
```powershell
# 查看端口代理
netsh interface portproxy show all

# 检查防火墙
Get-NetFirewallRule -DisplayName "*StepClaw*" 

# 测试连通性
test-netconnection 192.168.100.10 -Port 3199
```

### Q4: StepClaw 在 VM 内无法联网

**检查 NAT 配置**：
```powershell
Get-NetNat | Select-Object Name, InternalIPInterfaceAddressPrefix
Get-NetIPAddress -InterfaceAlias "vEthernet (StepClaw-Net)"
```

### Q5: 代理提示 "No available upstreams"

**检查**：
1. VM 是否运行：`Get-VM`
2. StepClaw 是否在 VM 内运行
3. 端口映射是否正确
4. 防火墙是否放行

---

## 资源监控命令

```powershell
# 查看所有 VM 资源占用
Get-VM | Select-Object Name, State, @{Name='MemoryMB';Expression={[math]::Round($_.MemoryAssigned/1MB,0)}}, CPUUsage, Uptime | Format-Table -AutoSize

# 查看宿主机资源
Get-Counter '\Processor(_Total)\% Processor Time'
Get-Counter '\Memory\Available MBytes'
Get-Counter '\PhysicalDisk(_Total)\% Disk Time'

# 查看端口占用
Get-NetTCPConnection -LocalPort 3199,3200,3201 | Select-Object LocalPort, OwningProcess, State
```

---

## 快速检查清单

创建 VM 前：
- [ ] 确认内存 >= 16GB
- [ ] 确认磁盘是 SSD
- [ ] 确认 Hyper-V 已启用

创建 VM 时：
- [ ] 内存设 2GB（不要多）
- [ ] 关闭动态内存
- [ ] 磁盘设 20GB
- [ ] 关闭自动检查点

创建 VM 后：
- [ ] 安装 Windows LTSC（精简版）
- [ ] 安装 StepClaw 并登录
- [ ] 配置静态 IP
- [ ] 配置端口映射
- [ ] 验证代理多 upstream 模式

---

## 硬件要求总结

| 配置 | 可运行 VM 数 | 备注 |
|------|-------------|------|
| 16GB RAM | 1 个 | 宿主机 8GB + VM 2GB + 余量 |
| 32GB RAM | 2 个 | 宿主机 16GB + 2x VM 2GB |
| 64GB RAM | 3-4 个 | 你的配置，很充裕 |

**你的配置（i9-12900 + 64GB RAM）**：可以轻松跑 3 个 VM，每个 2GB 内存。
