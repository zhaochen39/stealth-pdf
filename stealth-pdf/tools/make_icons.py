#!/usr/bin/env python3
"""从 SVG 重新生成全部图标资源。

用法：  npm run icons        （等价于 python3 tools/make_icons.py）

依赖：
  - rsvg-convert  （Linux: apt install librsvg2-bin；macOS: brew install librsvg）
  - Pillow        （pip install pillow）

输入（唯一的设计源文件）：
  build/icon.svg          完整图标（256px 及以上、README 用）
  build/icon-small.svg    小尺寸简化版（16/24/32px、托盘）

输出：
  build/icon.png          512x512，窗口图标
  build/icon.ico          7 个尺寸（16–256），每个尺寸使用最合适的那一版设计
  build/tray.png          32x32，托盘图标
  docs/assets/logo.png    256x256，README 用
"""
import io
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
FULL, SMALL = BUILD / "icon.svg", BUILD / "icon-small.svg"


def render(svg: Path, size: int, out: Path) -> None:
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), str(svg), "-o", str(out)], check=True)


def main() -> int:
    if not shutil.which("rsvg-convert"):
        print("找不到 rsvg-convert，请先安装 librsvg。", file=sys.stderr)
        return 1

    render(FULL, 512, BUILD / "icon.png")
    render(SMALL, 32, BUILD / "tray.png")
    (ROOT / "docs" / "assets").mkdir(parents=True, exist_ok=True)
    render(FULL, 256, ROOT / "docs" / "assets" / "logo.png")

    # 手工拼装 PNG 压缩的多尺寸 ICO：大尺寸用完整版，小尺寸用简化版
    plan = [(256, FULL), (128, FULL), (64, FULL), (48, FULL), (32, SMALL), (24, SMALL), (16, SMALL)]
    blobs = []
    with tempfile.TemporaryDirectory() as tmp:
        for size, svg in plan:
            p = Path(tmp) / f"{size}.png"
            render(svg, size, p)
            buf = io.BytesIO()
            Image.open(p).convert("RGBA").save(buf, "PNG", optimize=True)
            blobs.append((size, buf.getvalue()))

    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, payload = b"", b""
    for size, data in blobs:
        dim = 0 if size == 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset + len(payload))
        payload += data
    (BUILD / "icon.ico").write_bytes(header + entries + payload)
    print("已生成：build/icon.png, build/icon.ico, build/tray.png, docs/assets/logo.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
