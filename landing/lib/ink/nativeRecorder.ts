"use client";
// Запись звонка в приложении: микрофон (L) + звук компьютера (R, WASAPI loopback)
// пишет Rust (desktop/src-tauri/src/recorder.rs) — без «поделиться вкладкой» и
// без разрешений браузера. Возвращает тот же Recorder, что и браузерная запись
// (audio.ts), поэтому дальше работает весь обычный пайплайн страницы:
// загрузка, прогресс, лимиты, словарь, архив.
import { SystemAudioMissingError, type CaptureStats, type Recorder, type StartRecordingOptions } from "./audio";
import { desktopInvoke, desktopListen } from "./desktop";

type Level = { mic: number; sys: number; seconds: number };

// Rust присылает мощность сигнала; страница ждёт RMS (0..1) — для индикатора и «тишины».
const toRms = (power: number) => Math.sqrt(Math.max(0, power || 0)) * 1.09;
const SILENCE_RMS = 0.02;

/** Префикс sessionId: idbDeleteSession("native:<id>") удаляет файлы записи в приложении. */
export const NATIVE_SESSION_PREFIX = "native:";

export async function startNativeRecording(opts: StartRecordingOptions = {}): Promise<Recorder> {
  const started = await desktopInvoke<{ id: string; system_audio: boolean }>("call_start");
  const recordingId = started.id;

  if (!started.system_audio) {
    const proceed = opts.onSystemAudioMissing ? await opts.onSystemAudioMissing() : true;
    if (!proceed) {
      await desktopInvoke("call_stop").catch(() => {});
      await desktopInvoke("call_discard", { id: recordingId }).catch(() => {});
      throw new SystemAudioMissingError();
    }
  }

  let ticks = 0, sumMic = 0, sumSys = 0, silentMic = 0, silentSys = 0;
  const unlisten = await desktopListen<Level>("call-level", ({ payload: p }) => {
    const mic = toRms(p.mic), sys = toRms(p.sys);
    ticks++; sumMic += mic; sumSys += sys;
    if (mic < SILENCE_RMS) silentMic++;
    if (sys < SILENCE_RMS) silentSys++;
    opts.onLevels?.(mic, sys);
  });

  return {
    sessionId: NATIVE_SESSION_PREFIX + recordingId,
    recordingId,
    // Живой транскрипт в приложении не используется (выключен и в вебе).
    liveStreams: { mic: null as unknown as MediaStream, call: null },
    async stop() {
      unlisten();
      const r = await desktopInvoke<{ id: string; seconds: number }>("call_stop");
      const blob = await takeNativeRecording(r.id);
      const stats: CaptureStats = {
        recordingId,
        hasSystemAudio: started.system_audio,
        micDeviceLabel: "",
        rmsMicAvg: ticks ? sumMic / ticks : 0,
        rmsSystemAvg: ticks ? sumSys / ticks : 0,
        silentSecondsMic: silentMic / 10,
        silentSecondsSystem: silentSys / 10,
        trackEndedEvents: 0,
        displaySurface: "desktop-app",
        events: [],
      };
      return { blob, durationSec: r.seconds, stats };
    },
  };
}

/** Ogg записи с диска приложения (сырые байты через IPC). */
export async function takeNativeRecording(id: string): Promise<Blob> {
  const raw = await desktopInvoke<ArrayBuffer | number[]>("call_take", { id });
  const bytes = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
  return new Blob([bytes], { type: "audio/ogg" });
}

/** Неотправленные записи после падения или неудачной транскрипции. */
export async function pendingNativeRecordings(): Promise<{ id: string; seconds: number }[]> {
  try { return await desktopInvoke<{ id: string; seconds: number }[]>("call_pending"); }
  catch { return []; }
}
