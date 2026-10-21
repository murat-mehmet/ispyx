# Test helper: fills in and submits the win-input-mcp password dialog with plain window messages.
# (WinForms controls expose no useful UI Automation ids, so this walks the child windows instead.)
param(
  [string]$Password = '',
  [string]$Confirm = '',
  [int]$Value = 0,
  [switch]$MakeDefault,
  [switch]$Cancel,
  [int]$WaitSeconds = 15
)
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class W {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, Cb cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static string Text(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static IntPtr FindForm() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (IsWindowVisible(h) && Text(h) == "win-input-mcp" && Cls(h).StartsWith("WindowsForms")) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  /// class-substring filtered children as "handle|class|text|top" lines
  public static List<string> Children(IntPtr form) {
    var res = new List<string>();
    EnumChildWindows(form, (h, l) => { RECT r; GetWindowRect(h, out r); res.Add(h.ToInt64() + "|" + Cls(h) + "|" + Text(h) + "|" + r.T); return true; }, IntPtr.Zero);
    return res;
  }
}
'@
$form = [IntPtr]::Zero
$end = (Get-Date).AddSeconds($WaitSeconds)
while ($form -eq [IntPtr]::Zero -and (Get-Date) -lt $end) {
  $form = [W]::FindForm()
  if ($form -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($form -eq [IntPtr]::Zero) { Write-Output 'nowindow'; exit 0 }
Start-Sleep -Milliseconds 400
$kids = foreach ($line in [W]::Children($form)) {
  $p = $line.Split('|')
  [pscustomobject]@{ H = [IntPtr][long]$p[0]; Cls = $p[1]; Text = $p[2]; Top = [int]$p[3] }
}
$BM_CLICK = 0xF5; $WM_SETTEXT = 0xC
function Button($text) { ($kids | Where-Object { $_.Cls -like '*BUTTON*' -and $_.Text -eq $text } | Select-Object -First 1).H }
if ($Cancel) {
  [void][W]::SendMessage((Button 'Cancel'), $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output 'cancelled'; exit 0
}
# edits top to bottom: password, (confirm), then the number box's inner edit
$edits = @($kids | Where-Object { $_.Cls -like '*EDIT*' } | Sort-Object Top)
$setup = $edits.Count -ge 3
[void][W]::SendMessage($edits[0].H, $WM_SETTEXT, [IntPtr]::Zero, $Password)
if ($setup) { [void][W]::SendMessage($edits[1].H, $WM_SETTEXT, [IntPtr]::Zero, $Confirm) }
if ($Value -gt 0) { [void][W]::SendMessage($edits[$edits.Count - 1].H, $WM_SETTEXT, [IntPtr]::Zero, [string]$Value) }
if ($MakeDefault) { [void][W]::SendMessage((Button 'Make this the new default'), $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) }
[void][W]::SendMessage((Button 'OK'), $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output 'submitted'
