$ErrorActionPreference = 'Stop'



# Stable on-disk script path (never use Cursor/IDE temp PS1 for UAC re-launch).
$repoLauncher = Join-Path ([Environment]::GetFolderPath('Desktop')) 'stepclaw_opencode\scripts\hyper-v\Run-UnattendedInstall-Elevated.ps1'

$thisPath = $PSCommandPath

if (-not $thisPath -and $MyInvocation.MyCommand.Path) {

  $thisPath = $MyInvocation.MyCommand.Path

}

if ((Test-Path -LiteralPath $repoLauncher) -and ($thisPath -like "*\Temp\*" -or $thisPath -like "*\AppData\Local\Temp\*")) {

  $thisPath = $repoLauncher

}



$scriptDir = Split-Path -Parent $thisPath

if (-not (Test-Path -LiteralPath $thisPath)) {

  throw "Cannot find launcher at: $thisPath"

}



$pwdPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'stepclaw_vm_local_password.txt'

$transcriptLog = Join-Path ([Environment]::GetFolderPath('Desktop')) 'stepclaw_unattend_transcript.txt'



function New-SafePw {

  $n = Get-Random -Minimum 100000 -Maximum 999999

  'StepClaw' + [string]$n + '!kPz'

}



if (-not (Test-Path -LiteralPath $pwdPath)) {

  New-SafePw | Set-Content -LiteralPath $pwdPath -Encoding ascii

}



$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(

  [Security.Principal.WindowsBuiltInRole]::Administrator

)



if (-not $isAdmin) {

  Write-Host "VM password (plain text): $pwdPath"

  Write-Host "Log will be written to: $transcriptLog"

  Write-Host 'Requesting UAC — click Yes. (If窗口一闪而过，多半是临时脚本路径有问题；现已强制用桌面仓库路径)'



  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WorkingDirectory $scriptDir -ArgumentList @(

    '-NoLogo',

    '-NoProfile',

    '-ExecutionPolicy', 'Bypass',

    '-WindowStyle', 'Normal',

    '-File',

    $(Resolve-Path -LiteralPath $thisPath)

  )

  exit 0

}



try {

  Start-Transcript -Path $transcriptLog -Append -Force | Out-Null

}

catch {

  Write-Warning "Start-Transcript failed: $($_.Exception.Message)"

}



try {

  $pw = (Get-Content -LiteralPath $pwdPath -Raw).Trim()

  foreach ($bad in @('&', '<')) {

    if ($pw.Contains($bad)) { throw "Password in $pwdPath must not contain & or <." }

  }

  if ($pw.Contains([char]0x22) -or $pw.Contains([char]0x27)) {

    throw "Password in $pwdPath must not contain single or double quotes."

  }



  $startUnattend = Join-Path $scriptDir 'Start-UnattendedWindowsVM.ps1'

  & $startUnattend `

    -VmName 'StepClaw-VM-A' `

    -WindowsIsoPath 'C:\Users\test\Downloads\Win10_ISO_Official\Win10_22H2_Chinese_Simplified_x64v1.iso' `

    -StaticIP '192.168.100.10' `

    -LocalUser 'stepclaw' `

    -LocalPassword $pw `

    -ComputerName 'STEPCLAWVMA'



  try {

    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\vmconnect.exe') -ArgumentList @('localhost', 'StepClaw-VM-A')

  }

  catch {

    Write-Warning "vmconnect failed: $($_.Exception.Message)"

  }



  Write-Host 'Elevated unattended job finished (see Hyper-V window + transcript on Desktop).' -ForegroundColor Cyan

}

catch {

  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red

  Write-Host $_.ScriptStackTrace

  throw

}

finally {

  try { Stop-Transcript | Out-Null } catch { }

  Write-Host "Press Enter to close this window." -ForegroundColor Yellow

  try { Read-Host | Out-Null } catch { }

}



