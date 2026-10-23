# Password prompt for ispyx. Prints one JSON line on stdout and exits.
#   {"password":"..","confirm":"..","value":24,"unit":"saat","makeDefault":false}   or   {"cancel":true}
# Control names double as UI Automation ids, so tests can drive the dialog.
param(
  [string]$Mode = 'unlock',   # unlock | setup
  [string]$Message = '',
  [int]$Seconds = 30,
  [int]$Value = 24,
  [string]$Unit = 'hours'
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$setup = $Mode -eq 'setup'
$form = New-Object System.Windows.Forms.Form
$form.Text = 'ispyx'
$form.Name = 'authForm'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.ClientSize = New-Object System.Drawing.Size(380, $(if ($setup) { 250 } else { 215 }))
$font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.Font = $font

function Add-Label($text, $x, $y, $w = 340, $h = 20, $name = '') {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Size = New-Object System.Drawing.Size($w, $h)
  if ($name) { $l.Name = $name }
  $form.Controls.Add($l); return $l
}

$y = 12
$title = if ($setup) { 'First setup: choose a password. The tools will not run without it.' } else { 'A tool call came in. Enter the password to continue.' }
$null = Add-Label $title 20 $y 340 34 'title'
$y += 38
$msg = Add-Label $Message.Trim() 20 $y 340 18 'message'
$msg.ForeColor = [System.Drawing.Color]::Firebrick
$y += 22

$null = Add-Label 'Password' 20 $y 80 20
$pw = New-Object System.Windows.Forms.TextBox
$pw.Name = 'password'; $pw.UseSystemPasswordChar = $true
$pw.Location = New-Object System.Drawing.Point(110, ($y - 3)); $pw.Size = New-Object System.Drawing.Size(250, 24)
$form.Controls.Add($pw)
$y += 34

$cf = $null
if ($setup) {
  $null = Add-Label 'Repeat' 20 $y 80 20
  $cf = New-Object System.Windows.Forms.TextBox
  $cf.Name = 'confirm'; $cf.UseSystemPasswordChar = $true
  $cf.Location = New-Object System.Drawing.Point(110, ($y - 3)); $cf.Size = New-Object System.Drawing.Size(250, 24)
  $form.Controls.Add($cf)
  $y += 34
}

$null = Add-Label 'Stay unlocked for' 20 $y 130 20
$num = New-Object System.Windows.Forms.NumericUpDown
$num.Name = 'duration'; $num.Minimum = 1; $num.Maximum = 100000; $num.Value = [Math]::Max(1, $Value)
$num.Location = New-Object System.Drawing.Point(155, ($y - 3)); $num.Size = New-Object System.Drawing.Size(70, 24)
$form.Controls.Add($num)
$unitBox = New-Object System.Windows.Forms.ComboBox
$unitBox.Name = 'unit'; $unitBox.DropDownStyle = 'DropDownList'
$null = $unitBox.Items.AddRange(@('minutes', 'hours', 'days'))
$unitBox.SelectedItem = $Unit; if ($unitBox.SelectedIndex -lt 0) { $unitBox.SelectedItem = 'hours' }
$unitBox.Location = New-Object System.Drawing.Point(232, ($y - 3)); $unitBox.Size = New-Object System.Drawing.Size(80, 24)
$form.Controls.Add($unitBox)
$y += 30

$chk = New-Object System.Windows.Forms.CheckBox
$chk.Name = 'makeDefault'; $chk.Text = 'Make this the new default'
$chk.Location = New-Object System.Drawing.Point(20, $y); $chk.Size = New-Object System.Drawing.Size(340, 22)
$form.Controls.Add($chk)
$y += 30

$left = $Seconds
$count = Add-Label '' 20 ($y + 4) 170 20 'countdown'
$count.ForeColor = [System.Drawing.Color]::DimGray
$ok = New-Object System.Windows.Forms.Button
$ok.Name = 'ok'; $ok.Text = 'OK'; $ok.Location = New-Object System.Drawing.Point(200, $y); $ok.Size = New-Object System.Drawing.Size(75, 26)
$ok.DialogResult = 'OK'; $form.AcceptButton = $ok; $form.Controls.Add($ok)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Name = 'cancel'; $cancel.Text = 'Cancel'; $cancel.Location = New-Object System.Drawing.Point(285, $y); $cancel.Size = New-Object System.Drawing.Size(75, 26)
$cancel.DialogResult = 'Cancel'; $form.CancelButton = $cancel; $form.Controls.Add($cancel)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  try {
    $script:left--
    $count.Text = "Closes in $($script:left) s"
    if ($script:left -le 0) { $script:timedOut = $true; $form.DialogResult = 'Cancel'; $form.Close() }
  } catch { [Console]::Error.WriteLine("tick failed: $($_.Exception.Message)") }
})
$count.Text = "Closes in $left s"
$timer.Start()
# A background process may not take the foreground (foreground lock): attaching to the foreground thread's input lifts it.
Add-Type -Namespace Native -Name Fg -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
$script:timedOut = $false
function Bring-ToFront {
  $fg = [Native.Fg]::GetForegroundWindow()
  $pid0 = [uint32]0
  $fgThread = [Native.Fg]::GetWindowThreadProcessId($fg, [ref]$pid0)
  $me = [Native.Fg]::GetCurrentThreadId()
  # (no Alt tap here: an Alt press/release on our own window starts the window-menu mode, which freezes the buttons)
  $att = $fgThread -ne 0 -and $fgThread -ne $me -and [Native.Fg]::AttachThreadInput($me, $fgThread, $true)
  [void][Native.Fg]::SetForegroundWindow($form.Handle)
  if ($att) { [void][Native.Fg]::AttachThreadInput($me, $fgThread, $false) }
  $form.Activate(); $pw.Focus()
}
$form.Add_Shown({
  try { Bring-ToFront } catch { [Console]::Error.WriteLine("bring-to-front failed: $($_.Exception.Message)") } # never let this block the dialog
})

$res = $form.ShowDialog()
$timer.Stop()
if ($res -eq 'OK') {
  $num.ValidateEditText() # commit text typed into the number box
  $out = [ordered]@{
    password = $pw.Text
    confirm = $(if ($cf) { $cf.Text } else { '' })
    value = [int]$num.Value
    unit = [string]$unitBox.SelectedItem
    makeDefault = [bool]$chk.Checked
  }
} else {
  $out = [ordered]@{ cancel = $true; reason = $(if ($script:timedOut) { 'timeout' } else { 'closed' }) }
}
[Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
