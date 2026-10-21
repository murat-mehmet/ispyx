param([string]$Match = 'Google Chrome')
# Prints "<x> <y> <width> <height>" (screen pixels) of the first taskbar button whose name starts with $Match. Read-only.
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root = [Windows.Automation.AutomationElement]::RootElement
$tray = $root.FindFirst('Children', (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')))
$buttons = $tray.FindAll('Descendants', (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)))
foreach ($b in $buttons) {
  if ($b.Current.Name.StartsWith($Match)) {
    $r = $b.Current.BoundingRectangle
    "$([int]$r.X) $([int]$r.Y) $([int]$r.Width) $([int]$r.Height)"
    exit 0
  }
}
exit 1
