# ispyx installer for Windows (no admin rights, no UAC).
#
#   irm https://raw.githubusercontent.com/murat-mehmet/ispyx/master/scripts/install.ps1 | iex
#
# With options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/murat-mehmet/ispyx/master/scripts/install.ps1))) -Uninstall
#
# Switches:
#   -Uninstall     remove shortcut, autostart entry and the npm package (keeps your data)
#   -Purge         with -Uninstall: also delete %APPDATA%\ispyx and %LOCALAPPDATA%\ispyx
#   -NoAutostart   do not enable "start at login"
#   -NoStart       do not start ispyx at the end
#   -DryRun        only print what would be done, change nothing
#   -Package       what npm installs (default "ispyx"); a .tgz from `npm pack` tests an install before publishing
param(
    [string]$Package = 'ispyx',
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$NoAutostart,
    [switch]$NoStart,
    [switch]$DryRun
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$MinNodeMajor = 22
$LocalRoot   = Join-Path $env:LOCALAPPDATA 'ispyx'
$NodeHome    = Join-Path $LocalRoot 'node'
$NpmPrefix   = Join-Path $LocalRoot 'npm'
$DataDir     = Join-Path $env:APPDATA 'ispyx'
$RunKey      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName     = 'Ispyx'
$ShortcutName = 'Ispyx.lnk'

function Say([string]$m)  { Write-Host $m }
function Step([string]$m) { Write-Host ''; Write-Host ('==> ' + $m) -ForegroundColor Cyan }
function Plan([string]$m) { Write-Host ('    [dry-run] would: ' + $m) -ForegroundColor Yellow }

# Windows PowerShell 5.1 turns anything a program writes to stderr (npm warnings!) into a terminating error under
# $ErrorActionPreference = 'Stop'. Run programs through this and check $LASTEXITCODE afterwards.
function Run-Native([scriptblock]$cmd) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $cmd 2>&1 | ForEach-Object { Write-Host ('    ' + $_) } } finally { $ErrorActionPreference = $old }
}

function Get-DesktopShortcutPath {
    return (Join-Path ([Environment]::GetFolderPath('Desktop')) $ShortcutName)
}

function Get-NodeMajor([string]$nodeExe) {
    try {
        $v = (& $nodeExe -v) 2>$null
        if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    } catch { }
    return 0
}

function Find-Node {
    # Returns full path of a node.exe with major >= 22, or $null.
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        if ((Get-NodeMajor $cmd.Source) -ge $MinNodeMajor) { return $cmd.Source }
    }
    $candidates = @(
        (Join-Path $NodeHome 'node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ((Test-Path -LiteralPath $c) -and ((Get-NodeMajor $c) -ge $MinNodeMajor)) { return $c }
    }
    return $null
}

function Get-NpmCmd([string]$nodeExe) {
    $dir = Split-Path -Parent $nodeExe
    $npm = Join-Path $dir 'npm.cmd'
    if (Test-Path -LiteralPath $npm) { return $npm }
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Add-UserPath([string]$dir) {
    $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $cur) { $cur = '' }
    $parts = $cur -split ';' | Where-Object { $_ -ne '' }
    if ($parts -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User')
    }
    if (($env:Path -split ';') -notcontains $dir) { $env:Path = $dir + ';' + $env:Path }
}

function Install-NodeWithWinget {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { Say '    winget not found, will use the portable download instead.'; return $false }
    # Only use winget when the package advertises a per-user install (otherwise it would ask for admin).
    $info = ''
    try { $info = (& winget show --id OpenJS.NodeJS.LTS -e --accept-source-agreements 2>$null) -join "`n" } catch { }
    if ($info -notmatch '(?im)scope:\s*user') {
        Say '    The winget Node.js package is not per-user, will use the portable download instead.'
        return $false
    }
    if ($DryRun) { Plan 'winget install --id OpenJS.NodeJS.LTS -e --scope user'; return $true }
    Run-Native { winget install --id OpenJS.NodeJS.LTS -e --scope user --silent --accept-package-agreements --accept-source-agreements }
    if ($LASTEXITCODE -ne 0) { Say '    winget did not succeed, will use the portable download instead.'; return $false }
    return $true
}

function Install-NodePortable {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $a = if ($arch -eq 'ARM64') { 'arm64' } else { 'x64' }
    if ($DryRun) {
        Plan ('download latest Node.js v22 LTS (win-' + $a + ' zip) from https://nodejs.org/dist, verify SHA256, extract to ' + $NodeHome)
        return
    }
    Say '    Looking up the latest Node.js 22 LTS release...'
    $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
    $rel = $index | Where-Object { $_.version -like 'v22.*' -and $_.lts } | Select-Object -First 1
    if (-not $rel) { throw 'Could not find a Node.js v22 LTS release in https://nodejs.org/dist/index.json' }
    $ver = $rel.version
    $file = 'node-' + $ver + '-win-' + $a + '.zip'
    $base = 'https://nodejs.org/dist/' + $ver + '/'
    $work = Join-Path ([IO.Path]::GetTempPath()) ('ispyx-node-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $zip = Join-Path $work $file
        Say ('    Downloading ' + $file + ' ...')
        Invoke-WebRequest -UseBasicParsing -Uri ($base + $file) -OutFile $zip
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri ($base + 'SHASUMS256.txt')).Content
        $line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($file) + '\s*$') } | Select-Object -First 1
        if (-not $line) { throw ('No checksum listed for ' + $file) }
        $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
        if ($expected -ne $actual) { throw ('Checksum mismatch for ' + $file + ' (expected ' + $expected + ', got ' + $actual + '). Nothing was installed.') }
        Say '    Checksum OK. Extracting...'
        $out = Join-Path $work 'x'
        Expand-Archive -LiteralPath $zip -DestinationPath $out -Force
        $inner = Get-ChildItem -LiteralPath $out -Directory | Select-Object -First 1
        if (-not $inner) { throw 'Unexpected zip layout.' }
        if (Test-Path -LiteralPath $NodeHome) { Remove-Item -LiteralPath $NodeHome -Recurse -Force }
        New-Item -ItemType Directory -Path $LocalRoot -Force | Out-Null
        Move-Item -LiteralPath $inner.FullName -Destination $NodeHome
        Say ('    Node.js ' + $ver + ' is in ' + $NodeHome)
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-IspyxScript([string]$npmCmd, [bool]$portable) {
    # Path of the installed package entry (src\server.js).
    if ($portable) { return (Join-Path $NpmPrefix 'node_modules\ispyx\src\server.js') }
    $root = (& $npmCmd root -g) 2>$null
    if ($root) { return (Join-Path ($root | Select-Object -First 1).Trim() 'ispyx\src\server.js') }
    return (Join-Path $env:APPDATA 'npm\node_modules\ispyx\src\server.js')
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    Step 'Uninstalling ispyx'
    $lnk = Get-DesktopShortcutPath
    if (Test-Path -LiteralPath $lnk) {
        if ($DryRun) { Plan ('delete ' + $lnk) } else { Remove-Item -LiteralPath $lnk -Force; Say ('    Removed ' + $lnk) }
    } else { Say '    No desktop shortcut found.' }

    $hasRun = $false
    try { $null = Get-ItemProperty -Path $RunKey -Name $RunName; $hasRun = $true } catch { }
    if ($hasRun) {
        if ($DryRun) { Plan ('remove ' + $RunKey + '\' + $RunName) } else { Remove-ItemProperty -Path $RunKey -Name $RunName; Say '    Removed the start-at-login entry.' }
    } else { Say '    No start-at-login entry found.' }

    $node = Find-Node
    $npm = $null
    if ($node) { $npm = Get-NpmCmd $node }
    if ($npm) {
        $portableNpm = Test-Path -LiteralPath (Join-Path $NpmPrefix 'node_modules\ispyx')
        if ($DryRun) { Plan ('npm uninstall -g ispyx' + $(if ($portableNpm) { ' --prefix ' + $NpmPrefix } else { '' })) }
        else {
            if ($portableNpm) { Run-Native { & $npm uninstall -g ispyx --prefix $NpmPrefix } } else { Run-Native { & $npm uninstall -g ispyx } }
            Say '    Removed the ispyx npm package.'
        }
    } else { Say '    npm not found, skipping package removal.' }

    if ($Purge) {
        foreach ($d in @($DataDir, $LocalRoot)) {
            if (Test-Path -LiteralPath $d) {
                if ($DryRun) { Plan ('delete folder ' + $d) } else { Remove-Item -LiteralPath $d -Recurse -Force; Say ('    Deleted ' + $d) }
            }
        }
    } else {
        Say ('    Kept your data in ' + $DataDir + ' (use -Purge to delete it).')
    }
    Say ''
    Say 'Done. If ispyx is still running, quit it from its tray icon (right-click, Quit).'
    return
}

# ------------------------------------------------------------------ install
Say 'ispyx installer'
if ($DryRun) { Say '(dry run: nothing will be changed)' }

# (a) Node.js
Step ('Step 1 of 5: looking for Node.js ' + $MinNodeMajor + ' or newer')
$node = Find-Node
if ($node) {
    Say ('    Found ' + $node)
} else {
    Say '    Not found. Installing Node.js for your user account (no admin needed).'
    $ok = Install-NodeWithWinget
    if ($ok -and -not $DryRun) { $node = Find-Node }
    if (-not $node) {
        Install-NodePortable
        $node = Join-Path $NodeHome 'node.exe'
        if (-not $DryRun) {
            Add-UserPath $NodeHome
            if ((Get-NodeMajor $node) -lt $MinNodeMajor) { throw 'Node.js was installed but does not run correctly.' }
        }
    }
    if ($DryRun -and -not $node) { $node = Join-Path $NodeHome 'node.exe' }
}
$nodeDir = Split-Path -Parent $node
$portable = ($nodeDir -ieq $NodeHome)
$npm = Get-NpmCmd $node
if (-not $npm) { if ($DryRun) { $npm = Join-Path $nodeDir 'npm.cmd' } else { throw 'npm was not found next to node.exe.' } }

# (b) npm package
Step 'Step 2 of 5: installing the ispyx package'
if ($portable) {
    if ($DryRun) {
        Plan ('npm config set prefix ' + $NpmPrefix)
        Plan ('npm install -g ' + $Package + ' --prefix ' + $NpmPrefix)
        Plan ('add ' + $NpmPrefix + ' to your user PATH')
    } else {
        New-Item -ItemType Directory -Path $NpmPrefix -Force | Out-Null
        Run-Native { & $npm config set prefix $NpmPrefix }
        if ($LASTEXITCODE -ne 0) { throw 'npm config failed.' }
        $env:Path = $nodeDir + ';' + $env:Path
        Run-Native { & $npm install -g $Package --prefix $NpmPrefix }
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
        Add-UserPath $NpmPrefix
    }
    $binDir = $NpmPrefix
} else {
    if ($DryRun) { Plan ('npm install -g ' + $Package) }
    else {
        Run-Native { & $npm install -g $Package }
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    }
    $binDir = $null
    if (-not $DryRun) { $binDir = ((& $npm prefix -g) | Select-Object -First 1).Trim() }
    if (-not $binDir) { $binDir = Join-Path $env:APPDATA 'npm' }
}
$ispyxCmd = Join-Path $binDir 'ispyx.cmd'
$script = Get-IspyxScript $npm $portable
if (-not $DryRun -and -not (Test-Path -LiteralPath $script)) { throw ('Installed package not found at ' + $script) }

# (c) Desktop shortcut
Step 'Step 3 of 5: creating the desktop shortcut'
$lnk = Get-DesktopShortcutPath
if ($DryRun) {
    Plan ('create ' + $lnk + ' -> "' + $node + '" "' + $script + '" (minimized)')
} else {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $node
    $s.Arguments = '"' + $script + '"'
    $s.WorkingDirectory = Split-Path -Parent $script
    $s.WindowStyle = 7
    $s.Description = 'Start ispyx'
    $s.Save()
    Say ('    Created ' + $lnk)
}

# autostart (first run only; the app manages it from its tray menu afterwards)
Step 'Step 4 of 5: start at login'
if ($NoAutostart) {
    Say '    Skipped (-NoAutostart). You can turn it on later in the ispyx tray menu.'
} else {
    $existing = $null
    try { $existing = (Get-ItemProperty -Path $RunKey -Name $RunName).$RunName } catch { }
    if ($existing) {
        Say '    Already set up, leaving it as it is.'
    } else {
        $runCmd = '"' + $node + '" "' + $script + '"'
        if ($DryRun) { Plan ('set ' + $RunKey + '\' + $RunName + ' = ' + $runCmd) }
        else {
            Set-ItemProperty -Path $RunKey -Name $RunName -Value $runCmd -Type String
            Say '    ispyx will start when you sign in. Change it any time in the tray menu.'
        }
    }
}

# (d) start
Step 'Step 5 of 5: starting ispyx'
if ($NoStart) {
    Say '    Skipped (-NoStart).'
} elseif ($DryRun) {
    Plan ('start "' + $node + '" "' + $script + '" hidden (exits by itself if ispyx already runs)')
} else {
    Start-Process -FilePath $node -ArgumentList ('"' + $script + '"') -WindowStyle Hidden
    Say '    Started. Look for the ispyx icon in the tray area (next to the clock; it may be under the ^ arrow).'
}

# (e) registration help
$onPath = $false
if (Get-Command ispyx.cmd -ErrorAction SilentlyContinue) { $onPath = $true }
if ($DryRun) { $onPath = $false }
$exe = if ($onPath) { 'ispyx' } else { $ispyxCmd }
Write-Host ''
Write-Host 'ispyx is installed. Connect it to your AI app:' -ForegroundColor Green
Say ''
Say 'Claude Code (run once in any terminal):'
Say ('    claude mcp add ispyx --scope user -- "' + $exe + '" mcp' -replace '"ispyx"', 'ispyx')
Say ''
Say 'Claude Desktop and other MCP clients (add to the mcpServers section of the config):'
$jsonCmd = ($exe -replace '\\', '\\')
Say '    {'
Say '      "mcpServers": {'
Say '        "ispyx": {'
Say ('          "command": "' + $jsonCmd + '",')
Say '          "args": ["mcp"]'
Say '        }'
Say '      }'
Say '    }'
Say ''
Say 'To remove ispyx later, run this installer again with -Uninstall (see docs/windows-install.md).'
