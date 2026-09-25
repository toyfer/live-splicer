"use strict";

const CONFIG = {
  coreSource: "cdn",
  localCoreBase: "./core",
  cdnCoreBase: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd",
  ffmpegUmd: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js",
  utilUmd: "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/umd/index.js",
  pcmRate: 3000,
  buckets: 2200,
  storageKey: "live-splicer.edit.v1",
};

const $ = (id) => document.getElementById(id);
const canvas = $("wave");
const ctx = canvas.getContext("2d");
const player = $("player");

const state = {
  ffmpeg: null,
  util: null,
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
  mounted: false,
  info: {},
  logLines: [],
  probeLines: null,
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
  pill("probeStatus", "解析: 失敗", "warn");
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

function parseTime(v) {
  const s = String(v).trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const dbToAmp = (db) => Math.pow(10, db / 20);

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("スクリプトを読み込めません: " + src));
    document.head.appendChild(s);
  });
}

async function blobFrom(url, mime, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(label + " を取得できません (" + resp.status + ")");
  const total = Number(resp.headers.get("content-length") || 0);
  if (mime === "application/wasm" && total > 0 && total < 1000000) {
    throw new Error("ffmpeg-core.wasm が小さすぎます (" + total + " bytes)");
  }
  pill("coreStatus", label + " を取得中…", "warn");
  return state.util.toBlobURL(url, mime, true, ({ received, total: t }) => {
    if (!t || t < 0) return;
    const p = received / t;
    setProgress(p);
    pill("coreStatus", label + ": " + Math.round(p * 100) + "%", "warn");
    $("progText").textContent = (received / 1048576).toFixed(1) + " / " + (t / 1048576).toFixed(1) + " MB";
  });
}

async function ensureFfmpeg() {
  if (state.ready) return;
  pill("coreStatus", "ffmpeg.wasm を読み込み中…", "warn");
  log("ffmpeg.wasm を読み込みます");
  await loadScript(CONFIG.ffmpegUmd);
  await loadScript(CONFIG.utilUmd);
  const FFmpeg = (window.FFmpegWASM || window.ffmpegWASM || {}).FFmpeg;
  const util = window.FFmpegUtil || {};
  if (!FFmpeg || !util.toBlobURL) throw new Error("ffmpeg.wasm の UMD ビルドが見つかりません");
  state.util = util;

  const ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    if (state.probeLines) state.probeLines.push(message);
    log(message);
  });
  ffmpeg.on("progress", ({ progress }) => setProgress(progress));

  const base = CONFIG.cdnCoreBase;
  log("ffmpeg-core を CDN から取得します（約 31MB）。初回だけ時間がかかります");
  const coreURL = await blobFrom(base + "/ffmpeg-core.js", "text/javascript", "core.js");
  const wasmURL = await blobFrom(base + "/ffmpeg-core.wasm", "application/wasm", "core.wasm");
  pill("coreStatus", "ffmpeg-core を起動中…", "warn");
  await Promise.race([
    ffmpeg.load({ coreURL, wasmURL }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("ffmpeg-core の起動が 3 分以内に終わりませんでした")), 180000)),
  ]);
  state.ffmpeg = ffmpeg;
  state.ready = true;
  pill("coreStatus", "ffmpeg-core: 準備完了", "ok");
  log("ffmpeg-core の読み込みが完了しました");
}

async function attachInput() {
  if (state.inputPath) return state.inputPath;
  const f = state.file;
  if (typeof state.ffmpeg.mount === "function") {
    try {
      if (state.mounted) {
        await state.ffmpeg.unmount("/mnt").catch(() => {});
        state.mounted = false;
      }
      await state.ffmpeg.mount("WORKERFS", { files: [f] }, "/mnt");
      state.mounted = true;
      state.inputPath = "/mnt/" + f.name;
      log("WORKERFS でファイルをマウントしました（メモリに読み込まずに処理します）");
      return state.inputPath;
    } catch (e) {
      log("WORKERFS を利用できないためメモリ経由に切り替えます: " + e.message);
    }
  }
  log("ファイルをメモリへ読み込みます: " + f.name);
  await state.ffmpeg.writeFile(f.name, new Uint8Array(await f.arrayBuffer()));
  state.inputPath = f.name;
  return state.inputPath;
}

async function probe() {
  state.probeLines = [];
  await state.ffmpeg.exec(["-hide_banner", "-i", state.inputPath]).catch(() => {});
  const text = state.probeLines.join("\n");
  state.probeLines = null;

  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (d) state.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const a = text.match(/Audio:\s*([^,\n]+),\s*(\d+)\s*Hz,\s*([^,\n]+)/);
  if (a) state.info.audio = `${a[1].trim()} / ${a[2]} Hz / ${a[3].trim()}`;
  state.hasCover = /Stream #0:\d+.*Video:/.test(text);
  state.info.cover = state.hasCover ? "あり（元ファイルの画像を引き継ぎます）" : "なし";
  log(`解析結果: 長さ ${fmt(state.duration)} / 音声 ${state.info.audio || "不明"} / 画像 ${state.info.cover}`);
}

function wavData(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const size = dv.getUint32(o + 4, true);
    if (id === "data") return { offset: o + 8, length: Math.min(size, bytes.byteLength - o - 8) };
    o += 8 + size + (size % 2);
  }
  throw new Error("WAV の data チャンクが見つかりません");
}

async function buildWaveform() {
  await state.ffmpeg.exec([
    "-hide_banner", "-i", state.inputPath,
    "-map", "0:a:0", "-ac", "1", "-ar", String(CONFIG.pcmRate),
    "-c:a", "pcm_s16le", "-y", "wave.wav",
  ]);
  const bytes = await state.ffmpeg.readFile("wave.wav");
  await state.ffmpeg.deleteFile("wave.wav").catch(() => {});

  const { offset, length } = wavData(bytes);
  const count = length >> 1;
  const buf = bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + count * 2);
  const samples = new Int16Array(buf);

  const n = CONFIG.buckets;
  const peak = new Float32Array(n);
  const per = samples.length / n;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * per);
    const b = Math.min(samples.length, Math.floor((i + 1) * per));
    let p = 0;
    for (let j = a; j < b; j++) {
      const v = samples[j] < 0 ? -samples[j] : samples[j];
      if (v > p) p = v;
    }
    peak[i] = p / 32768;
  }
  state.peak = peak;
  state.duration = count / CONFIG.pcmRate;
  state.bucketDur = per / CONFIG.pcmRate;
  log(`波形を生成しました（${CONFIG.pcmRate} Hz モノラル / ${n} バケット / 長さ ${fmt(state.duration)}）`);
}

function tickStep(d) {
  const steps = [10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (d / s <= 12) return s;
  return 3600;
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 280;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, w, h);

  const dur = state.duration || 1;
  const X = (t) => (t / dur) * w;
  const mid = h / 2;

  ctx.strokeStyle = "#232936";
  ctx.lineWidth = 1;
  const step = tickStep(dur);
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  for (let t = 0; t <= dur; t += step) {
    const x = Math.round(X(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillText(short(t), x + 4, h - 6);
  }

  if (state.silences.length) {
    ctx.fillStyle = "rgba(100,116,139,.28)";
    for (const s of state.silences) ctx.fillRect(X(s.start), 0, Math.max(1, X(s.end) - X(s.start)), h);
  }

  const keeps = keepRanges();
  ctx.fillStyle = "rgba(74,222,128,.12)";
  for (const k of keeps) ctx.fillRect(X(k.start), 0, Math.max(1, X(k.end) - X(k.start)), h);
  ctx.fillStyle = "rgba(248,113,113,.16)";
  for (const r of state.ranges) {
    if (r.mode !== "cut") continue;
    ctx.fillRect(X(r.start), 0, Math.max(1, X(r.end) - X(r.start)), h);
  }

  if (state.peak) {
    const n = state.peak.length;
    const bw = w / n;
    ctx.fillStyle = "#38bdf8";
    for (let i = 0; i < n; i++) {
      const a = state.peak[i] * (h / 2 - 8);
      ctx.fillRect(i * bw, mid - a, Math.max(bw, 0.6), Math.max(a * 2, 1));
    }
  } else {
    ctx.fillStyle = "#64748b";
    ctx.fillText("音源を読み込むと波形が表示されます", 12, mid);
  }

  ctx.fillStyle = "rgba(255,255,255,.10)";
  ctx.fillRect(0, mid - 0.5, w, 1);

  if (state.selection) {
    ctx.strokeStyle = "#f8fafc";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(X(state.selection.start) + 0.5, 0.5, X(state.selection.end) - X(state.selection.start), h - 1);
  }

  const ct = player.currentTime || 0;
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(X(ct), 0);
  ctx.lineTo(X(ct), h);
  ctx.stroke();
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

function keepRanges() {
  const dur = state.duration || 0;
  const keeps = state.ranges.filter((r) => r.mode === "keep" && r.end > r.start);
  if (keeps.length) return mergeRanges(keeps).map((r) => ({ start: Math.max(0, r.start), end: Math.min(dur, r.end) }));
  const cuts = mergeRanges(state.ranges.filter((r) => r.mode === "cut" && r.end > r.start));
  if (!cuts.length) return dur ? [{ start: 0, end: dur }] : [];
  const out = [];
  let cur = 0;
  for (const c of cuts) {
    if (c.start - cur > 0.05) out.push({ start: cur, end: Math.min(c.start, dur) });
    cur = Math.max(cur, c.end);
  }
  if (dur - cur > 0.05) out.push({ start: cur, end: dur });
  return out;
}

function renderRanges() {
  const keeps = keepRanges();
  const total = keeps.reduce((n, k) => n + (k.end - k.start), 0);
  $("keepSummary").textContent = keeps.length
    ? `出力される区間: ${keeps.length} 本 / 合計 ${fmt(total)}（元 ${fmt(state.duration)} → 約 ${(100 * total / (state.duration || 1)).toFixed(1)}%）`
    : "出力される区間がありません";

  const rows = ["<thead><tr><th>種別</th><th>開始</th><th>終了</th><th>長さ</th><th>操作</th></tr></thead><tbody>"];
  state.ranges
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.start - b.r.start)
    .forEach(({ r, i }) => {
      rows.push(
        `<tr><td><span class="tag ${r.mode}">${r.mode === "cut" ? "カット" : "残す"}</span></td>` +
        `<td class="num">${fmt(r.start)}</td><td class="num">${fmt(r.end)}</td>` +
        `<td class="num">${(r.end - r.start).toFixed(3)} 秒</td>` +
        `<td><button data-play="${i}">試聴</button> <button data-del="${i}">削除</button></td></tr>`
      );
    });
  rows.push("</tbody>");
  $("ranges").innerHTML = rows.join("");
}

function addRange(mode, start, end) {
  if (!(end > start)) return;
  state.ranges.push({ mode, start: Math.max(0, start), end: Math.min(state.duration, end) });
  renderRanges();
  render();
  saveLocal();
}

function detectSilences() {
  if (!state.peak) return;
  const thr = dbToAmp(Number($("silThr").value));
  const minB = Math.max(1, Math.round(Number($("silMin").value) / state.bucketDur));
  const runs = [];
  let start = -1;
  for (let i = 0; i <= state.peak.length; i++) {
    const quiet = i < state.peak.length && state.peak[i] <= thr;
    if (quiet) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minB) runs.push({ start: start * state.bucketDur, end: i * state.bucketDur });
      start = -1;
    }
  }
  state.silences = runs;
  log(`無音区間を ${runs.length} 件検出しました（しきい値 ${$("silThr").value} dB / 最短 ${$("silMin").value} 秒）`);
  renderRanges();
  render();
}

function coverName() {
  if (!state.cover) return null;
  const ext = (state.cover.name.match(/\.[A-Za-z0-9]+$/) || [".jpg"])[0];
  return "cover" + ext.toLowerCase();
}

function metaArgs() {
  const args = [];
  document.querySelectorAll("[data-tag]").forEach((el) => {
    const v = el.value.trim();
    if (v) args.push("-metadata", `${el.dataset.tag}=${v}`);
  });
  return args;
}

function outputArgs(coverIndex) {
  const args = [];
  if (coverIndex != null) {
    args.push("-map", `${coverIndex}:v:0`, "-c:v", "copy", "-disposition:v:0", "attached_pic");
  }
  args.push(...metaArgs());
  args.push("-movflags", "+faststart", "-y");
  return args;
}

function modeArgs() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const bitrate = $("bitrate").value;
  return { mode, bitrate };
}

async function runGapless(keeps, outName) {
  const { bitrate } = modeArgs();
  const useX = $("xuse").checked;
  let cf = Math.max(0, Number($("xfade").value) / 1000);
  const minLen = keeps.reduce((m, k) => Math.min(m, k.end - k.start), Infinity);
  if (cf > 0 && cf * 2 > minLen) {
    log(`最短区間が ${minLen.toFixed(2)} 秒のためクロスフェードを無効化します`);
    cf = 0;
  }

  let filter = keeps
    .map((k, i) => `[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=N/SR/TB[a${i}]`)
    .join(";");

  if (keeps.length === 1) {
    filter = filter.replace(/\[a0\]$/, "[out]");
  } else if (useX && cf > 0) {
    let node = "a0";
    for (let i = 1; i < keeps.length; i++) {
      const label = i === keeps.length - 1 ? "out" : `x${i}`;
      filter += `;[${node}][a${i}]acrossfade=d=${cf}:c1=tri:c2=tri[${label}]`;
      node = label;
    }
    log(`結合部 ${keeps.length - 1} か所に ${(cf * 1000).toFixed(0)} ms のクロスフェードを適用します`);
  } else {
    filter += ";" + keeps.map((_, i) => `[a${i}]`).join("") + `concat=n=${keeps.length}:v=0:a=1[out]`;
  }

  const args = ["-hide_banner", "-i", state.inputPath];
  if (state.cover) args.push("-i", coverName());
  args.push("-filter_complex", filter, "-map", "[out]");
  args.push(...outputArgs(state.cover ? 1 : state.hasCover ? 0 : null));
  args.push("-c:a", "aac", "-b:a", `${bitrate}k`, outName);
  return state.ffmpeg.exec(args);
}

async function runLossless(keeps, outName) {
  const segs = [];
  for (let i = 0; i < keeps.length; i++) {
    const k = keeps[i];
    const seg = `seg${i}.m4a`;
    segs.push(seg);
    await state.ffmpeg.exec([
      "-hide_banner", "-i", state.inputPath,
      "-ss", k.start.toFixed(3), "-t", (k.end - k.start).toFixed(3),
      "-map", "0:a:0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-y", seg,
    ]);
  }
  await state.ffmpeg.writeFile("list.txt", segs.map((s) => `file '${s}'`).join("\n"));
  await state.ffmpeg.exec(["-hide_banner", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-y", "joined.m4a"]);

  const args = ["-hide_banner", "-i", "joined.m4a", "-i", state.inputPath];
  if (state.cover) args.push("-i", coverName());
  args.push("-map", "0:a:0");
  args.push(...outputArgs(state.cover ? 2 : state.hasCover ? 1 : null));
  args.push("-c:a", "copy", outName);
  const code = await state.ffmpeg.exec(args);

  for (const s of segs) await state.ffmpeg.deleteFile(s).catch(() => {});
  await state.ffmpeg.deleteFile("list.txt").catch(() => {});
  await state.ffmpeg.deleteFile("joined.m4a").catch(() => {});
  return code;
}

async function readTags() {
  await state.ffmpeg.exec(["-hide_banner", "-i", state.inputPath, "-f", "ffmetadata", "-y", "tags.txt"]);
  const bytes = await state.ffmpeg.readFile("tags.txt");
  await state.ffmpeg.deleteFile("tags.txt").catch(() => {});
  const text = new TextDecoder().decode(bytes);
  let n = 0;
  text.split("\n").forEach((line) => {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (!m) return;
    const el = document.querySelector(`[data-tag="${m[1]}"]`);
    if (el && !el.value.trim()) {
      el.value = m[2];
      n++;
    }
  });
  log(`ffmpeg が解釈できるタグを ${n} 件読み込みました（空欄のみ埋めています）`);
}

async function run() {
  if (state.running) return;
  if (!state.ready) await ensureFfmpeg();
  if (!state.file) throw new Error("音源を選択してください");
  const keeps = keepRanges();
  if (!keeps.length) throw new Error("出力する区間がありません");

  const outName = ($("outName").value.trim() || "live-spliced.m4a").replace(/[^\w.\-]/g, "_");
  const { mode } = modeArgs();
  state.running = true;
  $("btnRun").disabled = true;
  $("btnCancel").disabled = false;
  $("result").innerHTML = "";
  setProgress(0);

  try {
    await attachInput();
    if (state.cover) {
      await state.ffmpeg.writeFile(coverName(), new Uint8Array(await state.cover.arrayBuffer()));
    }
    log(`書き出し開始: ${mode === "gapless" ? "ギャップレス（AAC 再エンコード）" : "無劣化（-c copy）"} / 区間 ${keeps.length} 本`);
    const code = mode === "gapless" ? await runGapless(keeps, outName) : await runLossless(keeps, outName);
    if (code !== 0) throw new Error("ffmpeg が異常終了しました（exit code " + code + "）");

    const data = await state.ffmpeg.readFile(outName);
    const blob = new Blob([data.buffer], { type: "audio/mp4" });
    const url = URL.createObjectURL(blob);
    const mb = (blob.size / 1048576).toFixed(1);
    $("result").innerHTML =
      `<p><b>完成:</b> ${outName}（${mb} MB）</p>` +
      `<p><a href="${url}" download="${outName}">${outName} をダウンロード</a>　` +
      `<a href="${url}" target="_blank" rel="noopener">ブラウザで再生して確認</a></p>`;
    log(`書き出し完了: ${outName}（${mb} MB）`);
    setProgress(1);
    await state.ffmpeg.deleteFile(outName).catch(() => {});
    if (state.cover) await state.ffmpeg.deleteFile(coverName()).catch(() => {});
  } finally {
    state.running = false;
    $("btnRun").disabled = false;
    $("btnCancel").disabled = true;
  }
}

function editJson() {
  return {
    app: "live-splicer",
    version: 1,
    source: { name: state.file ? state.file.name : null, size: state.file ? state.file.size : null, duration: state.duration },
    ranges: state.ranges,
    settings: {
      mode: document.querySelector('input[name="mode"]:checked').value,
      bitrate: Number($("bitrate").value),
      crossfadeMs: Number($("xfade").value),
      useCrossfade: $("xuse").checked,
      outName: $("outName").value,
      silThr: Number($("silThr").value),
      silMin: Number($("silMin").value),
      silPad: Number($("silPad").value),
    },
    meta: Object.fromEntries([...document.querySelectorAll("[data-tag]")].map((el) => [el.dataset.tag, el.value])),
  };
}

function applyJson(o) {
  if (!o || o.app !== "live-splicer") throw new Error("このアプリの JSON ではありません");
  state.ranges = (o.ranges || []).map((r) => ({ mode: r.mode, start: Number(r.start), end: Number(r.end) }));
  const s = o.settings || {};
  if (s.mode) document.querySelector(`input[name="mode"][value="${s.mode}"]`).checked = true;
  if (s.bitrate) $("bitrate").value = String(s.bitrate);
  if (s.crossfadeMs != null) $("xfade").value = String(s.crossfadeMs);
  if (s.useCrossfade != null) $("xuse").checked = !!s.useCrossfade;
  if (s.outName) $("outName").value = s.outName;
  if (s.silThr != null) $("silThr").value = String(s.silThr);
  if (s.silMin != null) $("silMin").value = String(s.silMin);
  if (s.silPad != null) $("silPad").value = String(s.silPad);
  for (const [k, v] of Object.entries(o.meta || {})) {
    const el = document.querySelector(`[data-tag="${k}"]`);
    if (el) el.value = v || "";
  }
  renderRanges();
  render();
  log(`JSON を読み込みました（区間 ${state.ranges.length} 本）`);
}

function saveLocal() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(editJson()));
    $("jsonInfo").textContent = "自動保存済み " + new Date().toLocaleTimeString();
  } catch (e) {
    /* quota */
  }
}

function restoreLocal() {
  const raw = localStorage.getItem(CONFIG.storageKey);
  if (!raw) throw new Error("自動保存されたデータがありません");
  applyJson(JSON.parse(raw));
}

function bind() {
  $("btnLoad").addEventListener("click", () => ensureFfmpeg().catch(failCore));

  $("file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    state.file = f;
    state.inputPath = null;
    state.peak = null;
    state.silences = [];
    state.ranges = [];
    $("fileInfo").textContent = `${f.name}（${(f.size / 1048576).toFixed(1)} MB）`;
    player.src = URL.createObjectURL(f);
    $("outName").value = f.name.replace(/\.[^.]+$/, "") + "-spliced.m4a";
    renderRanges();
    render();
    try {
      await ensureFfmpeg();
      await attachInput();
      await probe();
      await buildWaveform();
      await readTags();
      await detectSilences();
      pill("probeStatus", `解析: ${fmt(state.duration)} / ${state.info.audio || ""}`, "ok");
      renderRanges();
      render();
    } catch (err) {
      failCore(err);
    }
  });

  const xOf = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
  };
  const tOf = (px) => (px / canvas.getBoundingClientRect().width) * state.duration;

  canvas.addEventListener("pointerdown", (ev) => {
    if (!state.duration) return;
    canvas.setPointerCapture(ev.pointerId);
    state.drag = { x0: xOf(ev), x1: xOf(ev) };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!state.drag) return;
    state.drag.x1 = xOf(ev);
    state.selection = { start: tOf(Math.min(state.drag.x0, state.drag.x1)), end: tOf(Math.max(state.drag.x0, state.drag.x1)) };
    render();
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!state.drag) return;
    const { x0, x1 } = state.drag;
    state.drag = null;
    if (Math.abs(x1 - x0) < 4) {
      state.selection = null;
      player.currentTime = tOf(x0);
    } else {
      state.selection = { start: tOf(Math.min(x0, x1)), end: tOf(Math.max(x0, x1)) };
    }
    render();
  });

  $("btnAddCut").addEventListener("click", () => {
    if (!state.selection) return log("先に波形をドラッグして範囲を選んでください");
    addRange("cut", state.selection.start, state.selection.end);
    state.selection = null;
    render();
  });
  $("btnAddKeep").addEventListener("click", () => {
    if (!state.selection) return log("先に波形をドラッグして範囲を選んでください");
    addRange("keep", state.selection.start, state.selection.end);
    state.selection = null;
    render();
  });
  $("btnClearSel").addEventListener("click", () => {
    state.selection = null;
    render();
  });
  $("btnClearAll").addEventListener("click", () => {
    state.ranges = [];
    renderRanges();
    render();
    saveLocal();
  });

  $("btnDetect").addEventListener("click", () => detectSilences());
  $("btnApplySilence").addEventListener("click", () => {
    if (!state.silences.length) return log("先に無音を検出してください");
    const pad = Math.max(0, Number($("silPad").value));
    let n = 0;
    for (const s of state.silences) {
      const a = s.start + pad;
      const b = s.end - pad;
      if (b - a > 0.05) {
        state.ranges.push({ mode: "cut", start: a, end: b });
        n++;
      }
    }
    log(`無音 ${n} 件をカットに追加しました`);
    renderRanges();
    render();
    saveLocal();
  });

  $("ranges").addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.dataset.play != null) {
      const r = state.ranges[Number(t.dataset.play)];
      player.currentTime = r.start;
      player.play();
      const stop = () => {
        if (player.currentTime >= r.end) {
          player.pause();
          player.removeEventListener("timeupdate", stop);
        }
      };
      player.addEventListener("timeupdate", stop);
    }
    if (t.dataset.del != null) {
      state.ranges.splice(Number(t.dataset.del), 1);
      renderRanges();
      render();
      saveLocal();
    }
  });

  $("btnReadTags").addEventListener("click", () => readTags().catch((e) => log("エラー: " + e.message)));
  $("cover").addEventListener("change", (e) => {
    const f = e.target.files[0];
    state.cover = f || null;
    $("coverInfo").textContent = f ? `${f.name}（${(f.size / 1024).toFixed(0)} KB）` : "未選択";
    $("coverPreview").innerHTML = f ? `<img src="${URL.createObjectURL(f)}" alt="cover">` : "";
  });
  $("btnClearCover").addEventListener("click", () => {
    state.cover = null;
    $("cover").value = "";
    $("coverInfo").textContent = "未選択";
    $("coverPreview").innerHTML = "";
  });

  $("btnRun").addEventListener("click", () => run().catch((e) => log("エラー: " + e.message)));
  $("btnCancel").addEventListener("click", () => {
    if (!state.ffmpeg) return;
    log("処理を中断しました。ffmpeg を再読み込みしてください");
    state.ffmpeg.terminate();
    state.ready = false;
    state.inputPath = null;
    state.mounted = false;
    state.running = false;
    $("btnRun").disabled = false;
    $("btnCancel").disabled = true;
    pill("coreStatus", "ffmpeg-core: 停止", "warn");
  });

  $("btnSaveJson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(editJson(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.file ? state.file.name.replace(/\.[^.]+$/, "") : "live-splicer") + ".json";
    a.click();
  });
  $("jsonFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      applyJson(JSON.parse(await f.text()));
    } catch (err) {
      log("エラー: " + err.message);
    }
  });
  $("btnRestore").addEventListener("click", () => {
    try {
      restoreLocal();
    } catch (e) {
      log("エラー: " + e.message);
    }
  });

  ["silThr", "silMin", "silPad"].forEach((id) => $(id).addEventListener("change", () => detectSilences()));

  player.addEventListener("timeupdate", render);
  window.addEventListener("resize", render);
  document.addEventListener("input", (e) => {
    if (e.target.closest(".card")) saveLocal();
  });
}

bind();
renderRanges();
render();
log("準備完了。音源を選ぶと ffmpeg-core（約 31MB）の取得が始まります");
