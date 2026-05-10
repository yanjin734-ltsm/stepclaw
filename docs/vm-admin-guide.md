# StepClaw VM 快速部署指南（管理员权限版）

## 问题说明

Hyper-V 需要管理员权限才能创建和管理 VM。当前用户 `test` 不在 Hyper-V Administrators 组中。

## 解决方案

### 方案1：添加用户到 Hyper-V Administrators 组（推荐，一劳永逸）

**需要：管理员权限（一次）**

1. 以管理员身份打开 PowerShell
2. 运行：
   ```powershell
   Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "DESKTOP-AORF8P6\test"
   ```
3. **注销并重新登录**（必须）
4. 之后就可以正常使用 Hyper-V 了

### 方案2：使用 VMware Workstation Player（无需管理员权限）

**优点**：
- 不需要管理员权限运行 VM
- 安装简单
- 性能不错

**步骤**：
1. 下载 [VMware Workstation Player](https://www.vmware.com/products/workstation-player.html)（免费）
2. 安装（需要管理员权限安装软件，但运行 VM 不需要）
3. 创建 VM，加载 ISO
4. 配置网络为 NAT 模式

### 方案3：使用 VirtualBox（开源免费）

**优点**：
- 完全免费开源
- 社区支持好

**步骤**：
1. 下载 [VirtualBox](https://www.virtualbox.org/)
2. 安装
3. 创建 VM

---

## 推荐：方案1 + 自动化脚本

如果你能获得一次管理员权限，后续就轻松了。

### 第一步：获取管理员权限（一次）

以管理员身份运行 PowerShell，执行：

```powershell
# 添加当前用户到 Hyper-V Administrators
Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "$env:USERDOMAIN\$env:USERNAME"

# 验证
Get-LocalGroupMember -Group "Hyper-V Administrators"
```

**注销并重新登录**

### 第二步：运行自动化脚本

重新登录后，打开普通 PowerShell（不需要管理员）：

```powershell
cd C:\Users\test\Desktop\stepclaw_opencode\scripts

# 创建 VM（自动配置网络、磁盘等）
.\create-vm.ps1

# 在VM内安装Windows和StepClaw后，配置网络映射
.\configure-vm-network.ps1
```

### 脚本功能

**create-vm.ps1**：
- 创建虚拟交换机（如果不存在）
- 创建 VM（2核2GB内存20GB磁盘）
- 关闭动态内存（防止黑屏）
- 挂载 ISO
- 启动 VM

**configure-vm-network.ps1**：
- 配置端口映射（127.0.0.1:3199 -> VM:3199）
- 测试连通性

---

## 如果无法获取管理员权限

使用 **VMware Workstation Player**：

1. 下载并安装（需要管理员权限安装，但这是一次性的）
2. 打开 Player（不需要管理员）
3. 创建新 VM
4. 选择 ISO 文件
5. 配置：
   - 内存：2GB
   - 处理器：2核
   - 磁盘：20GB
   - 网络：NAT
6. 安装 Windows
7. 安装 StepClaw

VMware 的 NAT 会自动处理端口映射，不需要手动配置。

---

## 快速决策树

```
能否获得管理员权限?
├── 能（哪怕一次）
│   └── 方案1: Hyper-V（性能最好）
│       1. 管理员PS: Add-LocalGroupMember ...
│       2. 注销重新登录
│       3. 运行 scripts/create-vm.ps1
│
└── 不能
    └── 方案2: VMware Workstation Player
        1. 下载安装（需要管理员，一次性）
        2. 创建VM（不需要管理员）
        3. 使用NAT网络（自动端口映射）
```

---

## 你的情况

根据系统信息：
- **内存**: 64GB（非常充足）
- **CPU**: i9-12900（很强）
- **磁盘**: D盘 674GB，可用 202GB

**推荐**: 方案1（Hyper-V），因为：
1. 性能最好
2. 你已经启用了 Hyper-V
3. 只需要一次管理员权限配置

**下一步**: 
1. 以管理员身份运行 PowerShell
2. 执行：`Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "DESKTOP-AORF8P6\test"`
3. 注销重新登录
4. 告诉我，我继续帮你创建 VM
