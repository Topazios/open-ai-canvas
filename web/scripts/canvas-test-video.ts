import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Generated fixture only. Never read user media or require a production dependency.
export function ensureCanvasTestVideo(path: string) {
    if (existsSync(path)) return;
    const ffmpeg = process.env.FFMPEG_BIN || resolve("../.local/canvas-tools/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe");
    if (!existsSync(ffmpeg)) throw new Error("Set FFMPEG_BIN to a local FFmpeg executable to generate the synthetic video fixture.");
    mkdirSync(dirname(path), { recursive: true });
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=12", "-t", "2", "-an", "-pix_fmt", "yuv420p", "-c:v", "libvpx", path], { windowsHide: true });
}
