"use client";

// Client-side audio extraction for large uploaded files (Upload button).
// Problem: Supabase Storage's free-tier hard cap is 50MB per object, and a
// 60-min screen recording with a video track easily hits 900MB+. Whisper
// only ever needs the audio anyway (it resamples to 16kHz mono internally),
// so we strip video + recompress to a tiny opus stream entirely in the
// browser before the file ever reaches the upload pipeline. A 930MB/60min
// video shrinks to ~30MB — comfortably under both Supabase's cap and
// Modal's ~250MB body limit, so most uploads skip the Storage detour
// entirely (see LARGE_FILE_THRESHOLD in api.ts).
//
// ffmpeg.wasm is lazy-loaded (only when a file is actually large) so it
// never costs anything for normal mic recordings or small uploads.

const EXTRACT_THRESHOLD = 60 * 1024 * 1024; // 60 MB

export function shouldExtractAudio(file: Blob): boolean {
  return file.size > EXTRACT_THRESHOLD;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ffmpegPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadFFmpeg(): Promise<any> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ffmpeg = new FFmpeg();
      // UMD core (not ESM) — the ESM build's worker uses a runtime `import()`
      // of the blob: core URL, which webpack's bundled Worker script can't
      // resolve ("Cannot find module 'blob:...'"). UMD uses classic
      // importScripts() instead, which isn't intercepted by webpack.
      const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

function extOf(file: Blob): string {
  const type = file.type || "";
  if (type.includes("/")) return "." + type.split("/")[1].split(";")[0];
  return ".bin";
}

// Strips any video track and recompresses to mono 16kHz opus (~64kbps).
// Throws on failure — caller should fall back to uploading the original file.
export async function extractAudioTrack(
  file: Blob,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const ffmpeg = await loadFFmpeg();
  const { fetchFile } = await import("@ffmpeg/util");

  const inName = "input" + extOf(file);
  const outName = "output.ogg";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = ({ progress }: any) => onProgress?.(Math.min(1, Math.max(0, progress)));
  if (onProgress) ffmpeg.on("progress", handler);

  try {
    await ffmpeg.writeFile(inName, await fetchFile(file));
    await ffmpeg.exec(["-i", inName, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "64k", outName]);
    const data = await ffmpeg.readFile(outName);
    return new Blob([new Uint8Array(data as Uint8Array).buffer], { type: "audio/ogg" });
  } finally {
    if (onProgress) ffmpeg.off("progress", handler);
    try { await ffmpeg.deleteFile(inName); } catch {}
    try { await ffmpeg.deleteFile(outName); } catch {}
  }
}
