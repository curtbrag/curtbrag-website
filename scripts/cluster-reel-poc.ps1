#Requires -Version 7.0
<#
Single-script proof of concept: generate a 9:16 original Reel on RenderRig,
then transfer it to reachable Termux phones and verify SHA-256 hashes.
No Meta account is accessed and no video is posted.
#>
param(
    [string]$Output = (Join-Path $env:USERPROFILE 'Videos\impact-bolt-poc.mp4'),
    [string]$Username = 'u0_a191',
    [int[]]$Phones = @(173,174,176,177,191,195,253,254),
    [switch]$SkipPhones
)
$ErrorActionPreference = 'Stop'
$python = 'C:\Program Files\Python311\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    $python = (Get-Command python.exe -ErrorAction Stop).Source
}
$ffmpeg = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $ffmpeg) {
    $ffmpeg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'
}
if (-not (Test-Path -LiteralPath $ffmpeg)) { throw 'FFmpeg is not installed; RenderRig status must show ffmpeg before running this proof of concept.' }
$env:PATH = "$(Split-Path -Parent $ffmpeg);$env:PATH"
& $python -c 'import PIL' 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Installing Pillow for video graphics...'
    & $python -m pip install --user Pillow
    if ($LASTEXITCODE -ne 0) { throw 'Pillow install failed.' }
}
$source = Join-Path $env:TEMP "curt-reel-poc-$PID.py"
try {
@'
#!/usr/bin/env python3
"""Generate an original vertical shop-science Reel with Pillow and FFmpeg.

Usage: python reel-poc.py --output demo.mp4
Requires: python -m pip install pillow, plus ffmpeg on PATH.
The footage is generated locally. Nothing is uploaded or posted.
"""

import argparse
import math
import os
import shutil
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H, FPS, DURATION = 540, 960, 20, 16
NAVY = (10, 18, 30)
INK = (231, 243, 250)
MUTED = (137, 161, 177)
CYAN = (69, 221, 225)
AMBER = (255, 186, 68)


def font(size, bold=False):
    candidates = ([
        r'C:\Windows\Fonts\arialbd.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ] if bold else [
        r'C:\Windows\Fonts\arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ])
    for name in candidates:
        if Path(name).is_file():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default(size)


F_BIG = font(46, True)
F_MED = font(32, True)
F_SMALL = font(19)
F_LABEL = font(18, True)


def center(draw, text, y, face, fill=INK):
    box = draw.textbbox((0, 0), text, font=face)
    draw.text(((W - (box[2] - box[0])) / 2, y), text, font=face, fill=fill)


def bolt(draw, rotation=0, glow=0, hammer=False):
    cx, cy = W // 2, 524
    if glow:
        for offset in (12, 26, 42):
            draw.ellipse((cx-117-offset, cy-117-offset, cx+117+offset, cy+117+offset),
                         outline=(*CYAN, max(0, int(95*glow)-offset)), width=3)
    draw.ellipse((cx-157, cy-157, cx+157, cy+157), fill=(23, 40, 57), outline=(45, 70, 86), width=4)
    for j in range(12):
        angle = j * math.tau / 12
        x, y = cx + 145 * math.cos(angle), cy + 145 * math.sin(angle)
        draw.ellipse((x-4, y-4, x+4, y+4), fill=(88, 112, 125))
    points = [(cx + 110 * math.cos(rotation+j*math.tau/6),
               cy + 110 * math.sin(rotation+j*math.tau/6)) for j in range(6)]
    draw.polygon(points, fill=(130, 151, 165), outline=INK, width=5)
    draw.ellipse((cx-23, cy-23, cx+23, cy+23), fill=(55, 75, 89))
    if hammer:
        draw.rounded_rectangle((85, cy+197, W-85, cy+248), radius=20,
                               fill=(35, 61, 77), outline=CYAN, width=3)
        center(draw, 'TAP  •  TAP  •  TAP', cy+205, F_LABEL, CYAN)


def render_frame(t):
    im = Image.new('RGB', (W, H), NAVY)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, 10), fill=CYAN)
    d.rounded_rectangle((27, 37, W-27, 83), radius=13, fill=(26, 48, 65))
    center(d, 'CURT  /  SHOP SCIENCE', 48, F_LABEL, CYAN)
    phase = 0 if t < 3.2 else 1 if t < 7.2 else 2 if t < 12.5 else 3
    if phase == 0:
        center(d, 'WHY DOES AN IMPACT', 158, F_MED)
        center(d, 'BREAK STUCK BOLTS?', 205, F_MED, AMBER)
        bolt(d, rotation=0)
        center(d, 'Same bolt. Different force.', 749, F_SMALL, MUTED)
    elif phase == 1:
        center(d, 'STEADY FORCE', 159, F_BIG, AMBER)
        center(d, 'The rust bond resists.', 227, F_SMALL)
        bolt(d)
        d.rounded_rectangle((110, 761, 430, 785), radius=12, fill=(37, 58, 72))
        d.rounded_rectangle((110, 761, 235, 785), radius=12, fill=AMBER)
        center(d, 'NO MOVEMENT', 805, F_LABEL, AMBER)
    elif phase == 2:
        pulse = max(0, 1-abs(((t-7.2)*3.2) % 1-.12)*4)
        center(d, 'SHORT IMPACTS', 159, F_BIG, CYAN)
        center(d, 'Energy lands in repeated hits.', 227, F_SMALL)
        bolt(d, rotation=min((t-7.2)*.17, .7), glow=pulse, hammer=True)
        for j in range(3):
            x = 124 + (j*139)
            d.rounded_rectangle((x-12, 778-24*pulse, x+12, 795), radius=8, fill=CYAN)
    else:
        center(d, 'THE BOND BREAKS.', 161, F_BIG, CYAN)
        center(d, 'Then the bolt turns.', 228, F_MED)
        bolt(d, rotation=.75+(t-12.5)*.38, glow=.55)
        center(d, 'Real repairs. Simple science.', 774, F_SMALL, INK)
        center(d, 'FOLLOW FOR MORE', 827, F_LABEL, CYAN)
    d.rectangle((30, 907, W-30, 911), fill=(43, 68, 82))
    d.rectangle((30, 907, 30+(W-60)*t/DURATION, 911), fill=CYAN)
    return im


def make_audio(path):
    rate = 22050
    hits = [7.55+i*.315 for i in range(15)] + [12.5]
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        samples = bytearray()
        for n in range(DURATION*rate):
            t = n/rate
            bed = 110*math.sin(math.tau*72*t)
            knock = 0
            for hit in hits:
                age = t-hit
                if 0 <= age < .09:
                    knock += 5200*math.exp(-age*57)*math.sin(math.tau*(160-800*age)*age)
            samples.extend(struct.pack('<h', max(-32768, min(32767, int(bed+knock)))))
        out.writeframes(samples)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path('impact-bolt-poc.mp4'))
    args = parser.parse_args()
    ffmpeg = shutil.which('ffmpeg') or shutil.which('ffmpeg.exe')
    if not ffmpeg and os.environ.get('LOCALAPPDATA'):
        candidate = Path(os.environ['LOCALAPPDATA'])/'Microsoft'/'WinGet'/'Links'/'ffmpeg.exe'
        if candidate.is_file():
            ffmpeg = str(candidate)
    if not ffmpeg:
        parser.error('FFmpeg is required on PATH')
    args.output = args.output.expanduser().resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        audio = Path(tmp)/'sound.wav'
        make_audio(audio)
        cmd = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
               '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', f'{W}x{H}',
               '-framerate', str(FPS), '-i', 'pipe:0', '-i', str(audio),
               '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p',
               '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
               '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
               '-shortest', str(args.output)]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        try:
            for frame in range(DURATION*FPS):
                proc.stdin.write(render_frame(frame/FPS).tobytes())
        except BrokenPipeError:
            raise RuntimeError('FFmpeg exited before the Reel was encoded') from None
        finally:
            proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError(f'FFmpeg failed with exit status {proc.returncode}')
    print(args.output)


if __name__ == '__main__':
    main()

'@ | Set-Content -LiteralPath $source -Encoding utf8
    Write-Host 'Rendering original 16-second Reel...'
    & $python $source --output $Output
    if ($LASTEXITCODE -ne 0) { throw 'Video render failed.' }
} finally {
    Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
}
$video = (Resolve-Path -LiteralPath $Output).Path
Write-Host "Video ready: $video ($([math]::Round((Get-Item -LiteralPath $video).Length / 1MB, 2)) MiB)"
if ($SkipPhones) { return }
if (-not (Get-Command scp -ErrorAction SilentlyContinue) -or -not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw 'Windows OpenSSH Client (scp and ssh) is required to check the phones.'
}
$expected = (Get-FileHash -LiteralPath $video -Algorithm SHA256).Hash.ToLowerInvariant()
$results = foreach ($number in $Phones) {
    $ip = "192.168.1.$number"
    $phoneHost = "$Username@$ip"
    $row = [ordered]@{ phone = "phone$number"; copied = $false; hash_match = $false; detail = '' }
    try {
        $copyArgs = @('-q','-P','8022','-o','BatchMode=yes','-o','ConnectTimeout=5',
                      '-o','StrictHostKeyChecking=yes',$video,"${phoneHost}:~/impact-bolt-poc.mp4")
        $copyOutput = & scp @copyArgs 2>&1
        if ($LASTEXITCODE -ne 0) { throw "scp exit $LASTEXITCODE $copyOutput" }
        $row.copied = $true
        $hashOutput = & ssh -p 8022 -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes `
            $phoneHost 'sha256sum ~/impact-bolt-poc.mp4' 2>&1
        if ($LASTEXITCODE -ne 0) { throw "ssh exit $LASTEXITCODE $hashOutput" }
        $actual = ([string]($hashOutput | Select-Object -First 1) -split '\s+')[0].ToLowerInvariant()
        $row.hash_match = ($actual -eq $expected)
        $row.detail = if ($row.hash_match) { 'ready on phone' } else { 'hash differs' }
    } catch {
        $row.detail = ($_.Exception.Message -replace '\s+', ' ').Trim()
    }
    [pscustomobject]$row
}
$results | Format-Table -AutoSize
"Phones ready: $(@($results | Where-Object hash_match).Count) / $($Phones.Count)"
