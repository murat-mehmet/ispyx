# Elevated teardown for the "let the AI unlock this PC" feature: unregisters the Credential Provider and deletes
# the stored secret. Run by src/platform/win32/unlock.js via Start-Process -Verb RunAs. See install.ps1 for why
# ResultFile exists (no stdout/stderr redirection back to the caller with -Verb RunAs).
param(
    [Parameter(Mandatory)][string]$DllPath,
    [Parameter(Mandatory)][string]$ResultFile
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue' # best effort: still clean up what we can if one step fails

regsvr32.exe /u /s $DllPath 2>$null
Remove-Item -Path 'C:\ProgramData\ispyx\unlock.secret' -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'C:\ProgramData\ispyx\unlock.signal' -Force -ErrorAction SilentlyContinue
Set-Content -Path $ResultFile -Value 'OK' -NoNewline
exit 0
