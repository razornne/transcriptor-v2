"use client";
import { idbCreateSession, idbAppendChunk } from "./idb";

// Запись: микрофон + (опционально) аудио вкладки/системы через getDisplayMedia,
// смикшированные AudioContext'ом — порт схемы из боевого /app. Если юзер
// отказал в share — пишем только микрофон, это не ошибка.
//
// Safety net: каждый 5с-chunk дублируется в IndexedDB (idb.ts). Сессия
// удаляется вызывающим кодом ТОЛЬКО после успешной транскрипции.

export type Recorder = {
  sessionId: string | null;
  stop: () => Promise<{ blob: Blob; durationSec: number }>;
};

export async function startRecording(): Promise<Recorder> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });

  let display: MediaStream | null = null;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    // Видео не нужно — глушим сразу, аудио-трек продолжает жить
    display.getVideoTracks().forEach((t) => t.stop());
    if (display.getAudioTracks().length === 0) {
      display.getTracks().forEach((t) => t.stop());
      display = null;
    }
  } catch {
    display = null; // юзер отказал — пишем только микрофон
  }

  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(mic).connect(dest);
  if (display) ctx.createMediaStreamSource(display).connect(dest);

  const sessionId = await idbCreateSession();
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(dest.stream);
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      if (sessionId) void idbAppendChunk(sessionId, e.data);
    }
  };
  const startedAt = Date.now();
  rec.start(5000); // timeslice: каждый кусок сразу в память + IndexedDB

  return {
    sessionId,
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          mic.getTracks().forEach((t) => t.stop());
          display?.getTracks().forEach((t) => t.stop());
          void ctx.close().catch(() => {});
          resolve({
            blob: new Blob(chunks, { type: "audio/webm" }),
            durationSec: (Date.now() - startedAt) / 1000,
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
