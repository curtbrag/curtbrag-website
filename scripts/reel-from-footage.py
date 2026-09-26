#!/usr/bin/env python3
"""Turn original shop footage into a captioned 9:16 Reel for dashboard preview."""

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


W, H = 1080, 1920


def font(size):
    for path in (r"C:\Windows\Fonts\arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def panel(path, label, content, top, color):
    image = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    face, tag = font(61), font(29)
    words = content.split()
    lines = []
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if draw.textlength(candidate, font=face) > W - 150 and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    if len(lines) > 4:
        raise ValueError(f"{label} is too long for the screen (maximum 4 lines)")
    height = 105 + 83 * len(lines)
    draw.rounded_rectangle((44, top, W - 44, top + height), radius=26, fill=(9, 20, 29, 218))
    draw.rounded_rectangle((44, top, W - 44, top + 10), radius=5, fill=color)
    draw.text((79, top + 31), label.upper(), font=tag, fill=color)
    for index, text in enumerate(lines):
        draw.text((79, top + 80 + index * 83), text, font=face, fill=(255, 255, 255))
    image.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "output", "hook", "tip", "cta"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    source, output = Path(args.input).expanduser().resolve(), Path(args.output).expanduser().resolve()
    if source.suffix.lower() not in (".mp4", ".mov", ".m4v") or not source.is_file():
        parser.error("Input must be an existing MP4, MOV, or M4V clip")
    for name in ("hook", "tip", "cta"):
        value = getattr(args, name).strip()
        if not value or len(value) > 180 or any(ord(char) < 32 for char in value):
            parser.error(f"{name} must be 1–180 characters on one line")
        setattr(args, name, value)
    ffmpeg = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if not ffmpeg:
        parser.error("FFmpeg is required")
    probe = shutil.which("ffprobe") or shutil.which("ffprobe.exe") or str(Path(ffmpeg).with_name("ffprobe.exe"))
    duration_result = subprocess.run(
        [probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(source)],
        capture_output=True, text=True, check=True,
    )
    duration = min(18.0, float(duration_result.stdout.strip()))
    if duration < 10:
        parser.error("Original clip must be at least 10 seconds")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        overlays = [Path(directory) / f"{index}.png" for index in range(3)]
        panel(overlays[0], "CURT / SHOP TIP", args.hook, 175, (69, 221, 225))
        panel(overlays[1], "THE TIP", args.tip, 190, (255, 186, 68))
        panel(overlays[2], "MORE SHOP TIPS", args.cta, 1450, (69, 221, 225))
        cutoff = max(2.5, duration - 3)
        filters = (
            "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,setsar=1[bg];"
            "[bg][1:v]overlay=0:0:enable='lt(t,2.5)'[hook];"
            "[hook][2:v]overlay=0:0:enable='gte(t,2.5)'[tip];"
            f"[tip][3:v]overlay=0:0:enable='gte(t,{cutoff:.2f})'[video]"
        )
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
        for overlay in overlays:
            cmd += ["-loop", "1", "-i", str(overlay)]
        cmd += ["-filter_complex", filters, "-map", "[video]", "-map", "0:a?", "-t", f"{duration:.2f}",
                "-c:v", "libx264", "-preset", "veryfast", "-b:v", "1000k", "-maxrate", "1150k",
                "-bufsize", "2300k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
                "-movflags", "+faststart", str(output)]
        subprocess.run(cmd, check=True)
    if output.stat().st_size > 4 * 1024 * 1024:
        output.unlink()
        raise RuntimeError("Reel exceeds the 4 MiB preview limit; use a shorter source clip")
    print(output)


if __name__ == "__main__":
    main()
