# 快速创建 StepClaw VM（需要管理员权限）
# 保存此脚本并以管理员身份运行

param(
    [string]$VMName = "StepClaw-VM-A",
    [string]$ISOPath = "C:\Users\test\Downloads\Win10_ISO_Official\Win10_22H2_Chinese_Simplified_x64v1.iso",
    [string]$VMPath = "D:\VMs",
    [string]$SwitchName = "StepClaw-Net"
)

# 检查管理员权限
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "错误: 需要管理员权限运行此脚本" -ForegroundColor Red
    Write-Host "请右键点击PowerShell，选择'以管理员身份运行'" -ForegroundColor Yellow
    exit 1
}

Write-Host "=== StepClaw VM 创建脚本 ===" -ForegroundColor Cyan
Write-Host "VM名称: $VMName" -ForegroundColor White
Write-Host "ISO路径: $ISOPath" -ForegroundColor White
Write-Host "VM路径: $VMPath" -ForegroundColor White
Write-Host ""

# 1. 检查ISO
if (-not (Test-Path $ISOPath)) {
    Write-Host "错误: ISO文件不存在: $ISOPath" -ForegroundColor Red
    exit 1
}
Write-Host "[✓] ISO文件存在" -ForegroundColor Green

# 2. 创建虚拟交换机
$switch = Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue
if (-not $switch) {
    Write-Host "创建虚拟交换机: $SwitchName" -ForegroundColor Yellow
    New-VMSwitch -Name $SwitchName -SwitchType Internal
    
    $ifIndex = (Get-NetAdapter -Name "vEthernet ($SwitchName)").ifIndex
    New-NetIPAddress -IPAddress 192.168.100.1 -PrefixLength 24 -InterfaceIndex $ifIndex
    New-NetNat -Name "StepClaw-NAT" -InternalIPInterfaceAddressPrefix 192.168.100.0/24
    Write-Host "[✓] 虚拟交换机和NAT已创建" -ForegroundColor Green
} else {
    Write-Host "[✓] 虚拟交换机已存在" -ForegroundColor Green
}

# 3. 创建VM目录
$vmFullPath = "$VMPath\$VMName"
New-Item -ItemType Directory -Path $vmFullPath -Force | Out-Null
Write-Host "[✓] VM目录已创建: $vmFullPath" -ForegroundColor Green

# 4. 创建VM（保守配置）
Write-Host "创建VM (2核, 2GB内存, 20GB磁盘)..." -ForegroundColor Yellow

New-VM -Name $VMName -MemoryStartupBytes 2GB -Generation 2 -Path $vmFullPath

# 关闭动态内存（关键！防止黑屏）
Set-VMMemory $VMName -DynamicMemoryEnabled $false

# 设置处理器
Set-VMProcessor $VMName -Count 2

# 连接网络
Connect-VMNetworkAdapter -VMName $VMName -SwitchName $SwitchName

# 创建虚拟硬盘
$vhdPath = "$vmFullPath\disk.vhdx"
New-VHD -Path $vhdPath -SizeBytes 20GB -Dynamic
Add-VMHardDiskDrive -VMName $VMName -Path $vhdPath

# 禁用安全启动
Set-VMFirmware $VMName -EnableSecureBoot Off

# 关闭自动检查点
Set-VM -Name $VMName -AutomaticCheckpointsEnabled $false

# 挂载ISO
Set-VMDvdDrive -VMName $VMName -Path $ISOPath

Write-Host "[✓] VM已创建" -ForegroundColor Green

# 5. 显示VM信息
Write-Host "`n=== VM配置摘要 ===" -ForegroundColor Cyan
Get-VM -Name $VMName | Select-Object Name, State, @{Name='MemoryGB';Expression={[math]::Round($_.MemoryStartup/1GB,2)}}, ProcessorCount, Generation | Format-Table -AutoSize

# 6. 启动VM
Write-Host "`n启动VM..." -ForegroundColor Yellow
Start-VM -Name $VMName
Start-Sleep -Seconds 3

# 7. 显示连接信息
Write-Host "`n=== 下一步操作 ===" -ForegroundColor Cyan
Write-Host "1. 打开 Hyper-V 管理器" -ForegroundColor White
Write-Host "2. 双击 VM '$VMName' 连接" -ForegroundColor White
Write-Host "3. 完成 Windows 安装" -ForegroundColor White
Write-Host "4. 在VM内安装 StepClaw" -ForegroundColor White
Write-Host "5. 配置静态IP: 192.168.100.10" -ForegroundColor White
Write-Host "6. 运行配置脚本: .\configure-vm.ps1" -ForegroundColor White

Write-Host "`nVM状态:" -ForegroundColor Yellow
Get-VM -Name $VMName | Select-Object Name, State, Uptime | Format-Table -AutoSize
