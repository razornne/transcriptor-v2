"use client";
import { fetchLiveToken, type LiveToken } from "./api";

// Живой транскрипт во время записи: браузер стримит звук прямо в Soniox
// real-time (WebSocket) по временному ключу от /api/live/token — постоянный
// ключ остаётся на сервере. Это ПРЕДПРОСМОТР: финальный транскрипт после Stop
// делает обычный /api/transcribe (batch-модель точнее, есть коррекция и
// словарь), минуты списываются там.
//
// Каналы как в batch-пути (modal_app.transcribe_soniox): при стерео-записи две
// сессии — микрофон без диаризации (владелец = SPEAKER_00) и звонок с
// диаризацией; только микрофон — одна сессия с диаризацией. Эхо собеседника в
// микрофоне (без наушников) отсекаем тем же правилом, что channels.drop_echo.
//
// Звук уходит как WebM/Opus из MediaRecorder (audio_format "auto") — ~32 кбит/с
// на канал вместо 256 кбит/с сырого PCM. Оборвалось соединение → новый ключ,
// новый MediaRecorder (новый WebM-заголовок), таймстемпы сдвигаем на момент
// переподключения; пропавшие секунды живого текста не страшны — их покроет
// финальный транскрипт.

const WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const TIMESLICE_MS = 250;
const MAX_FAILS = 5;           // подряд без единого ответа — сдаёмся (live = off)
const FINISH_WAIT_MS = 4000;   // сколько ждём финальные токены после Stop
const UPDATE_MS = 250;         // не чаще — React перерисовывает весь список

export type LiveStatus = "connecting" | "live" | "reconnecting" | "off";

export type LiveSegment = {
  key: string;
  speaker: string;   // SPEAKER_XX, как в финальном транскрипте
  start: number;     // сек от начала записи
  text: string;      // устоявшиеся (final) слова
  pending: string;   // ещё могут измениться
};

export type LiveOptions = {
  recordingId: string;
  language: string;
  context: string;
  numSpeakers: string;
  mic: MediaStream;
  call: MediaStream | null;
  onUpdate: (segments: LiveSegment[]) => void;
  onStatus: (status: LiveStatus) => void;
};

export type LiveStats = { reconnects: number; words: number; channels: number; status: LiveStatus };

// ── Токены Soniox → слова → реплики (порт soniox.py) ──────────────────────

type Token = { text: string; start_ms?: number; end_ms?: number; speaker?: string; is_final?: boolean };
type Word = { word: string; start: number; end: number; speaker: string; final: boolean };

/** Ведущий пробел в text = начало нового слова; служебные <end>/<fin> пропускаем.
 *  Слово final, только если final все его куски. */
export function tokensToWords(tokens: Token[], offset: number, speakerOf: (t: Token) => string): Word[] {
  const words: Word[] = [];
  let cur: Word | null = null;
  for (const t of tokens) {
    const text = t.text || "";
    if (!text || /^<.+>$/.test(text.trim())) continue;
    const start = offset + (t.start_ms ?? 0) / 1000;
    const end = offset + (t.end_ms ?? t.start_ms ?? 0) / 1000;
    const final = !!t.is_final;
    for (const piece of text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        if (cur) words.push(cur);
        cur = null;
        continue;
      }
      if (!cur) cur = { word: piece, start, end, speaker: speakerOf(t), final };
      else { cur.word += piece; cur.end = end; cur.final = cur.final && final; }
    }
  }
  if (cur) words.push(cur);
  return words;
}

type Seg = { speaker: string; start: number; end: number; words: Word[] };

export function wordsToSegments(words: Word[], maxGapS = 1.0, maxLenS = 30): Seg[] {
  const segs: Seg[] = [];
  for (const w of words) {
    const seg = segs[segs.length - 1];
    const last = seg?.words[seg.words.length - 1]?.word || "";
    const isNew = !seg
      || w.speaker !== seg.speaker
      || w.start - seg.end > maxGapS
      || (seg.end - seg.start > maxLenS && /[.?!…]$/.test(last));
    if (isNew) segs.push({ speaker: w.speaker, start: w.start, end: w.end, words: [w] });
    else { seg.end = w.end; seg.words.push(w); }
  }
  return segs;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Эхо собеседника в микрофоне (без наушников). Слово микрофона — эхо, если
 *  такое же слово есть в канале звонка чуть раньше/одновременно (окно шире,
 *  чем в batch: две сессии стартуют с разницей в доли секунды).
 *  1) как channels.drop_echo: реплика, где эхо >= minShare слов, — целиком;
 *  2) плюс, в отличие от batch: из оставшихся реплик вырезаются фразы эха —
 *     подряд >= 2 совпавших слов (одно расслышанное иначе между ними терпим).
 *     Юзер, говорящий поверх собеседника, склеивается с эхом в одну реплику,
 *     и правило 1 такие куски не ловит. Для предпросмотра лучше потерять
 *     повтор чужих слов, чем показывать чужую фразу как свою. */
export function dropEcho(mic: Seg[], call: Seg[], beforeS = 2.0, afterS = 1.0, minShare = 0.6): Seg[] {
  const index = new Map<string, number[]>();
  for (const s of call) for (const w of s.words) {
    const k = norm(w.word);
    if (k) (index.get(k) ?? index.set(k, []).get(k)!).push(w.start);
  }
  const isEcho = (w: Word) => {
    const k = norm(w.word);
    return !!k && (index.get(k) || []).some((ct) => ct >= w.start - beforeS && ct <= w.start + afterS);
  };
  const out: Seg[] = [];
  for (const s of mic) {
    const flags = s.words.map(isEcho);
    const counted = s.words.filter((w) => norm(w.word)).length;
    if (counted && flags.filter(Boolean).length / counted >= minShare) continue;
    const drop = new Array(flags.length).fill(false);
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      let j = i, hits = 1;
      while (j + 1 < flags.length && (flags[j + 1] || (flags[j + 2] && j + 2 < flags.length))) {
        j += flags[j + 1] ? 1 : 2;
        hits++;
      }
      if (hits >= 2) for (let k = i; k <= j; k++) drop[k] = true;
      i = j;
    }
    const words = s.words.filter((_, i) => !drop[i]);
    if (!words.length) continue;
    out.push({ ...s, words, start: words[0].start, end: words[words.length - 1].end });
  }
  return out;
}

// ── Одна WebSocket-сессия на канал ───────────────────────────────────────

type ChannelSpec = {
  name: "mic" | "call";
  stream: MediaStream;
  diarize: boolean;
  speakerOf: (t: Token) => string;
};

class ChannelSession {
  finals: { tokens: Token[]; offset: number }[] = []; // по одному блоку на подключение
  pending: Token[] = [];
  pendingOffset = 0;
  reconnects = 0;
  state: LiveStatus = "connecting";
  private ws: WebSocket | null = null;
  private rec: MediaRecorder | null = null;
  private fails = 0;
  private stopping = false;
  private finished: (() => void) | null = null;
  private retryTimer = 0;

  constructor(
    private spec: ChannelSpec,
    private getToken: () => Promise<LiveToken | "denied" | null>,
    private t0: number,
    private onChange: () => void,
    private onState: () => void,
  ) {}

  private set(state: LiveStatus) {
    this.state = state;
    this.onState();
  }

  async connect(): Promise<void> {
    if (this.stopping) return;
    const token = await this.getToken();
    if (this.stopping) return;
    if (token === "denied") { this.set("off"); return; }
    if (!token) { this.retry(); return; }

    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    let gotReply = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        api_key: token.api_key,
        model: token.model,
        audio_format: "auto",
        language_hints: token.language_hints,
        enable_language_identification: true,
        enable_speaker_diarization: this.spec.diarize && token.diarize,
        enable_endpoint_detection: true, // реплика становится final сразу после паузы
        ...(token.context ? { context: token.context } : {}),
      }));
      this.set("live"); // Soniox молчит, пока нет речи — «живы» с момента открытия
      const offset = (performance.now() - this.t0) / 1000;
      this.finals.push({ tokens: [], offset });
      this.pendingOffset = offset;
      const rec = new MediaRecorder(this.spec.stream, pickOpus());
      this.rec = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
      rec.onstop = () => { if (ws.readyState === WebSocket.OPEN) ws.send(""); }; // конец потока
      rec.start(TIMESLICE_MS);
    };
    ws.onmessage = (ev) => {
      let data: { tokens?: Token[]; finished?: boolean; error_code?: number; error_message?: string };
      try { data = JSON.parse(ev.data); } catch { return; }
      if (data.error_code) {
        console.warn(`[live:${this.spec.name}] soniox ${data.error_code}: ${data.error_message}`);
        return; // сервер закроет сокет следом → onclose
      }
      if (!gotReply) { gotReply = true; this.fails = 0; }
      const toks = data.tokens || [];
      const block = this.finals[this.finals.length - 1];
      for (const t of toks) if (t.is_final) block.tokens.push(t);
      this.pending = toks.filter((t) => !t.is_final);
      this.onChange();
      if (data.finished) this.finished?.();
    };
    ws.onclose = () => {
      this.stopRecorder();
      this.pending = [];
      this.onChange();
      if (this.stopping) { this.finished?.(); return; }
      if (!gotReply) this.fails++;
      this.reconnects++;
      this.retry();
    };
  }

  private retry() {
    if (this.stopping) return;
    if (this.fails >= MAX_FAILS) { this.set("off"); return; }
    this.set(this.reconnects ? "reconnecting" : "connecting");
    const delay = Math.min(8000, 1000 * 2 ** this.fails);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  private stopRecorder() {
    if (this.rec && this.rec.state !== "inactive") {
      try { this.rec.stop(); } catch {}
    }
    this.rec = null;
  }

  /** Stop: дописываем последний кусок, шлём конец потока и ждём финальные токены. */
  stop(): Promise<void> {
    this.stopping = true;
    window.clearTimeout(this.retryTimer);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) { ws?.close(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const done = () => { window.clearTimeout(timer); this.finished = null; ws.close(); resolve(); };
      const timer = window.setTimeout(done, FINISH_WAIT_MS);
      this.finished = done;
      if (this.rec) this.stopRecorder(); // onstop отправит "" после последнего куска
      else ws.send("");
    });
  }

  words(): Word[] {
    const out: Word[] = [];
    for (const b of this.finals) out.push(...tokensToWords(b.tokens, b.offset, this.spec.speakerOf));
    out.push(...tokensToWords(this.pending, this.pendingOffset, this.spec.speakerOf));
    return out;
  }
}

function pickOpus(): MediaRecorderOptions {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, audioBitsPerSecond: 32000 };
  }
  return { audioBitsPerSecond: 32000 };
}

// ── Живой транскрипт целиком ─────────────────────────────────────────────

export class LiveTranscript {
  private sessions: ChannelSession[] = [];
  private token: Promise<LiveToken | "denied" | null> | null = null;
  private tokenAt = 0;
  private status: LiveStatus = "connecting";
  private updateTimer = 0;
  private stopped = false;
  private diarizeAllowed = true; // Free-план: без разделения, как и финальный транскрипт

  constructor(private opts: LiveOptions) {}

  start(): void {
    const { mic, call, numSpeakers } = this.opts;
    const n = parseInt(numSpeakers, 10) || 0;
    const t0 = performance.now();
    const specs: ChannelSpec[] = call
      ? [
          // Владелец микрофона известен по каналу; в звонке людей больше одного,
          // только если юзер не сказал «2 спикера» (как в batch-пути).
          { name: "mic", stream: mic, diarize: false, speakerOf: () => "SPEAKER_00" },
          { name: "call", stream: call, diarize: n !== 1 && n !== 2, speakerOf: callSpeaker },
        ]
      : [{ name: "mic", stream: mic, diarize: n !== 1, speakerOf: monoSpeaker }];
    this.sessions = specs.map((s) => new ChannelSession(
      s, () => this.getToken(), t0, () => this.scheduleUpdate(), () => this.updateStatus(),
    ));
    this.opts.onStatus("connecting");
    for (const s of this.sessions) void s.connect();
  }

  /** Один ключ на оба канала: живёт 120с и нужен только на открытие сокета. */
  private getToken(): Promise<LiveToken | "denied" | null> {
    if (!this.token || performance.now() - this.tokenAt > 60_000) {
      this.tokenAt = performance.now();
      const { recordingId, language, context } = this.opts;
      this.token = fetchLiveToken({ recording_id: recordingId, language, context });
      void this.token.then((t) => {
        if (!t) this.token = null; // сбой — следующий запрос заново
        else if (t !== "denied") this.diarizeAllowed = t.diarize;
      });
    }
    return this.token;
  }

  private updateStatus() {
    // «Живой», пока жив хоть один канал; off — только когда сдались все.
    const states = this.sessions.map((s) => s.state);
    const next: LiveStatus = (["live", "reconnecting", "connecting"] as const).find((st) => states.includes(st)) ?? "off";
    if (next === this.status) return;
    this.status = next;
    this.opts.onStatus(next);
  }

  private scheduleUpdate() {
    if (this.updateTimer) return;
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = 0;
      this.opts.onUpdate(this.segments());
    }, UPDATE_MS);
  }

  segments(): LiveSegment[] {
    const [first, second] = this.sessions;
    if (!first) return [];
    let mic = wordsToSegments(first.words());
    const call = second ? wordsToSegments(second.words()) : [];
    if (second) mic = dropEcho(mic, call);
    return [...mic.map((s) => toLive(s, "m")), ...call.map((s) => toLive(s, "c"))]
      .map((s) => (this.diarizeAllowed ? s : { ...s, speaker: "SPEAKER_00" }))
      .sort((a, b) => a.start - b.start);
  }

  async stop(): Promise<LiveStats> {
    if (this.stopped) return this.stats();
    this.stopped = true;
    await Promise.all(this.sessions.map((s) => s.stop()));
    window.clearTimeout(this.updateTimer);
    this.updateTimer = 0;
    this.opts.onUpdate(this.segments());
    return this.stats();
  }

  private stats(): LiveStats {
    return {
      reconnects: this.sessions.reduce((n, s) => n + s.reconnects, 0),
      words: this.sessions.reduce((n, s) => n + s.words().length, 0),
      channels: this.sessions.length,
      status: this.status,
    };
  }
}

// Soniox нумерует спикеров "1", "2", … — приводим к SPEAKER_XX финального транскрипта.
function monoSpeaker(t: Token): string {
  const n = parseInt(t.speaker || "1", 10) || 1;
  return `SPEAKER_${String(n - 1).padStart(2, "0")}`;
}
function callSpeaker(t: Token): string {
  const n = parseInt(t.speaker || "1", 10) || 1;
  return `SPEAKER_${String(n).padStart(2, "0")}`; // SPEAKER_00 занят микрофоном
}

function toLive(s: Seg, ch: string): LiveSegment {
  const fin = s.words.filter((w) => w.final).map((w) => w.word).join(" ");
  const pen = s.words.filter((w) => !w.final).map((w) => w.word).join(" ");
  return { key: `${ch}${Math.round(s.start * 10)}`, speaker: s.speaker, start: s.start, text: fin, pending: pen };
}
