# Compose 2x2 demo PNG from latest session screenshots (u0-u3).
param(
  [Parameter(Mandatory = $true)][string]$ResultsRoot,
  [string]$OutPath = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$shotDir = Join-Path $ResultsRoot "screenshots"
if (-not (Test-Path $shotDir)) { throw "Missing screenshots dir: $shotDir" }
$u0 = Get-ChildItem -Path $shotDir -Filter "*_u0.png" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $u0) { throw "No *_u0.png under $shotDir" }
$base = $u0.Name -replace '_u0\.png$', ''
$paths = @()
foreach ($i in 0..3) {
  $p = Join-Path $shotDir "${base}_u$i.png"
  if (-not (Test-Path -LiteralPath $p)) { throw "Missing $p" }
  $paths += $p
}
$cellW = 640
$cellH = 360
$labelH = 36
$bmp = New-Object System.Drawing.Bitmap (($cellW * 2), (($cellH + $labelH) * 2))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(20, 20, 24))
$font = New-Object System.Drawing.Font("Consolas", 11, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::White
$labels = @(
  "u0 worker1 10.4.158.143",
  "u1 worker1 10.4.158.143",
  "u2 worker2 10.4.146.68",
  "u3 worker2 10.4.146.68"
)
$idx = 0
foreach ($row in 0..1) {
  foreach ($col in 0..1) {
    $i = $row * 2 + $col
    $img = [System.Drawing.Image]::FromFile($paths[$i])
    $g.DrawImage($img, ($col * $cellW), ($row * ($cellH + $labelH)), $cellW, $cellH)
    $g.DrawString($labels[$i], $font, $brush, [float](5 + $col * $cellW), [float](5 + $row * ($cellH + $labelH) + $cellH))
    $img.Dispose()
    $idx++
  }
}
$figDir = Join-Path $ResultsRoot "figures"
New-Item -ItemType Directory -Force -Path $figDir | Out-Null
$out = if ($OutPath) { $OutPath } else { Join-Path $figDir "fig1_demo_screenshot.png" }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Host "Wrote $out" -ForegroundColor Green
