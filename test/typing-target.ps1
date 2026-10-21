# Test target for typing-test: a form with one multiline text box. Closing it writes the box's text to -OutFile.
param([string]$OutFile)
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'win-input-typing-test'
$f.StartPosition = 'CenterScreen'
$f.Size = New-Object System.Drawing.Size(700, 300)
$f.TopMost = $true
$t = New-Object System.Windows.Forms.TextBox
$t.Multiline = $true; $t.Dock = 'Fill'
$f.Controls.Add($t)
$f.Add_Shown({ $f.Activate(); $t.Focus() })
$f.Add_FormClosing({ [System.IO.File]::WriteAllText($OutFile, $t.Text, (New-Object System.Text.UTF8Encoding($false))) })
[void]$f.ShowDialog()
