"use client";

// Keep-alive набор для долгих записей в фоновой вкладке (порт из /app):
// • Wake Lock — экран не гаснет (re-acquire при возврате видимости)
// • Silent audio — OscillatorNode gain≈0, браузер не дискардит вкладку
// • OS-нотификации — started / ready / failed
// • Battery warning — предупреждение перед стартом на низком заряде

type WakeLockSentinel = { release: () => Promise<void> } | null;

export async function startKeepAlive(): Promise<() => void> {
  let lock: WakeLockSentinel = null;
  let ctx: AudioContext | null = null;
  let stopped = false;

  const acquire = async () => {
    try {
      const wl = (navigator as unknown as {
        wakeLock?: { request: (t: string) => Promise<WakeLockSentinel> };
      }).wakeLock;
      if (wl && document.visibilityState === "visible") lock = await wl.request("screen");
    } catch { /* не критично */ }
  };
  const onVis = () => { if (!stopped && document.visibilityState === "visible") void acquire(); };

  await acquire();
  document.addEventListener("visibilitychange", onVis);

  try {
    ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
  } catch { ctx = null; }

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVis);
    void lock?.release().catch(() => {});
    void ctx?.close().catch(() => {});
  };
}

export function ensureNotifyPermission(): void {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch { /* ignore */ }
}

export function notify(title: string, body: string): void {
  try {
    if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
      new Notification(title, { body });
    }
  } catch { /* ignore */ }
}

// null = ок стартовать; строка = текст предупреждения (юзер подтверждает)
export async function batteryWarning(): Promise<string | null> {
  try {
    const getBattery = (navigator as unknown as {
      getBattery?: () => Promise<{ charging: boolean; level: number }>;
    }).getBattery;
    if (!getBattery) return null;
    const b = await getBattery.call(navigator);
    if (!b.charging && b.level < 0.4) {
      return `Battery is at ${Math.round(b.level * 100)}% and not charging. A long recording may not survive — continue?`;
    }
    return null;
  } catch {
    return null;
  }
}
