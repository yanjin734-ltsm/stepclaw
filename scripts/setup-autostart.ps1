# StepClaw Proxy Auto-Start Setup Script
# Run this script as Administrator to create a scheduled task

$taskName = "StepClaw-OpenCode-Proxy"
$projectPath = "C:\Users\test\Desktop\stepclaw_opencode"
$nodePath = "$(Get-Command node).Source"
$scriptPath = "$projectPath\dist\index.js"

# Create the action
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $scriptPath -WorkingDirectory $projectPath

# Create triggers (at startup + at logon for redundancy)
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogon

# Create settings
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# Principal (run as current user with highest privileges)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

# Register the task
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $triggerStartup, $triggerLogon `
    -Settings $settings `
    -Principal $principal `
    -Description "StepClaw OpenCode Proxy - Auto-start on boot" `
    -Force

Write-Host "Task '$taskName' created successfully!"
Write-Host ""
Write-Host "The proxy will start automatically on:"
Write-Host "  - System startup"
Write-Host "  - User logon"
Write-Host ""
Write-Host "To verify: Get-ScheduledTask -TaskName '$taskName'"
Write-Host "To start now: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "To remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
