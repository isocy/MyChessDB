# My Chess DB engine bridge installer for Windows.
#
# Run the command shown on the site in PowerShell. It looks like:
#   $env:MYCHESSDB_SITE='https://SITE'; iex (New-Object Net.WebClient).DownloadString('https://SITE/install.ps1')
#
# It downloads the bridge into your user profile, checks the file against the
# site's checksum list, adds a Start menu shortcut, and starts it. The bridge
# then downloads the official Stockfish 19 by itself. Nothing is installed
# system-wide and no administrator rights are needed.
& {
    $ErrorActionPreference = 'Stop'

    $site = $env:MYCHESSDB_SITE
    if (-not $site) {
        throw 'MYCHESSDB_SITE is not set. Copy the whole install command from the site.'
    }
    $site = $site.TrimEnd('/')

    $arch = 'amd64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
    $name = "mychessdb-bridge-windows-$arch.exe"

    $dir = Join-Path $env:LOCALAPPDATA 'MyChessDB'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $exe = Join-Path $dir 'mychessdb-bridge.exe'
    $download = "$exe.download"

    # Older Windows PowerShell does not offer TLS 1.2 unless asked.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $client = New-Object Net.WebClient

    Write-Host "Downloading $name ..."
    $client.DownloadFile("$site/bridge/$name", $download)
    $sums = $client.DownloadString("$site/bridge/SHA256SUMS")

    $expected = $null
    foreach ($line in ($sums -split "`n")) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -eq 2 -and $parts[1] -eq $name) { $expected = $parts[0].ToLower() }
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) {
        Remove-Item -Force $download
        throw "The download does not match the site's checksum. Nothing was installed."
    }

    # Replace a copy that is already running.
    Get-Process -Name 'mychessdb-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 300
    Move-Item -Force $download $exe

    # A Start menu shortcut for next time.
    $programs = [Environment]::GetFolderPath('Programs')
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $programs 'My Chess DB Bridge.lnk'))
    $shortcut.TargetPath = $exe
    $shortcut.Arguments = "-site $site"
    $shortcut.WorkingDirectory = $dir
    $shortcut.Description = 'Runs Stockfish on this computer for the My Chess DB site'
    $shortcut.Save()

    Write-Host 'Installed. Next time, start "My Chess DB Bridge" from the Start menu.'
    Write-Host 'Starting the bridge. Keep its window open while you analyse.'
    Start-Process -FilePath $exe -ArgumentList @('-site', $site) -WorkingDirectory $dir
}
