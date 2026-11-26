# Re-encode PNGs through GDI+ (32bpp ARGB) so they open in strict viewers.
param([string]$dir = (Join-Path (Split-Path $PSScriptRoot -Parent) "shots"))
Add-Type -AssemblyName System.Drawing
Get-ChildItem -LiteralPath $dir -Filter *.png | Where-Object { $_.BaseName -notmatch '_v$' } | ForEach-Object {
    $img = [System.Drawing.Bitmap]::FromFile($_.FullName)
    $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
    $g.Dispose()
    $bmp.Save((Join-Path $dir ($_.BaseName + '_v.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $img.Dispose()
}
"reencoded: $((Get-ChildItem -LiteralPath $dir -Filter *_v.png).Count) files"
