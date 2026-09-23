"use client";
import { idbCreateSession, idbAppendChunk } from "./idb";

// Запись: микрофон + (опционально) аудио вкладки/системы через getDisplayMedia.
// Пишем СТЕРЕО через ChannelMergerNode: L = микрофон, R = звук вкладки/системы.
// Сервер распознаёт каналы раздельно (modal_app._prepare_audio / channels.py).
//
// Микрофон следует за активным устройством системы: надел AirPods — пишем с
// них, убрал в кейс — переключаемся на встроенный/новый. Если выбранный
// микрофон отдаёт абсолютную тишину (так бывает с iPhone, который macOS сама
// подставляет по "Непрерывности"), пробуем остальные и переключаемся на живой.
// Каждое переключение попадает в журнал событий телеметрии (capture_stats.events).
//
// Safety net: каждый 5с-chunk дублируется в IndexedDB (idb.ts). Сессия
// удаляется вызывающим кодом ТОЛЬКО после успешной транскрипции.

export type CaptureEvent =
  | { t: number; type: "mic_switch"; reason: "ended" | "default_changed" | "dead"; from: string; to: string }
  | { t: number; type: "mic_dead"; device: string }
  | { t: number; type: "mic_lost" }
  | { t: number; type: "system_audio_ended" }
  | { t: number; type: "system_audio_silent" };

export type CaptureStats = {
  recordingId: string;
  hasSystemAudio: boolean;
  micDeviceLabel: string;
  rmsMicAvg: number;
  rmsSystemAvg: number;
  silentSecondsMic: number;
  silentSecondsSystem: number;
  trackEndedEvents: number;
  displaySurface: string | null;
  events: CaptureEvent[];
};

export type Recorder = {
  sessionId: string | null;
  recordingId: string;
  stop: () => Promise<{ blob: Blob; durationSec: number; stats: CaptureStats }>;
};

export type StartRecordingOptions = {
  /** Расшаренная вкладка/окно без аудиодорожки. false = отменить запись
   *  (SystemAudioMissingError), true/не задано = писать только микрофон. */
  onSystemAudioMissing?: () => boolean | Promise<boolean>;
  /** Звук вкладки пропал посреди записи ("Stop sharing", закрыли вкладку). */
  onSystemAudioLost?: () => void;
  /** Вкладка расшарена, но за SILENT_WARN_S из неё ни звука, хотя микрофон
   *  слышит речь — скорее всего расшарили не ту вкладку. Один раз за запись. */
  onSystemAudioSilent?: () => void;
  /** Микрофон отдаёт абсолютную тишину, и живого запасного не нашлось. Один раз. */
  onMicDead?: (label: string) => void;
  onMicSwitched?: (label: string, reason: "ended" | "default_changed" | "dead") => void;
  /** RMS-уровень (0..1) микрофона и звука вкладки, ~каждые 100мс. */
  onLevels?: (micLevel: number, systemLevel: number) => void;
};

export class SystemAudioMissingError extends Error {
  constructor() {
    super("Recording cancelled — shared tab/window had no audio track");
    this.name = "SystemAudioMissingError";
  }
}

const SILENCE_RMS = 0.02;
const LEVELS_INTERVAL_MS = 100;
const SILENT_WARN_S = 60;
// Живой микрофон даже в тихой комнате шумит на -70..-90 dBFS (3e-5..3e-4);
// ниже -100 dBFS (1e-5) — цифровая тишина мёртвого устройства.
const DEAD_RMS = 1e-5;
const LIVE_RMS = 3e-5;
const DEAD_MIC_S = 6;
const DEAD_RECHECK_S = 30;

// Float-данные, а не байтовые: 8-битная выборка округляет тихий, но живой
// микрофон до нуля, и его не отличить от мёртвого.
function rms(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export async function startRecording(opts: StartRecordingOptions = {}): Promise<Recorder> {
  const recordingId = crypto.randomUUID();
  let mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const initialMicLabel = mic.getAudioTracks()[0]?.label || "";

  let display: MediaStream | null = null;
  let displaySurface: string | null = null;
  try {
    const shared = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    const videoTrack = shared.getVideoTracks()[0];
    displaySurface = (videoTrack?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface ?? null;
    shared.getVideoTracks().forEach((t) => t.stop()); // видео не нужно, аудио-трек продолжает жить

    if (shared.getAudioTracks().length === 0) {
      shared.getTracks().forEach((t) => t.stop());
      const proceed = opts.onSystemAudioMissing ? await opts.onSystemAudioMissing() : true;
      if (!proceed) {
        mic.getTracks().forEach((t) => t.stop());
        throw new SystemAudioMissingError();
      }
    } else {
      display = shared;
    }
  } catch (e) {
    if (e instanceof SystemAudioMissingError) throw e;
    display = null; // юзер отказал в share — пишем только микрофон, это не ошибка
  }

  const ctx = new AudioContext();
  const merger = ctx.createChannelMerger(2);
  const dest = ctx.createMediaStreamDestination();
  merger.connect(dest);

  let micSource = ctx.createMediaStreamSource(mic);
  const micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 1024;
  const micBuf = new Float32Array(micAnalyser.fftSize);
  micSource.connect(merger, 0, 0); // L = микрофон
  micSource.connect(micAnalyser);

  let sysAnalyser: AnalyserNode | null = null;
  let sysBuf: Float32Array<ArrayBuffer> | null = null;
  if (display) {
    const sysSource = ctx.createMediaStreamSource(display);
    sysAnalyser = ctx.createAnalyser();
    sysAnalyser.fftSize = 1024;
    sysBuf = new Float32Array(sysAnalyser.fftSize);
    sysSource.connect(merger, 0, 1); // R = звук вкладки/системы
    sysSource.connect(sysAnalyser);
  }

  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 100) / 10;
  const events: CaptureEvent[] = [];
  let stopped = false;
  let trackEndedEvents = 0;
  const deadGroups = new Set<string>(); // устройства, отдавшие цифровую тишину

  // ── Микрофон: переключение устройства ─────────────────────────────────
  let switching = false;
  async function switchMic(reason: "ended" | "default_changed" | "dead", deviceId?: string) {
    if (switching || stopped) return;
    switching = true;
    const from = mic.getAudioTracks()[0]?.label || "";
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      if (stopped) { fresh.getTracks().forEach((t) => t.stop()); return; }
      const old = mic;
      mic = fresh;
      micSource.disconnect();
      micSource = ctx.createMediaStreamSource(mic);
      micSource.connect(merger, 0, 0);
      micSource.connect(micAnalyser);
      old.getTracks().forEach((t) => t.stop()); // stop() не диспатчит "ended"
      watchMicTrack(fresh.getAudioTracks()[0]);
      const to = fresh.getAudioTracks()[0]?.label || "";
      events.push({ t: elapsed(), type: "mic_switch", reason, from, to });
      opts.onMicSwitched?.(to, reason);
    } catch {
      events.push({ t: elapsed(), type: "mic_lost" });
    } finally {
      switching = false;
    }
  }

  function watchMicTrack(track: MediaStreamTrack | undefined) {
    track?.addEventListener("ended", () => {
      trackEndedEvents++;
      void switchMic("ended");
    });
  }
  watchMicTrack(mic.getAudioTracks()[0]);

  // Chrome/Edge отдают псевдо-устройство "default" с groupId реального
  // устройства — сравниваем с тем, что пишем сейчас. Firefox/Safari его не
  // отдают: там ловим только пропажу текущего устройства. Мёртвое устройство
  // по умолчанию игнорируем, иначе вернёмся на него после переключения.
  async function onDeviceChange() {
    if (stopped) return;
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      const current = mic.getAudioTracks()[0]?.getSettings() ?? {};
      const def = inputs.find((d) => d.deviceId === "default");
      if (def) {
        if (def.groupId && current.groupId && def.groupId !== current.groupId && !deadGroups.has(def.groupId)) {
          void switchMic("default_changed");
        }
      } else if (current.deviceId && !inputs.some((d) => d.deviceId === current.deviceId)) {
        void switchMic("ended");
      }
    } catch {}
  }
  navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);

  // Слушаем кандидата ~0.7с: есть ли вообще сигнал (шум тихой комнаты — уже сигнал).
  async function probe(deviceId: string): Promise<number> {
    let s: MediaStream | null = null;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      const src = ctx.createMediaStreamSource(s);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 120));
        peak = Math.max(peak, rms(an, buf));
      }
      src.disconnect();
      return peak;
    } catch {
      return 0;
    } finally {
      s?.getTracks().forEach((t) => t.stop());
    }
  }

  let deadWarned = false;
  async function handleDeadMic() {
    const track = mic.getAudioTracks()[0];
    const settings = track?.getSettings() ?? {};
    if (settings.groupId) deadGroups.add(settings.groupId);
    events.push({ t: elapsed(), type: "mic_dead", device: track?.label || "" });
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications"
        && !deadGroups.has(d.groupId),
    );
    for (const cand of inputs) {
      if (stopped) return;
      if (await probe(cand.deviceId) > LIVE_RMS) {
        await switchMic("dead", cand.deviceId);
        return;
      }
      deadGroups.add(cand.groupId);
    }
    if (!deadWarned) {
      deadWarned = true;
      opts.onMicDead?.(track?.label || "");
    }
  }

  display?.getAudioTracks()[0]?.addEventListener("ended", () => {
    trackEndedEvents++;
    events.push({ t: elapsed(), type: "system_audio_ended" });
    opts.onSystemAudioLost?.();
  });

  // ── Уровни + телеметрия ──────────────────────────────────────────────
  // В фоновой вкладке Chrome троттлит таймеры до ~1/сек, поэтому секунды
  // тишины считаем как ДОЛЮ тихих замеров от длительности, а не count×100мс.
  let rmsMicSum = 0, rmsSysSum = 0, sampleCount = 0;
  let silentMicSamples = 0, silentSysSamples = 0;
  let micHeardSpeech = false, sysEverHeard = false, silentWarned = false;
  let deadSince: number | null = null;
  let nextDeadCheck = 0;
  let deadHandling = false;

  const levelTimer = window.setInterval(() => {
    const micLevel = rms(micAnalyser, micBuf);
    const sysLevel = sysAnalyser && sysBuf ? rms(sysAnalyser, sysBuf) : 0;
    sampleCount++;
    rmsMicSum += micLevel;
    if (micLevel < SILENCE_RMS) silentMicSamples++; else micHeardSpeech = true;

    const now = Date.now();
    deadSince = micLevel < DEAD_RMS ? (deadSince ?? now) : null;
    if (deadSince !== null && !deadHandling && !switching && now >= nextDeadCheck
        && now - deadSince >= DEAD_MIC_S * 1000) {
      deadHandling = true;
      void handleDeadMic().finally(() => {
        deadHandling = false;
        deadSince = null;
        nextDeadCheck = Date.now() + DEAD_RECHECK_S * 1000;
      });
    }

    if (sysAnalyser) {
      rmsSysSum += sysLevel;
      if (sysLevel < SILENCE_RMS) silentSysSamples++; else sysEverHeard = true;
      if (!silentWarned && !sysEverHeard && micHeardSpeech && elapsed() >= SILENT_WARN_S) {
        silentWarned = true;
        events.push({ t: elapsed(), type: "system_audio_silent" });
        opts.onSystemAudioSilent?.();
      }
    }
    opts.onLevels?.(micLevel, sysLevel);
  }, LEVELS_INTERVAL_MS);

  const sessionId = await idbCreateSession();
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(dest.stream);
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      if (sessionId) void idbAppendChunk(sessionId, e.data);
    }
  };
  rec.start(5000); // timeslice: каждый кусок сразу в память + IndexedDB

  return {
    sessionId,
    recordingId,
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          stopped = true;
          window.clearInterval(levelTimer);
          navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
          mic.getTracks().forEach((t) => t.stop());
          display?.getTracks().forEach((t) => t.stop());
          void ctx.close().catch(() => {});
          const durationSec = (Date.now() - startedAt) / 1000;
          const share = (n: number) => (sampleCount ? (n / sampleCount) * durationSec : 0);
          resolve({
            blob: new Blob(chunks, { type: "audio/webm" }),
            durationSec,
            stats: {
              recordingId,
              hasSystemAudio: !!display,
              micDeviceLabel: initialMicLabel,
              rmsMicAvg: sampleCount ? rmsMicSum / sampleCount : 0,
              rmsSystemAvg: sampleCount ? rmsSysSum / sampleCount : 0,
              silentSecondsMic: share(silentMicSamples),
              silentSecondsSystem: display ? share(silentSysSamples) : 0,
              trackEndedEvents,
              displaySurface,
              events,
            },
          });
        };
        rec.stop();
      }),
  };
}

// Длительность загруженного файла через скрытый media-элемент (как в /app)
export function probeDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("video") ? "video" : "audio");
    const done = (d: number) => { URL.revokeObjectURL(url); resolve(d); };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => done(0);
    el.src = url;
    window.setTimeout(() => done(0), 7000);
  });
}
