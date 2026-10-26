# Elevated teardown for the "let the AI unlock this PC" feature: unregisters the Credential Provider and deletes
# the stored secret and the installed DLL copy. Run by src/platform/win32/unlock.js via Start-Process -Verb
# RunAs. See install.ps1 for why ResultFile exists (no stdout/stderr redirection back to the caller with -Verb RunAs).
param(
    [Parameter(Mandatory)][string]$ResultFile
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue' # best effort: still clean up what we can if one step fails

$root = 'C:\ProgramData\ispyx'
Start-Process -FilePath regsvr32.exe -ArgumentList '/u', '/s', "`"$(Join-Path $root 'ispyx_unlock.dll')`"" -Wait -WindowStyle Hidden
Remove-Item -Path (Join-Path $root 'unlock.secret') -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $root 'unlock.signal') -Force -ErrorAction SilentlyContinue
# May be held open by a running LogonUI until the next lock cycle; harmless once unregistered.
Remove-Item -Path (Join-Path $root 'ispyx_unlock.dll') -Force -ErrorAction SilentlyContinue
Set-Content -Path $ResultFile -Value 'OK' -NoNewline
exit 0
