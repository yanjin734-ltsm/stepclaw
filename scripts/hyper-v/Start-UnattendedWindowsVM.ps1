#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Unattended Windows 10/11 install in an existing Hyper-V Gen2 VM (second ISO carries Autounattend.xml).

.NOTES
  - Host needs Windows ADK "Deployment Tools" for oscdimg.exe (to build the tiny Unattend.iso), OR place oscdimg on PATH.
  - Wipes disk 0 inside the VM during setup.
  - After first boot completes, eject ISOs on the host and set firmware to boot from the VHD:

    Get-VMDvdDrive -VMName 'StepClaw-VM-A' | ForEach-Object {
      Set-VMDvdDrive -VMName $_.VMName -ControllerNumber $_.ControllerNumber `
        -ControllerLocation $_.ControllerLocation -Path $null
    }
    Set-VMFirmware -VMName 'StepClaw-VM-A' -FirstBootDevice (Get-VMHardDiskDrive -VMName 'StepClaw-VM-A')

  StepClaw app itself still must be installed inside the VM (no public silent-switch documented here).
#>
param(
  [Parameter(Mandatory = $true)][string]$VmName,
  [Parameter(Mandatory = $true)][ValidateScript({ Test-Path $_ })][string]$WindowsIsoPath,
  [string]$StaticIP = '192.168.100.10',
  [string]$Gateway = '192.168.100.1',
  [string[]]$DnsServers = @('8.8.8.8', '1.1.1.1'),
  [string]$LocalUser = 'stepclaw',
  [Parameter(Mandatory = $true)][string]$LocalPassword,
  [string]$ComputerName = 'STEPCLAW-VM',
  [string]$TimeZone = 'China Standard Time',
  [string]$UiLanguage = 'zh-CN',
  [string]$UserLocale = 'zh-CN',
  [Nullable[int]]$ImageIndex = $null,
  [string]$UnattendIsoOut = ''
)

function Get-OscdimgExe {
  $candidates = @(
    Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\amd64\Oscdimg\oscdimg.exe'
    Join-Path $env:ProgramFiles 'Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\amd64\Oscdimg\oscdimg.exe'
  )
  foreach ($p in $candidates) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  Get-Command oscdimg -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}

function Get-DefaultImageIndexFromIso {
  param([Parameter(Mandatory)][string]$IsoPath)

  $mountedHere = $false
  $img = Get-DiskImage -ImagePath $IsoPath -ErrorAction SilentlyContinue
  if (-not $img -or -not $img.Attached) {
    try {
      Mount-DiskImage -ImagePath $IsoPath -StorageType ISO -ErrorAction Stop | Out-Null
      $mountedHere = $true
    }
    catch {
      Write-Warning "Could not mount ISO (may already be in use). Falling back to image index 6. Error: $($_.Exception.Message)"
      return 6
    }
  }

  try {
    $vol = (Get-DiskImage -ImagePath $IsoPath | Get-Volume | Where-Object { $_.DriveLetter }).DriveLetter
    if (-not $vol) { throw 'Could not get drive letter for mounted ISO.' }
    $drive = "$vol`:"

    $wim = @(
      Join-Path $drive 'sources\install.wim'
      Join-Path $drive 'sources\install.esd'
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if (-not $wim) { throw "No install.wim / install.esd under $drive\sources" }

    $images = Get-WindowsImage -ImagePath $wim -ErrorAction Stop
    $pro = $images | Where-Object {
      $_.ImageName -match 'Windows 10 Pro|Windows 11 Pro|专业版' -and $_.ImageName -notmatch 'N\)|KN'
    } | Select-Object -First 1

    if ($pro) {
      Write-Host "Using image index $($pro.ImageIndex): $($pro.ImageName)"
      return [int]$pro.ImageIndex
    }

    $first = $images | Select-Object -First 1
    Write-Warning "No Pro edition matched; using index $($first.ImageIndex): $($first.ImageName)"
    return [int]$first.ImageIndex
  }
  catch {
    Write-Warning "WIM scan failed: $($_.Exception.Message). Using fallback index 6."
    return 6
  }
  finally {
    if ($mountedHere) {
      Dismount-DiskImage -ImagePath $IsoPath -ErrorAction SilentlyContinue | Out-Null
    }
  }
}

function New-UnattendIso {
  param(
    [Parameter(Mandatory)][string]$AutounattendXml,
    [Parameter(Mandatory)][string]$OutIso,
    [Parameter(Mandatory)][string]$Oscdimg
  )

  $stage = Join-Path $env:TEMP ("stepclaw_unattend_{0}" -f [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  try {
    $xmlPath = Join-Path $stage 'Autounattend.xml'
    $utf8Bom = New-Object System.Text.UTF8Encoding $true
    [System.IO.File]::WriteAllText($xmlPath, $AutounattendXml, $utf8Bom)

    $args = @('-n', '-d', '-m', '-lUNATTEND', $stage, $OutIso)
    & $Oscdimg @args
    if ($LASTEXITCODE -ne 0) { throw "oscdimg failed with exit $LASTEXITCODE" }
  }
  finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

foreach ($bad in @('&', '<', '"', "'", '`')) {
  if ($LocalPassword.Contains($bad)) {
    throw 'Use a password without & < " '' or backtick (XML / shell safety).'
  }
}

if ($ComputerName.Length -gt 15) {
  throw 'ComputerName must be 15 characters or fewer.'
}

$vm = Get-VM -Name $VmName -ErrorAction Stop
if ($vm.Generation -ne 2) {
  throw 'This script targets Generation 2 VMs only.'
}

$oscdimg = Get-OscdimgExe
if (-not $oscdimg) {
  throw @"
oscdimg.exe not found. Install one of:
  - Windows Assessment and Deployment Kit (ADK) -> Deployment Tools
  - Or Windows 10/11 SDK (Deployment Tools)
Then re-run. Typical path:
  C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\amd64\Oscdimg\oscdimg.exe
"@
}

$winIso = (Resolve-Path -LiteralPath $WindowsIsoPath).Path

if (-not $ImageIndex.HasValue) {
  $imageIndexResolved = Get-DefaultImageIndexFromIso -IsoPath $winIso
}
else {
  $imageIndexResolved = $ImageIndex.Value
}

$flPs1 = @"
`$a = Get-NetAdapter | Where-Object { `$_.Status -eq 'Up' } | Select-Object -First 1
if (-not `$a) { exit 0 }
Remove-NetIPAddress -InterfaceIndex `$a.ifIndex -Confirm:`$false -ErrorAction SilentlyContinue
Get-NetRoute -DestinationPrefix '0.0.0.0/0' -InterfaceIndex `$a.ifIndex -ErrorAction SilentlyContinue |
  Remove-NetRoute -Confirm:`$false -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceIndex `$a.ifIndex -IPAddress '$StaticIP' -PrefixLength 24 -DefaultGateway '$Gateway'
Set-DnsClientServerAddress -InterfaceIndex `$a.ifIndex -ServerAddresses @('$($DnsServers -join "','")')
"@
$flEnc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($flPs1))
$firstLogonCmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand $flEnc"

$passPlain = $LocalPassword
# Generic Pro install key (does not activate): lets multi-index ISO select Pro during setup
$installKey = 'VK7JG-NPHTM-C97JM-9MPGT-3V66T'

$autounattend = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>$UiLanguage</UILanguage></SetupUILanguage>
      <InputLocale>$UserLocale</InputLocale>
      <SystemLocale>$UserLocale</SystemLocale>
      <UILanguage>$UiLanguage</UILanguage>
      <UILanguageFallback>$UiLanguage</UILanguageFallback>
      <UserLocale>$UserLocale</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Size>500</Size><Type>EFI</Type></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Size>128</Size><Type>MSR</Type></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Extend>true</Extend><Type>Primary</Type></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>FAT32</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Label>Windows</Label><Format>NTFS</Format></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallFrom>
            <MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>$imageIndexResolved</Value></MetaData>
          </InstallFrom>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey><Key>$installKey</Key><WillShowUI>Never</WillShowUI></ProductKey>
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>$ComputerName</ComputerName>
      <TimeZone>$TimeZone</TimeZone>
    </component>
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ExtendOSPartition><Extend>true</Extend></ExtendOSPartition>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$LocalUser</Name>
            <DisplayName>$LocalUser</DisplayName>
            <Group>Administrators</Group>
            <Password>
              <Value>$passPlain</Value>
              <PlainText>true</PlainText>
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Description>StepClaw NAT static IP</Description>
          <CommandLine>$firstLogonCmd</CommandLine>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>$UserLocale</InputLocale>
      <SystemLocale>$UserLocale</SystemLocale>
      <UILanguage>$UiLanguage</UILanguage>
      <UserLocale>$UserLocale</UserLocale>
    </component>
  </settings>
</unattend>
"@

if (-not $UnattendIsoOut) {
  $UnattendIsoOut = Join-Path $env:TEMP "StepClaw-Unattend-$VmName.iso"
}

Write-Host "Building Unattend ISO -> $UnattendIsoOut"
New-UnattendIso -AutounattendXml $autounattend -OutIso $UnattendIsoOut -Oscdimg $oscdimg

$dvds = @(Get-VMDvdDrive -VMName $VmName | Sort-Object ControllerNumber, ControllerLocation)
if ($dvds.Count -lt 1) {
  Add-VMDvdDrive -VMName $VmName
  $dvds = @(Get-VMDvdDrive -VMName $VmName | Sort-Object ControllerNumber, ControllerLocation)
}

# Slot 0: Windows installer
$d0 = $dvds[0]
Set-VMDvdDrive -VMName $VmName `
  -ControllerNumber $d0.ControllerNumber `
  -ControllerLocation $d0.ControllerLocation `
  -Path $winIso

if ($dvds.Count -lt 2) {
  Add-VMDvdDrive -VMName $VmName -Path $UnattendIsoOut | Out-Null
}
else {
  $d1 = $dvds[1]
  Set-VMDvdDrive -VMName $VmName `
    -ControllerNumber $d1.ControllerNumber `
    -ControllerLocation $d1.ControllerLocation `
    -Path $UnattendIsoOut
}

$winDvd = Get-VMDvdDrive -VMName $VmName |
  Where-Object { $_.Path -and (($_.Path -replace '\\','/' ) -eq ($winIso -replace '\\','/')) } |
  Select-Object -First 1
if (-not $winDvd) {
  $winDvd = Get-VMDvdDrive -VMName $VmName | Where-Object Path | Select-Object -First 1
}
Set-VMFirmware -VMName $VmName -FirstBootDevice $winDvd

Write-Host 'Starting VM. Connect with: '
Write-Host ('  vmconnect.exe localhost "{0}"' -f $VmName)

Start-VM -Name $VmName

Write-Host @'

Done.

When Windows setup finishes installing and reboots, ON THE HOST run (pick correct VM name):
  Set-VMDvdDrive -VmName VmName ...

So the VM boots from disk only. Then install StepClaw inside the guest.
'@
