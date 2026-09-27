"use strict";

const CONFIG = {
  localCoreBase: "./core",
  ffmpegUmd: "./vendor/ffmpeg.js",
  pcmRate: 3000,
  buckets: 2200,
  storageKey: "live-splicer.edit.v1",
  joinEps: 0.05,
};

const $ = (id) => document.getElementById(id);
const canvas = $("wave");
const ctx = canvas.getContext("2d");
const player = $("player");

const state = {
  ffmpeg: null,
  ready: false,
  running: false,
  file: null,
  inputPath: null,
  duration: 0,
  peak: null,
  bucketDur: 0,
  ranges: [],
  silences: [],
  selection: null,
  drag: null,
  cover: null,
  hasCover: false,
  coverExt: ".jpg",
  embeddedCover: null,
  mounted: false,
  info: {},
  logLines: [],
  probeLines: null,
  urls: [],
  playStop: null,
  abort: null,
  coreBlob: null,
  audio: null,
};

function log(line) {
  state.logLines.push(line);
  if (state.logLines.length > 500) state.logLines.shift();
  const el = $("log");
  el.textContent = state.logLines.join("\n");
  el.scrollTop = el.scrollHeight;
}

function pill(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = "pill" + (cls ? " " + cls : "");
}

function setProgress(p) {
  $("prog").value = Math.max(0, Math.min(1, p || 0));
  $("progText").textContent = p ? Math.round(p * 100) + "%" : "";
}

function failCore(err) {
  log("エラー: " + (err && err.message ? err.message : err));
  pill("coreStatus", "ffmpeg-core: 失敗", "warn");
}

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + s.toFixed(3).padStart(6, "0");
}

function short(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}

function parseTime(s) {
  const raw = String(s || "").trim();
  if (!raw) return NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(":");
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!isFinite(m) || !isFinite(sec)) return NaN;
    return m * 60 + sec;
  }
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const sec = Number(parts[2]);
    if (!isFinite(h) || !isFinite(m) || !isFinite(sec)) return NaN;
    return h * 3600 + m * 60 + sec;
  }
  return NaN;
}

function overlaps(a, b) {
  return a.start < b.end - 0.001 && b.start < a.end - 0.001;
}

function setAudioGrid(codec, sampleRate) {
  const c = String(codec || "");
  const sr = Number(sampleRate) || 0;
  const he = /he-?aac|aac\+|sbr/i.test(c);
  const samples = /aac/i.test(c) && !he && sr ? 1024 : 0;
  state.audio = {
    codec: c,
    sampleRate: sr,
    frameSamples: samples,
    frameDur: samples ? samples / sr : 0,
    snap: samples > 0,
  };
  if (he) log("HE-AAC のためフレームスナップは無効です");
}

function snapTime(t, mode) {
  if (!isFinite(t)) return t;
  const a = state.audio;
  if (!a || !a.snap || !(a.frameDur > 0)) return Math.max(0, t);
  const fd = a.frameDur;
  let n = t / fd;
  if (mode === "floor") n = Math.floor(n + 1e-8);
  else if (mode === "ceil") n = Math.ceil(n - 1e-8);
  else n = Math.round(n);
  let s = n * fd;
  if (s < 0) s = 0;
  if (state.duration && s > state.duration + 1e-6) s = Math.floor(state.duration / fd + 1e-8) * fd;
  return s;
}

function snapRange(start, end) {
  let s = snapTime(start, "round");
  let e = snapTime(end, "round");
  const fd = state.audio && state.audio.frameDur;
  if (fd && !(e > s + fd * 0.5)) e = snapTime(s + fd, "ceil");
  if (state.duration && e > state.duration) e = snapTime(state.duration, "floor");
  if (fd && !(e > s)) s = Math.max(0, snapTime(e - fd, "floor"));
  return { start: s, end: e };
}

function snapAllRanges(reason) {
  if (!state.audio || !state.audio.snap) return 0;
  let n = 0;
  for (const r of state.ranges) {
    const next = snapRange(r.start, r.end);
    if (Math.abs(next.start - r.start) >= 0.0005 || Math.abs(next.end - r.end) >= 0.0005) n++;
    r.start = next.start;
    r.end = next.end;
  }
  if (n && reason) log(`${reason}: ${n} 区間をフレーム境界へスナップしました`);
  return n;
}

function ffTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  return t.toFixed(6);
}

function copyCutArgs(k) {
  const r = snapRange(k.start, k.end);
  return ["-ss", ffTime(r.start), "-t", ffTime(Math.max(0, r.end - r.start))];
}

const dbToAmp = (db) => Math.pow(10, db / 20);

function safeName(s, fallback) {
  const v = (s || "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
  return v || fallback || "track";
}

function trackList() {
  return state.ranges
    .filter((r) => r.mode === "keep" && r.end > r.start)
    .sort((a, b) => a.start - b.start);
}

function mergeRanges(list) {
  const out = [];
  for (const r of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}
