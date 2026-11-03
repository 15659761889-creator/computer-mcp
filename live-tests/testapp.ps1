param([string]$Log, [string]$Title = 'CMCP测试窗口', [int]$X = 200, [int]$Y = 150)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function L($m) { [IO.File]::AppendAllText($Log, "$m`n", [Text.UTF8Encoding]::new($false)) }

$f = New-Object Windows.Forms.Form
$f.Text = $Title
$f.StartPosition = 'Manual'
$f.Location = New-Object Drawing.Point $X, $Y
$f.Size = New-Object Drawing.Size 640, 500
$f.Font = New-Object Drawing.Font 'Microsoft YaHei UI', 10
$f.KeyPreview = $true

function B($text, $x, $y, $name) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text; $b.Name = $name
  $b.Location = New-Object Drawing.Point $x, $y
  $b.Size = New-Object Drawing.Size 100, 34
  $b.Add_Click({ param($s, $e) L "click $($s.Name)" })
  $f.Controls.Add($b)
  $b
}
$null = B '保存' 20 15 'save'
$null = B '取消' 130 15 'cancel'
$null = B '确定' 240 15 'ok1'
$null = B '确定' 350 15 'ok2'
$d = B '已禁用' 460 15 'disabled'; $d.Enabled = $false

$t = New-Object Windows.Forms.TextBox
$t.Name = 'input'; $t.Location = New-Object Drawing.Point 20, 65; $t.Size = New-Object Drawing.Size 300, 30
$t.AccessibleName = '姓名输入框'
$t.Add_TextChanged({ L "text $($t.Text)" })
$f.Controls.Add($t)

$c = New-Object Windows.Forms.CheckBox
$c.Text = '自动更新'; $c.Location = New-Object Drawing.Point 340, 65; $c.Size = New-Object Drawing.Size 120, 30
$c.Add_CheckedChanged({ L "check $($c.Checked)" })
$f.Controls.Add($c)

$lb = New-Object Windows.Forms.ListBox
$lb.Location = New-Object Drawing.Point 20, 110; $lb.Size = New-Object Drawing.Size 200, 110
foreach ($i in '苹果', '香蕉', '橙子', '葡萄', '西瓜', '芒果', '草莓', '樱桃', '菠萝', '柠檬') { [void]$lb.Items.Add($i) }
$lb.Add_SelectedIndexChanged({ L "select $($lb.SelectedItem)" })
$lb.Add_MouseWheel({ param($s, $e) L "wheel $($e.Delta)" })
$f.Controls.Add($lb)

# Custom-drawn surface: UI Automation sees one blank pane, only OCR can read these.
$p = New-Object Windows.Forms.Panel
$p.Location = New-Object Drawing.Point 240, 110; $p.Size = New-Object Drawing.Size 360, 110
$p.BackColor = [Drawing.Color]::FromArgb(245, 245, 245)
$p.Add_Paint({
  param($s, $e)
  $font = New-Object Drawing.Font 'Microsoft YaHei UI', 12
  $e.Graphics.FillRectangle([Drawing.Brushes]::SteelBlue, 15, 15, 130, 40)
  $e.Graphics.DrawString('自绘开始', $font, [Drawing.Brushes]::White, 35, 22)
  $e.Graphics.FillRectangle([Drawing.Brushes]::Firebrick, 195, 15, 130, 40)
  $e.Graphics.DrawString('自绘停止', $font, [Drawing.Brushes]::White, 215, 22)
})
$p.Add_MouseClick({
  param($s, $e)
  $hit = if ($e.X -ge 15 -and $e.X -le 145 -and $e.Y -ge 15 -and $e.Y -le 55) { 'draw-start' } elseif ($e.X -ge 195 -and $e.X -le 325 -and $e.Y -ge 15 -and $e.Y -le 55) { 'draw-stop' } else { 'draw-miss' }
  L "$hit $($e.Button)"
})
$p.Add_MouseDoubleClick({ param($s, $e) L "double $($e.X),$($e.Y)" })
$f.Controls.Add($p)

# Drag target.
$dragState = @{ down = $false }
$dz = New-Object Windows.Forms.Label
$dz.Text = '拖动区域'; $dz.Location = New-Object Drawing.Point 20, 235; $dz.Size = New-Object Drawing.Size 580, 60
$dz.BackColor = [Drawing.Color]::LightYellow; $dz.TextAlign = 'MiddleCenter'
$dz.Add_MouseDown({ param($s, $e) $script:dragStart = $e.X; L "dragstart" })
$dz.Add_MouseUp({ param($s, $e) L "dragend $($e.X - $script:dragStart)" })
$f.Controls.Add($dz)

$del = New-Object Windows.Forms.Timer
$del.Interval = 1000
$del.Add_Tick({ $del.Stop(); $late = New-Object Windows.Forms.Label; $late.Text = '加载完成'; $late.Location = New-Object Drawing.Point 20, 310; $late.Size = New-Object Drawing.Size 200, 30; $f.Controls.Add($late); L 'loaded' })
$sl = B '开始加载' 240 305 'slow'
$sl.Add_Click({ $del.Start() })

$dlg = B '打开对话框' 350 305 'dialog'
$dlg.Add_Click({ L 'dialog-open'; $r = [Windows.Forms.MessageBox]::Show($f, '确认要继续吗？', '测试对话框', 'YesNo'); L "dialog-result $r" })

$f.Add_KeyDown({ param($s, $e) if ($e.Control -and $e.KeyCode -eq 'S') { L 'key ctrl+s'; $e.SuppressKeyPress = $true } })
L "ready pid=$PID"
[Windows.Forms.Application]::Run($f)
