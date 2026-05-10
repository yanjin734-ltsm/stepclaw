# 配置 StepClaw VM 网络（在VM创建后运行，需要管理员权限）
param(
    [string]$VMName = "StepClaw-VM-A",
    [string]$VMIP = "192.168.100.10",
    [int]$HostPort = 3199,
    [int]$VMPort = 3199
)

# 检查管理员权限
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "错误: 需要管理员权限运行此脚本" -ForegroundColor Red
    exit 1
}

Write-Host "=== 配置 StepClaw VM 网络 ===" -ForegroundColor Cyan
Write-Host "VM: $VMName" -ForegroundColor White
Write-Host "VM IP: $VMIP" -ForegroundColor White
Write-Host "端口映射: 127.0.0.1:$HostPort -> $VMIP:$VMPort" -ForegroundColor White
Write-Host ""

# 1. 检查VM是否运行
$vm = Get-VM -Name $VMName -ErrorAction SilentlyContinue
if (-not $vm) {
    Write-Host "错误: VM '$VMName' 不存在" -ForegroundColor Red
    exit 1
}

if ($vm.State -ne 'Running') {
    Write-Host "启动VM..." -ForegroundColor Yellow
    Start-VM -Name $VMName
    Start-Sleep -Seconds 10
}

# 2. 配置端口映射
Write-Host "配置端口映射..." -ForegroundColor Yellow

# 删除旧的映射
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=$HostPort 2>$null

# 创建新的映射
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=$HostPort connectaddress=$VMIP connectport=$VMPort

Write-Host "[✓] 端口映射已配置" -ForegroundColor Green

# 3. 显示配置
Write-Host "`n=== 端口映射状态 ===" -ForegroundColor Cyan
netsh interface portproxy show all | Select-String "$HostPort"

# 4. 测试连通性
Write-Host "`n测试连通性..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

try {
    $result = Test-NetConnection -ComputerName 127.0.0.1 -Port $HostPort -WarningAction SilentlyContinue
    if ($result.TcpTestSucceeded) {
        Write-Host "[✓] 端口 $HostPort 可访问" -ForegroundColor Green
    } else {
        Write-Host "[✗] 端口 $HostPort 无法访问（VM内的StepClaw可能未启动）" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[✗] 测试失败: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n=== 配置完成 ===" -ForegroundColor Cyan
Write-Host "在VM内完成以下步骤:" -ForegroundColor White
Write-Host "1. 配置静态IP: $VMIP" -ForegroundColor White
Write-Host "2. 安装并登录 StepClaw" -ForegroundColor White
Write-Host "3. 确认 StepClaw 本地API运行" -ForegroundColor White
Write-Host ""
Write-Host "然后在宿主机测试:" -ForegroundColor White
Write-Host "Invoke-RestMethod -Uri 'http://127.0.0.1:$HostPort/v1/chat/completions' -Method Post ..." -ForegroundColor Gray
