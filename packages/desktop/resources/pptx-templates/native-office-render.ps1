param([Parameter(Mandatory=$true)][string]$InputPptx,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$presentation = $null
$powerPoint = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($InputPptx, -1, 0, 0)
  $frames = @()
  for ($i = 1; $i -le $presentation.Slides.Count; $i++) {
    $frame = Join-Path $OutputDirectory ('page-' + $i + '.png')
    $presentation.Slides.Item($i).Export($frame, 'PNG', 1600, 900)
    $frames += $frame
  }
  @{ renderer = 'Microsoft PowerPoint COM'; officeVersion = $powerPoint.Version; frames = $frames } | ConvertTo-Json -Compress
} catch {
  Write-Output '{"error":"native-office-render-unavailable"}'
  exit 1
} finally {
  if ($null -ne $presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) }
  if ($null -ne $powerPoint) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) }
}
