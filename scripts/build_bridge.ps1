# Build the engine bridge for every supported computer into web\bridge\.
# Needs Go 1.22 or newer (https://go.dev/dl/). No other dependencies.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build_bridge.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'web\bridge'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -Filter 'mychessdb-bridge-*' | Remove-Item -Force

$mainGo = Get-Content (Join-Path $root 'bridge\main.go')
$version = ($mainGo | Select-String -Pattern '^\s*version\s*=\s*"(.*)"$' | Select-Object -First 1).Matches[0].Groups[1].Value

$targets = 'windows/amd64', 'windows/arm64', 'darwin/amd64', 'darwin/arm64', 'linux/amd64', 'linux/arm64'
$env:CGO_ENABLED = '0'
Push-Location (Join-Path $root 'bridge')
try {
    foreach ($target in $targets) {
        $os, $arch = $target -split '/'
        $name = "mychessdb-bridge-$os-$arch"
        if ($os -eq 'windows') { $name = "$name.exe" }
        Write-Host "building $name"
        $env:GOOS = $os
        $env:GOARCH = $arch
        # -buildvcs=false: without it Go stamps the Git commit into the file, and
        # the same source would no longer give byte-identical files.
        & go build -trimpath -buildvcs=false -ldflags '-s -w -buildid=' -o (Join-Path $out $name) .
        if ($LASTEXITCODE -ne 0) { throw "go build failed for $target" }
    }
} finally {
    Pop-Location
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
}

$lines = Get-ChildItem $out -Filter 'mychessdb-bridge-*' | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $_.Name
}
# LF line endings and no BOM, so the installers on every OS can read it.
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
[IO.File]::WriteAllText((Join-Path $out 'version.json'), ('{"version": "' + $version + '"}' + "`n"), (New-Object Text.UTF8Encoding $false))
Write-Host "bridge $version built:"
$lines | ForEach-Object { Write-Host $_ }
