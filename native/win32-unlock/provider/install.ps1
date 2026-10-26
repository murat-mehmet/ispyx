# Elevated setup step for the "let the AI unlock this PC" feature. Run by src/platform/win32/unlock.js via
# Start-Process -Verb RunAs (one UAC prompt, per docs/unlock-windows.md). Never called with the password as a
# plain argument: SecretFile is a path to a temp file (domain\nusername\npassword) that this script reads once
# and deletes, so the password never appears in a process command line (visible via Task Manager / WMI).
# ResultFile: Start-Process -Verb RunAs runs this in its own console with no stdout/stderr redirection back to
# the caller (confirmed: -RedirectStandardOutput is rejected together with -Verb, same as -WindowStyle), so the
# only way the caller learns what happened is this file.
param(
    [Parameter(Mandatory)][string]$SecretFile,
    [Parameter(Mandatory)][string]$DllPath,
    [Parameter(Mandatory)][string]$ResultFile
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

try {
    $lines = Get-Content -Path $SecretFile -Encoding UTF8
    $domain = $lines[0]
    $username = $lines[1]
    $password = $lines[2]
    if ([string]::IsNullOrEmpty($domain)) { $domain = $env:COMPUTERNAME }
    if ([string]::IsNullOrEmpty($username) -or [string]::IsNullOrEmpty($password)) {
        throw 'Missing username or password.'
    }

    Add-Type -AssemblyName System.Security

    $root = 'C:\ProgramData\ispyx'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    icacls $root /inheritance:r | Out-Null
    icacls $root /grant 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

    function Write-LenPrefixed([System.IO.MemoryStream]$ms, [string]$s) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
        $ms.Write([BitConverter]::GetBytes([uint32]$bytes.Length), 0, 4)
        $ms.Write($bytes, 0, $bytes.Length)
    }
    $ms = New-Object System.IO.MemoryStream
    Write-LenPrefixed $ms $domain
    Write-LenPrefixed $ms $username
    Write-LenPrefixed $ms $password
    $plain = $ms.ToArray()
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    [Array]::Clear($plain, 0, $plain.Length) # best effort; managed GC may have copied it already

    $secretPath = Join-Path $root 'unlock.secret'
    [System.IO.File]::WriteAllBytes($secretPath, $protected)
    icacls $secretPath /inheritance:r | Out-Null
    icacls $secretPath /grant 'SYSTEM:F' 'Administrators:F' | Out-Null

    # The resident (this same user, not elevated day to day) needs write access to just this one file. (A
    # named Win32 event was tried here instead, to drop the watcher's poll loop entirely -- reverted: a named
    # kernel object only exists while some process holds a handle open, and nothing in this architecture runs
    # continuously between an enable() and a much later signal() to be that holder. See docs/unlock-windows.md.
    # The watcher still avoids polling, via FindFirstChangeNotificationW on this directory instead.)
    $signalPath = Join-Path $root 'unlock.signal'
    if (-not (Test-Path $signalPath)) { New-Item -ItemType File -Path $signalPath | Out-Null }
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    icacls $signalPath /inheritance:r | Out-Null
    icacls $signalPath /grant 'SYSTEM:F' 'Administrators:F' "${me}:M" | Out-Null

    # regsvr32's exit code is not trustworthy with /s (confirmed in docs/unlock-windows.md); verify by reading
    # the registry back instead of trusting $LASTEXITCODE.
    # LogonUI loads this DLL as SYSTEM, so it must live somewhere only admins can write -- never in the npm
    # package dir (user-writable): that would let any local user swap it and get code running as SYSTEM.
    $installedDll = Join-Path $root 'ispyx_unlock.dll'
    try { Copy-Item -Path $DllPath -Destination $installedDll -Force } catch {
        # Already loaded by LogonUI from a previous install: keep it if it is byte-identical.
        if (-not (Test-Path $installedDll) -or (Get-FileHash $installedDll).Hash -ne (Get-FileHash $DllPath).Hash) { throw }
    }
    regsvr32.exe /s $installedDll 2>$null
    $actual = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Classes\CLSID\{1aa7e1e6-21de-4ad5-ae6e-454401b4b427}\InprocServer32' -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    if ($actual -ne $installedDll) {
        throw "Registration did not take effect (registry has '$actual', expected '$installedDll')."
    }

    Set-Content -Path $ResultFile -Value 'OK' -NoNewline
    exit 0
} catch {
    Set-Content -Path $ResultFile -Value "ERROR: $($_.Exception.Message)" -NoNewline
    exit 1
} finally {
    Remove-Item -Path $SecretFile -Force -ErrorAction SilentlyContinue
}
