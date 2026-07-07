# Registers the Source Genius Urban VPN native-messaging host for Chrome.
# Usage (PowerShell, from this folder):
#     .\install.ps1 -ControllerId <sg-vpn-controller-extension-id>
#
# Get <sg-vpn-controller-extension-id> from chrome://extensions (Developer mode
# on) after you load the "SG VPN Controller" unpacked extension.
param(
  [Parameter(Mandatory = $true)][string]$ControllerId
)

$ErrorActionPreference = 'Stop'
$dir      = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat      = Join-Path $dir 'urbanvpn_host.bat'
$manifest = Join-Path $dir 'com.sourcegenius.vpn.json'

if (-not (Test-Path $bat)) { throw "Missing $bat" }

# Native-host manifest with an ABSOLUTE path to the launcher + the caller ID.
$obj = [ordered]@{
  name            = 'com.sourcegenius.vpn'
  description     = 'Source Genius Urban VPN controller host'
  path            = $bat
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ControllerId/")
}
($obj | ConvertTo-Json -Depth 5) | Set-Content -Path $manifest -Encoding utf8

# Point Chrome at the manifest (per-user, no admin needed).
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sourcegenius.vpn'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifest

Write-Host "OK — native host registered." -ForegroundColor Green
Write-Host "  manifest : $manifest"
Write-Host "  launcher : $bat"
Write-Host "  allowed  : chrome-extension://$ControllerId/"
Write-Host ""
Write-Host "If you use Edge instead of Chrome, also run:"
Write-Host "  New-Item -Path 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.sourcegenius.vpn' -Force | Out-Null"
Write-Host "  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.sourcegenius.vpn' -Name '(default)' -Value '$manifest'"
