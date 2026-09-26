#!/usr/bin/env python3
"""Render a narrated episode with original diagrams or reviewed Commons media."""

import argparse
import base64
import json
import math
import os
import shutil
import subprocess
import tempfile
import wave
from urllib.parse import parse_qsl, unquote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


W, H, FPS = 540, 960, 20
NAVY, WHITE, CYAN, ORANGE = (9, 19, 29), (244, 248, 250), (77, 221, 222), (255, 182, 74)
VISUALS = {"socket", "bolt", "impact", "gear", "circuit", "meter",
           "rock", "seat", "contact", "align", "force", "stop", "media"}
MEDIA_LICENSES = {"CC0", "Public domain", "CC BY 3.0", "CC BY 4.0"}
MEDIA_MIMES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
               "video/webm": ".webm", "video/ogg": ".ogv", "video/mp4": ".mp4"}
MEDIA_MAX_BYTES = 80 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise ValueError("Media URL redirected outside its reviewed source")


def validate_media(media):
    if not isinstance(media, dict):
        raise ValueError("Media scenes require source metadata from discovery")
    for key in ("url", "page", "license", "mime", "title", "author"):
        if not isinstance(media.get(key), str) or not media[key].strip():
            raise ValueError(f"Media source needs {key}; review the file page first")
    source = urlsplit(media["url"])
    page = urlsplit(media["page"])
    decoded_path = unquote(source.path)
    if ((source.scheme, source.hostname, source.port) != ("https", "upload.wikimedia.org", None)
            or not decoded_path.startswith("/wikipedia/commons/")
            or any(part in (".", "..") for part in decoded_path.split("/"))
            or any(key not in {"utm_source", "utm_campaign", "utm_content"} for key, _ in parse_qsl(source.query))
            or source.fragment):
        raise ValueError("Only Wikimedia Commons original media URLs are accepted")
    if (page.scheme, page.hostname, page.port) != ("https", "commons.wikimedia.org", None) or not page.path.startswith("/wiki/File:"):
        raise ValueError("A Commons file description page is required")
    if media["license"] not in MEDIA_LICENSES or media["mime"] not in MEDIA_MIMES:
        raise ValueError("Unsupported license or media type")
    if type(media.get("bytes")) is not int or not 0 < media["bytes"] <= MEDIA_MAX_BYTES:
        raise ValueError("Source must be 80 MiB or smaller")
    if source.username or source.password or page.username or page.password:
        raise ValueError("Media URLs may not contain credentials")
    return media


def download_media(media, output):
    validate_media(media)
    opener = build_opener(NoRedirect())
    request = Request(media["url"], headers={"User-Agent": "CurtClusterMediaEpisode/1.0 (https://curtbrag.com/cluster/)"})
    with opener.open(request, timeout=35) as response, output.open("wb") as target:
        length = response.headers.get("Content-Length")
        if length and int(length) > MEDIA_MAX_BYTES:
            raise ValueError("Media source exceeds the 80 MiB download limit")
        count = 0
        while chunk := response.read(256 * 1024):
            count += len(chunk)
            if count > MEDIA_MAX_BYTES:
                raise ValueError("Media source exceeds the 80 MiB download limit")
            target.write(chunk)
    if count < 100:
        raise ValueError("Media source is empty or invalid")
    return output


def scene_media(spec, directory):
    assets = {}
    for scene in spec["scenes"]:
        if scene["visual"] != "media":
            continue
        media = validate_media(scene["media"])
        if media["url"] not in assets:
            path = directory / f"source-{len(assets)}{MEDIA_MIMES[media['mime']]}"
            assets[media["url"]] = download_media(media, path)
    return assets


def media_frames(path, mime, ffmpeg):
    if mime.startswith("image/"):
        with Image.open(path) as original:
            original.load()
            still = ImageOps.contain(original.convert("RGB"), (W - 36, 440))
        while True:
            yield still
    else:
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", str(path),
                   "-an", "-vf", f"fps={FPS},scale={W}:440:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad={W}:440:(ow-iw)/2:(oh-ih)/2:color=0x09131d",
                   "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            expected = W * 440 * 3
            while True:
                data = bytearray()
                while len(data) < expected:
                    chunk = process.stdout.read(expected - len(data))
                    if not chunk:
                        raise RuntimeError("Video source stopped decoding before the scene ended")
                    data.extend(chunk)
                yield Image.frombytes("RGB", (W, 440), bytes(data))
        finally:
            process.stdout.close()
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait()


def face(size, bold=True):
    candidates = ([r"C:\Windows\Fonts\arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
                  if bold else [r"C:\Windows\Fonts\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"])
    for path in candidates:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


FONT_TITLE, FONT_BODY, FONT_TAG = face(34), face(23), face(17)


def lines(draw, value, font, width, limit):
    result, current = [], ""
    for word in value.split():
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=font) > width and current:
            result.append(current)
            current = word
        else:
            current = candidate
    if current:
        result.append(current)
    if len(result) > limit or any(draw.textlength(line, font=font) > width for line in result):
        raise ValueError(f"Screen text is too long: {value[:55]}")
    return result


def parse_spec(path):
    spec = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(spec, dict) or not isinstance(spec.get("scenes"), list):
        raise ValueError("Episode settings require a scenes array")
    scenes = spec["scenes"]
    if not 5 <= len(scenes) <= 8:
        raise ValueError("An episode needs 5–8 distinct scenes")
    total = 0
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise ValueError(f"Scene {index + 1} must be an object")
        for field in ("heading", "caption", "narration"):
            value = scene.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 180 or any(ord(c) < 32 for c in value):
                raise ValueError(f"Scene {index + 1}: {field} must be 1–180 characters on one line")
            scene[field] = value.strip()
        if scene.get("visual") not in VISUALS:
            raise ValueError(f"Scene {index + 1}: visual must be one of {', '.join(sorted(VISUALS))}")
        if scene["visual"] == "media":
            validate_media(scene.get("media"))
        duration = scene.get("duration")
        if type(duration) not in (int, float) or not 8 <= duration <= 18:
            raise ValueError(f"Scene {index + 1}: duration must be 8–18 seconds")
        if abs(duration * FPS - round(duration * FPS)) > 0.0001:
            raise ValueError("Scene durations must align with 20 FPS")
        total += duration
    if not 60 <= total <= 90:
        raise ValueError("Episode duration must be 60–90 seconds")
    if sum(scene["duration"] for scene in scenes[:2]) > 30:
        raise ValueError("The first two scenes must fit in the 30-second short cut")
    title = spec.get("title")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 75:
        raise ValueError("Episode title must be 1–75 characters")
    spec["title"] = title.strip()
    # Check wraps before spending time encoding the video.
    draw = ImageDraw.Draw(Image.new("RGB", (W, H)))
    for scene in scenes:
        lines(draw, scene["heading"], FONT_TITLE, W - 90, 2)
        lines(draw, scene["caption"], FONT_BODY, W - 90, 3)
    return spec, total


def hexagon(x, y, radius, sides=6, angle=math.pi / 6):
    return [(x + radius * math.cos(angle + i * math.tau / sides),
             y + radius * math.sin(angle + i * math.tau / sides)) for i in range(sides)]


def draw_lesson_visual(draw, visual, t):
    cx, cy = W // 2, 507
    steel = (155, 182, 195)
    shadow = (41, 66, 79)
    if visual == "rock":
        shift = 6 * math.sin(t * 3.1)
        angle = 0.06 * math.sin(t * 3.1)
        draw.polygon(hexagon(cx + shift, cy, 121, angle=math.pi / 6 + angle), fill=shadow, outline=ORANGE, width=5)
        draw.polygon(hexagon(cx + shift, cy, 94, angle=math.pi / 6 + angle), fill=(22, 42, 57))
        draw.polygon(hexagon(cx, cy, 81), fill=steel, outline=WHITE, width=4)
        draw.ellipse((cx - 30, cy - 30, cx + 30, cy + 30), fill=(22, 42, 57), outline=CYAN, width=3)
        draw.text((87, 648), "MOVEMENT = WARNING", font=FONT_TAG, fill=ORANGE)
    elif visual == "seat":
        travel = 76 * (1 - min((t % 5) / 2, 1))
        draw.line((cx, 370, cx, 642), fill=(55, 101, 119), width=2)
        draw.rounded_rectangle((122, 582, 418, 616), radius=7, fill=shadow, outline=steel, width=3)
        draw.rectangle((207, 511, 333, 583), fill=steel)
        draw.line((207, 511, 333, 511), fill=WHITE, width=5)
        y = 408 - travel
        draw.polygon([(174, y), (366, y), (352, y + 126), (322, y + 126),
                      (322, y + 42), (218, y + 42), (218, y + 126), (188, y + 126)],
                     fill=(72, 114, 133), outline=CYAN, width=4)
        draw.line((cx, y - 26, cx, y - 8), fill=ORANGE, width=8)
        draw.polygon([(cx - 12, y - 14), (cx + 12, y - 14), (cx, y + 3)], fill=ORANGE)
        draw.text((170, 639), "SEAT ALL THE WAY", font=FONT_TAG, fill=CYAN)
    elif visual == "contact":
        draw.line((cx, 373, cx, 635), fill=(55, 101, 119), width=3)
        for x, sides, color, label in ((158, 6, CYAN, "6 POINT"), (382, 12, ORANGE, "12 POINT")):
            draw.polygon(hexagon(x, cy, 87, sides=sides), fill=shadow, outline=color, width=4)
            draw.polygon(hexagon(x, cy, 66), fill=steel, outline=WHITE, width=2)
            draw.ellipse((x - 19, cy - 19, x + 19, cy + 19), fill=(22, 42, 57))
            draw.text((x - 45, 617), label, font=FONT_TAG, fill=color)
    elif visual == "align":
        shift = 43 * math.sin(t * 0.7)
        draw.line((cx, 375, cx, 617), fill=(64, 117, 132), width=3)
        draw.polygon(hexagon(cx, 539, 94), fill=steel, outline=WHITE, width=4)
        draw.ellipse((cx - 29, 510, cx + 29, 568), fill=(22, 42, 57), outline=CYAN, width=4)
        draw.line((cx, 521, cx + shift, 380), fill=shadow, width=36)
        draw.line((cx, 521, cx + shift, 380), fill=WHITE, width=23)
        draw.rounded_rectangle((cx + shift - 68, 363, cx + shift + 68, 385), radius=10, fill=steel)
        draw.text((158, 635), "KEEP IT SQUARE", font=FONT_TAG, fill=CYAN)
    elif visual == "force":
        theta = -0.26 - 0.18 * (1 + math.sin(t * 0.7)) / 2
        origin = (157, 548)
        end = (origin[0] + 252 * math.cos(theta), origin[1] + 252 * math.sin(theta))
        draw.polygon(hexagon(*origin, 66), fill=steel, outline=WHITE, width=4)
        draw.line((*origin, *end), fill=shadow, width=36)
        draw.line((*origin, *end), fill=WHITE, width=22)
        draw.ellipse((end[0] - 20, end[1] - 20, end[0] + 20, end[1] + 20), fill=CYAN)
        draw.arc((90, 385, 408, 705), 215, 306, fill=ORANGE, width=9)
        draw.polygon([(405, 397), (421, 408), (399, 417)], fill=ORANGE)
        draw.text((105, 638), "CONTROLLED FORCE", font=FONT_TAG, fill=CYAN)
    elif visual == "stop":
        draw.polygon(hexagon(cx, cy, 115), fill=shadow, outline=steel, width=5)
        draw.polygon(hexagon(cx, cy, 89), fill=(22, 42, 57), outline=WHITE, width=3)
        draw.regular_polygon((cx, cy, 71), 8, rotation=22.5, fill=(165, 70, 51), outline=ORANGE, width=5)
        draw.text((cx - 46, cy - 17), "STOP", font=FONT_TITLE, fill=WHITE)
        draw.text((141, 642), "RESET THE FIT", font=FONT_TAG, fill=ORANGE)


def draw_visual(draw, visual, t):
    cx, cy = W // 2, 497
    pulse = (1 + math.sin(t * 3.1)) / 2
    draw.rounded_rectangle((56, 338, W - 56, 680), radius=28, fill=(22, 42, 57), outline=(49, 91, 105), width=3)
    if visual in {"rock", "seat", "contact", "align", "force", "stop"}:
        draw_lesson_visual(draw, visual, t)
        return
    if visual in ("socket", "bolt", "impact"):
        angle = t * (0.21 if visual != "socket" else 0.09)
        for radius, color in ((117, (62, 88, 103)), (96, (167, 187, 198))):
            pts = [(cx + radius * math.cos(angle + i * math.tau / 6),
                    cy + radius * math.sin(angle + i * math.tau / 6)) for i in range(6)]
            draw.polygon(pts, fill=color, outline=WHITE, width=3)
        draw.ellipse((cx - 43, cy - 43, cx + 43, cy + 43), fill=NAVY, outline=CYAN, width=4)
        if visual == "impact":
            x = 90 + 36 * pulse
            draw.rounded_rectangle((x, cy - 18, x + 64, cy + 18), radius=7, fill=ORANGE)
            draw.line((x + 70, cy, cx - 120, cy), fill=ORANGE, width=6)
        if visual == "socket":
            draw.arc((cx - 139, cy - 139, cx + 139, cy + 139), 12, 135 + 12 * pulse, fill=ORANGE, width=8)
    elif visual == "gear":
        for x, sign in ((cx - 67, 1), (cx + 67, -1)):
            a = sign * t * 0.29
            draw.ellipse((x - 73, cy - 73, x + 73, cy + 73), fill=(90, 123, 140), outline=CYAN, width=4)
            for j in range(9):
                phi = a + j * math.tau / 9
                end = (x + 88 * math.cos(phi), cy + 88 * math.sin(phi))
                draw.line((x + 65 * math.cos(phi), cy + 65 * math.sin(phi), *end), fill=WHITE, width=12)
            draw.ellipse((x - 29, cy - 29, x + 29, cy + 29), fill=NAVY)
    elif visual in ("circuit", "meter"):
        draw.rounded_rectangle((110, cy - 71, 201, cy + 71), radius=12, fill=(87, 122, 136), outline=WHITE, width=3)
        draw.text((126, cy - 19), "+  –", font=FONT_BODY, fill=NAVY)
        draw.line((201, cy - 45, 396, cy - 45, 396, cy + 60, 201, cy + 60), fill=CYAN, width=9, joint="curve")
        draw.ellipse((322, cy - 87, 425, cy + 16), fill=NAVY, outline=ORANGE, width=6)
        angle = math.pi * (1.18 + 0.65 * pulse)
        draw.line((373, cy - 35, 373 + 41 * math.cos(angle), cy - 35 + 41 * math.sin(angle)), fill=WHITE, width=6)
        if visual == "circuit":
            x = 211 + ((t * 46) % 180)
            draw.ellipse((x - 7, cy - 52, x + 7, cy - 38), fill=ORANGE)


def frame(scene, local_t, global_t, index, count, duration, media_image=None):
    image = Image.new("RGB", (W, H), NAVY)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, W, 9), fill=CYAN)
    draw.rounded_rectangle((27, 42, W - 27, 91), radius=12, fill=(22, 47, 60))
    draw.text((49, 54), "CURT / SHOP SCIENCE", font=FONT_TAG, fill=CYAN)
    draw.text((W - 95, 55), f"{index + 1:02d}/{count:02d}", font=FONT_TAG, fill=WHITE)
    for j, line in enumerate(lines(draw, scene["heading"], FONT_TITLE, W - 90, 2)):
        draw.text((43, 141 + j * 48), line, font=FONT_TITLE, fill=WHITE)
    if media_image is None:
        draw_visual(draw, scene["visual"], local_t)
    else:
        left = (W - media_image.width) // 2
        top = 280 + (440 - media_image.height) // 2
        image.paste(media_image, (left, top))
        draw.rectangle((0, 271, W, 277), fill=CYAN)
        credit = f"MEDIA: {scene['media']['author']} / {scene['media']['license']}"
        draw.rectangle((0, 697, W, 720), fill=NAVY)
        draw.text((18, 700), credit[:66], font=face(14), fill=WHITE)
    draw.rounded_rectangle((34, 727, W - 34, 883), radius=20, fill=(24, 47, 60))
    draw.rectangle((34, 727, W - 34, 734), fill=ORANGE)
    for j, line in enumerate(lines(draw, scene["caption"], FONT_BODY, W - 90, 3)):
        draw.text((49, 757 + j * 34), line, font=FONT_BODY, fill=WHITE)
    draw.rounded_rectangle((37, 917, W - 37, 923), radius=3, fill=(65, 86, 97))
    draw.rectangle((37, 917, 37 + (W - 74) * min(global_t / duration, 1), 923), fill=CYAN)
    return image


def voice_wavs(directory, scenes, silent, ffmpeg):
    paths = [directory / f"voice-{i}.wav" for i in range(len(scenes))]
    if silent:
        for path in paths:
            with wave.open(str(path), "wb") as output:
                output.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
                output.writeframes(b"")
        return paths
    if os.name != "nt":
        raise RuntimeError("System narration requires Windows; use --silent for local visual tests")
    payload = directory / "narration.json"
    payload.write_text(json.dumps({"scenes":[scene["narration"] for scene in scenes], "directory":str(directory)}), encoding="utf-8")
    script = r'''
$ErrorActionPreference = 'Stop'
$data = Get-Content -LiteralPath $env:CURT_EPISODE_VOICE_SPEC -Raw | ConvertFrom-Json
$voice = New-Object -ComObject SAPI.SpVoice
for ($i = 0; $i -lt $data.scenes.Count; $i++) {
  $stream = New-Object -ComObject SAPI.SpFileStream
  $stream.Open((Join-Path $data.directory ("voice-$i.wav")), 3)
  $voice.AudioOutputStream = $stream
  $null = $voice.Speak([string]$data.scenes[$i])
  $stream.Close()
}
'''
    command = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    environment = dict(os.environ, CURT_EPISODE_VOICE_SPEC=str(payload))
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
                   env=environment, capture_output=True, text=True, check=True)
    if not all(path.is_file() for path in paths):
        raise RuntimeError("Windows narration produced no WAV files")
    for path in paths:
        normalized = directory / f"normalized-{path.name}"
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
                        "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(normalized)], check=True)
        normalized.replace(path)
    return paths


def combine_audio(paths, scenes, output):
    params = None
    with wave.open(str(output), "wb") as mixed:
        for path, scene in zip(paths, scenes):
            with wave.open(str(path), "rb") as part:
                if params is None:
                    params = part.getparams()
                    if params.nchannels != 1 or params.sampwidth != 2 or params.comptype != "NONE":
                        raise ValueError("Windows narration must be mono PCM")
                    mixed.setparams(params)
                if (part.getnchannels(), part.getsampwidth(), part.getframerate()) != (params.nchannels, params.sampwidth, params.framerate):
                    raise ValueError("Narration format changed between scenes")
                target_frames = round(scene["duration"] * params.framerate)
                if part.getnframes() > target_frames:
                    raise ValueError("Narration exceeds a scene; shorten its words or increase duration")
                mixed.writeframes(part.readframes(part.getnframes()))
                mixed.writeframes(b"\0" * ((target_frames - part.getnframes()) * params.sampwidth))


def verify_video(ffmpeg, path):
    if not path.is_file() or path.stat().st_size < 1024:
        raise RuntimeError(f"Episode video was not written: {path.name}")
    check = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
                            "-t", "0.1", "-f", "null", os.devnull],
                           capture_output=True, text=True)
    if check.returncode != 0:
        raise RuntimeError(f"Episode video cannot be opened: {path.name}: {check.stderr.strip()[:300]}")


def render(spec, duration, output_dir, silent):
    ffmpeg = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required")
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        assets = scene_media(spec, directory)
        voices = voice_wavs(directory, spec["scenes"], silent, ffmpeg)
        narration = directory / "narration.wav"
        combine_audio(voices, spec["scenes"], narration)
        master = output_dir / "master.mp4"
        short = output_dir / "short.mp4"
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
               "-video_size", f"{W}x{H}", "-framerate", str(FPS), "-i", "pipe:0", "-i", str(narration),
               "-vf", "scale=1080:1920:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
               "-b:v", "1500k", "-maxrate", "1750k", "-bufsize", "3000k", "-c:a", "aac", "-b:a", "96k",
               "-movflags", "+faststart", "-t", str(duration), str(master)]
        process = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        try:
            elapsed = 0.0
            for index, scene in enumerate(spec["scenes"]):
                frames = round(scene["duration"] * FPS)
                provider = (media_frames(assets[scene["media"]["url"]], scene["media"]["mime"], ffmpeg)
                            if scene["visual"] == "media" else None)
                try:
                    for n in range(frames):
                        image = next(provider) if provider else None
                        process.stdin.write(frame(scene, n / FPS, elapsed + n / FPS, index,
                                                  len(spec["scenes"]), duration, image).tobytes())
                finally:
                    if provider: provider.close()
                elapsed += scene["duration"]
        except BrokenPipeError:
            raise RuntimeError("FFmpeg stopped before rendering finished") from None
        finally:
            process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError(f"FFmpeg master encode failed ({process.returncode})")
        verify_video(ffmpeg, master)
        short_duration = sum(scene["duration"] for scene in spec["scenes"][:2])
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(master),
                        "-t", str(short_duration), "-c:v", "libx264", "-preset", "veryfast", "-b:v", "850k",
                        "-maxrate", "1000k", "-bufsize", "2000k", "-c:a", "aac", "-b:a", "80k",
                        "-movflags", "+faststart", str(short)], check=True)
        verify_video(ffmpeg, short)
    if master.stat().st_size > 32 * 1024 * 1024 or short.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Episode exceeds the 32 MiB dashboard upload limit")
    sources = list({scene["media"]["page"]: {
        "title": scene["media"]["title"], "author": scene["media"]["author"],
        "license": scene["media"]["license"], "page": scene["media"]["page"],
        "license_url": scene["media"].get("license_url", "")}
        for scene in spec["scenes"] if scene["visual"] == "media"}.values())
    return {"master_path":str(master), "short_path":str(short), "duration":duration,
            "short_duration":short_duration, "title":spec["title"], "sources":sources}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--silent", action="store_true", help="Local visual verification only")
    args = parser.parse_args()
    spec, duration = parse_spec(args.spec)
    print(json.dumps(render(spec, duration, args.output_dir, args.silent)))


if __name__ == "__main__":
    main()
