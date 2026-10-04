param([switch]$VerifyOnly)
$ErrorActionPreference='Stop'
if (-not $env:LOCALAPPDATA) { throw 'template-font-user-directory-missing' }
$files=$env:ROYIN_FONT_INSTALL_JSON | ConvertFrom-Json
if ($files.Count -ne 2) { throw 'template-font-install-input-invalid' }
$fontFolder=Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
$registryFolder='HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
if ($VerifyOnly) {
 foreach($file in $files) {
  if ($file.file -notin @('ROYIN-SourceHanSansSC-Regular.otf','ROYIN-SourceHanSansSC-Bold.otf')) { throw 'template-font-name-invalid' }
  $destination=Join-Path $fontFolder $file.file
  if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'template-font-hash-mismatch' }
  $style=if($file.file -like '*-Bold.otf') {'Bold'} else {'Regular'}
  $name='Source Han Sans SC '+$style+' (OpenType)'
  $value=(Get-ItemProperty -LiteralPath $registryFolder -Name $name).$name
  if ($value -ne $destination) { throw 'template-font-registration-missing' }
 }
 Write-Output 'template-font-preflight-passed: static files, localized family, HKCU registration'
 exit 0
}
New-Item -ItemType Directory -Path $fontFolder -Force | Out-Null
New-Item -Path $registryFolder -Force | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RoyinFontInstall {
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] public static extern int AddFontResourceW(string path);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
}
'@
foreach($file in $files) {
 if ($file.file -notin @('ROYIN-SourceHanSansSC-Regular.otf','ROYIN-SourceHanSansSC-Bold.otf')) { throw 'template-font-name-invalid' }
 if ((Get-FileHash -LiteralPath $file.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'template-font-hash-mismatch' }
 $destination=Join-Path $fontFolder $file.file
 if (Test-Path -LiteralPath $destination) {
  if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'template-font-destination-conflict' }
 } else { Copy-Item -LiteralPath $file.source -Destination $destination }
 $style=if($file.file -like '*-Bold.otf') {'Bold'} else {'Regular'}
 New-ItemProperty -LiteralPath $registryFolder -Name ('Source Han Sans SC '+$style+' (OpenType)') -Value $destination -PropertyType String -Force | Out-Null
 if ([RoyinFontInstall]::AddFontResourceW($destination) -eq 0) { throw 'template-font-register-failed' }
}
$reply=[IntPtr]::Zero
[void][RoyinFontInstall]::SendMessageTimeoutW([IntPtr]0xffff,0x001D,[IntPtr]::Zero,[IntPtr]::Zero,2,2000,[ref]$reply)
Write-Output 'template-font-installed: Source Han Sans SC Regular, Bold; HKCU; static; not embedded'
