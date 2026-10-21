param([Parameter(Mandatory = $true)][long]$Hwnd)
# Read-only: prints one line per visible UI element of a window: "<ControlType>|<IsPassword>|<Name>".
# Never reads field values (a password field's value is not touched, only the flag).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
# Chrome builds its page accessibility tree on the first query, so ask twice
for ($pass = 0; $pass -lt 2; $pass++) {
  $all = $root.FindAll('Descendants', [Windows.Automation.Condition]::TrueCondition)
  if ($all.Count -gt 60) { break }
  Start-Sleep -Milliseconds 800
}
$n = 0
foreach ($e in $all) {
  $c = $e.Current
  if ($c.IsOffscreen) { continue }
  $t = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  if ($t -notin @('Edit', 'Button', 'Text', 'Hyperlink', 'Document', 'CheckBox')) { continue }
  "$t|$($c.IsPassword)|$($c.Name)"
  if (++$n -ge 400) { break }
}
