# Builds the Chrome Web Store package: dist/sift-<version>.zip
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$files = @("manifest.json", "background.js", "content.js", "content.css", "page.js",
           "shared.js", "geo.js", "popup.html", "popup.css", "popup.js", "icons", "fonts")
New-Item -ItemType Directory -Force dist | Out-Null
$out = "dist/sift-$version.zip"
if (Test-Path $out) { Remove-Item $out }
Compress-Archive -Path $files -DestinationPath $out
Write-Host "Built $out"
