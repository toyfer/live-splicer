"use strict";

const CONFIG = {
  localCoreBase: "./core",
  ffmpegUmd: "./vendor/ffmpeg.js",
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
  urls: [],
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

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[data-src="' + src + '"]')) {
      res();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.dataset.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("スクリプトを読み込めません: " + src));
    document.head.appendChild(s);
  });
}

async function blobFrom(url, mime, label) {
  pill("coreStatus", label + " を取得中…", "warn");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(label + " を取得できません (" + resp.status + ")");
  const total = Number(resp.headers.get("content-length") || 0);
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      const p = received / total;
      setProgress(p);
      pill("coreStatus", label + ": " + Math.round(p * 100) + "%", "warn");
      $("progText").textContent = (received / 1048576).toFixed(1) + " / " + (total / 1048576).toFixed(1) + " MB";
    }
  }
  if (mime === "application/wasm" && received < 1000000) {
    throw new Error("ffmpeg-core.wasm が小さすぎます (" + received + " bytes)");
  }
  return URL.createObjectURL(new Blob(chunks, { type: mime }));
}

async function ensureFfmpeg() {
  if (state.ready) return;
  pill("coreStatus", "ffmpeg.wasm を読み込み中…", "warn");
  log("ffmpeg.wasm をこのサイトから読み込みます");
  await loadScript(CONFIG.ffmpegUmd);
  const FFmpeg = (window.FFmpegWASM || {}).FFmpeg;
  if (!FFmpeg) throw new Error("ffmpeg.wasm の UMD ビルドが見つかりません");

  const ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    if (state.probeLines) state.probeLines.push(message);
    log(message);
  });
  ffmpeg.on("progress", ({ progress }) => setProgress(progress));

  log("ffmpeg-core を取得します（約 31MB）");
  const coreURL = await blobFrom(CONFIG.localCoreBase + "/ffmpeg-core.js", "text/javascript", "core.js");
  const wasmURL = await blobFrom(CONFIG.localCoreBase + "/ffmpeg-core.wasm", "application/wasm", "core.wasm");
  pill("coreStatus", "ffmpeg-core を起動中…", "warn");
  await ffmpeg.load({ coreURL, wasmURL });
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
      log("WORKERFS でファイルをマウントしました");
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
  log(`解析結果: 長さ ${fmt(state.duration)} / 音声 ${state.info.audio || "不明"} / 画像 ${state.hasCover ? "あり" : "なし"}`);
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
  log(`波形を生成しました（${CONFIG.pcmRate} Hz / ${n} バケット / 長さ ${fmt(state.duration)}）`);
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

  ctx.fillStyle = "rgba(74,222,128,.12)";
  for (const r of trackList()) ctx.fillRect(X(r.start), 0, Math.max(1, X(r.end) - X(r.start)), h);
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

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function renderRanges() {
  const tracks = trackList();
  const total = tracks.reduce((n, k) => n + (k.end - k.start), 0);
  $("keepSummary").textContent = tracks.length
    ? `トラック: ${tracks.length} 曲 / 合計 ${fmt(total)}（元 ${fmt(state.duration)}）`
    : "トラックがありません";

  const rows = ["<thead><tr><th>#</th><th>曲名</th><th>開始</th><th>終了</th><th>長さ</th><th>操作</th></tr></thead><tbody>"];
  tracks.forEach((r, i) => {
    rows.push(
      `<tr><td>${i + 1}</td>` +
      `<td><input class="name-input" data-track="${i}" value="${escapeAttr(r.title || "")}" placeholder="曲名"></td>` +
      `<td class="num">${fmt(r.start)}</td><td class="num">${fmt(r.end)}</td>` +
      `<td class="num">${(r.end - r.start).toFixed(3)} 秒</td>` +
      `<td><button data-play-keep="${i}">試聴</button> <button data-del-keep="${i}">削除</button></td></tr>`
    );
  });
  const cuts = state.ranges.filter((r) => r.mode === "cut").sort((a, b) => a.start - b.start);
  cuts.forEach((r, i) => {
    rows.push(
      `<tr><td>—</td><td><span class="tag cut">カット</span></td>` +
      `<td class="num">${fmt(r.start)}</td><td class="num">${fmt(r.end)}</td>` +
      `<td class="num">${(r.end - r.start).toFixed(3)} 秒</td>` +
      `<td><button data-play-cut="${i}">試聴</button> <button data-del-cut="${i}">削除</button></td></tr>`
    );
  });
  rows.push("</tbody>");
  $("ranges").innerHTML = rows.join("");
}

function addTrack(start, end, title) {
  if (!(end > start)) return;
  const list = trackList();
  state.ranges.push({
    mode: "keep",
    start: Math.max(0, start),
    end: Math.min(state.duration, end),
    title: (title || "").trim() || `Track ${list.length + 1}`,
  });
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
  log(`無音区間を ${runs.length} 件検出しました`);
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

function trackArgs(title, index, total) {
  return [
    "-metadata", `title=${title}`,
    "-metadata", `track=${index}/${total}`,
    "-metadata", `date=${$("m_date").value.trim() || new Date().getFullYear()}`,
  ];
}

async function prepareCover() {
  if (state.cover) {
    await state.ffmpeg.writeFile(coverName(), new Uint8Array(await state.cover.arrayBuffer()));
  }
}

async function exportTracks(tracks, albumSlug) {
  const files = [];
  const total = tracks.length;
  for (let i = 0; i < total; i++) {
    const k = tracks[i];
    const title = (k.title || "").trim() || `Track ${i + 1}`;
    const file = `${String(i + 1).padStart(2, "0")}-${safeName(title, `track-${i + 1}`)}.m4a`;
    log(`トラック ${i + 1}/${total}: ${title} → ${file}`);
    setProgress(i / total);

    await state.ffmpeg.exec([
      "-hide_banner", "-i", state.inputPath,
      ...(state.cover ? ["-i", coverName()] : []),
      "-map", "0:a:0",
      ...(state.cover ? ["-map", "1:v:0"] : []),
      ...(state.hasCover && !state.cover ? ["-map", "0:v?"] : []),
      "-ss", k.start.toFixed(3), "-t", (k.end - k.start).toFixed(3),
      "-c:a", "copy",
      ...(state.cover || state.hasCover ? ["-c:v", "copy", "-disposition:v:0", "attached_pic"] : []),
      "-avoid_negative_ts", "make_zero",
      ...trackArgs(title, i + 1, total),
      ...metaArgs(),
      "-movflags", "+faststart", "-y", file,
    ]);

    const data = await state.ffmpeg.readFile(file);
    files.push({ file, bytes: data.slice(0) });
    await state.ffmpeg.deleteFile(file).catch(() => {});
  }
  setProgress(1);
  return files;
}

async function exportJoined(tracks, outName, gapless) {
  if (gapless) {
    const bitrate = $("bitrate").value;
    const useX = $("xuse").checked;
    let cf = Math.max(0, Number($("xfade").value) / 1000);
    const minLen = tracks.reduce((m, k) => Math.min(m, k.end - k.start), Infinity);
    if (cf > 0 && cf * 2 > minLen) cf = 0;

    let filter = tracks.map((k, i) =>
      `[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=N/SR/TB[a${i}]`
    ).join(";");

    if (tracks.length === 1) {
      filter = filter.replace(/\[a0\]$/, "[out]");
    } else if (useX && cf > 0) {
      let node = "a0";
      for (let i = 1; i < tracks.length; i++) {
        const label = i === tracks.length - 1 ? "out" : `x${i}`;
        filter += `;[${node}][a${i}]acrossfade=d=${cf}:c1=tri:c2=tri[${label}]`;
        node = label;
      }
    } else {
      filter += ";" + tracks.map((_, i) => `[a${i}]`).join("") + `concat=n=${tracks.length}:v=0:a=1[out]`;
    }

    await state.ffmpeg.exec([
      "-hide_banner", "-i", state.inputPath,
      ...(state.cover ? ["-i", coverName()] : []),
      "-filter_complex", filter, "-map", "[out]",
      ...(state.cover ? ["-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"] : []),
      ...metaArgs(),
      "-c:a", "aac", "-b:a", `${bitrate}k`, "-movflags", "+faststart", "-y", outName,
    ]);
  } else {
    const segs = [];
    for (let i = 0; i < tracks.length; i++) {
      const k = tracks[i];
      const seg = `seg${i}.m4a`;
      segs.push(seg);
      await state.ffmpeg.exec([
        "-hide_banner", "-i", state.inputPath,
        "-ss", k.start.toFixed(3), "-t", (k.end - k.start).toFixed(3),
        "-map", "0:a:0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-y", seg,
      ]);
    }
    await state.ffmpeg.writeFile("list.txt", segs.map((s) => `file '${s}'`).join("\n"));
    await state.ffmpeg.exec([
      "-hide_banner", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-y", "joined.m4a",
    ]);
    await state.ffmpeg.exec([
      "-hide_banner", "-i", "joined.m4a",
      ...(state.cover ? ["-i", coverName()] : []),
      "-map", "0:a:0",
      ...(state.cover ? ["-map", "1:v:0"] : []),
      ...(state.hasCover && !state.cover ? ["-map", "0:v?"] : []),
      "-c:a", "copy",
      ...(state.cover || state.hasCover ? ["-c:v", "copy", "-disposition:v:0", "attached_pic"] : []),
      ...metaArgs(),
      "-movflags", "+faststart", "-y", outName,
    ]);
    for (const s of segs) await state.ffmpeg.deleteFile(s).catch(() => {});
    await state.ffmpeg.deleteFile("list.txt").catch(() => {});
    await state.ffmpeg.deleteFile("joined.m4a").catch(() => {});
  }
}

function linkResult(file, bytes) {
  const blob = new Blob([bytes.buffer], { type: "audio/mp4" });
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  const mb = (blob.size / 1048576).toFixed(1);
  return `<a href="${url}" download="${file}">${file}</a> <span class="muted">(${mb} MB)</span>`;
}

async function run() {
  if (state.running) return;
  if (!state.ready) await ensureFfmpeg();
  if (!state.file) throw new Error("音源を選択してください");

  const tracks = trackList();
  if (!tracks.length) throw new Error("まず波形から「トラックにする」で曲を追加してください");

  const output = document.querySelector('input[name="output"]:checked').value;
  state.running = true;
  $("btnRun").disabled = true;
  $("btnCancel").disabled = false;
  $("result").innerHTML = "";
  setProgress(0);

  try {
    await attachInput();
    await prepareCover();

    if (output === "tracks") {
      const album = safeName($("m_album").value, "live");
      log(`書き出し開始: 曲ごとに分割 / ${tracks.length} 曲`);
      const files = await exportTracks(tracks, album);
      $("result").innerHTML =
        `<p><b>完成:</b> ${files.length} 曲を書き出しました</p>` +
        `<ul class="filelist">${files.map((f) => `<li>${linkResult(f.file, f.bytes)}</li>`).join("")}</ul>` +
        `<p><button id="btnZip">まとめてダウンロード（zip）</button></p>`;
      $("btnZip").addEventListener("click", () => downloadZip(files));
      log(`書き出し完了: ${files.length} 曲`);
    } else {
      const outName = ($("outName").value.trim() || "live-spliced.m4a").replace(/[^\w.\-]/g, "_");
      log(`書き出し開始: 1 本結合 / ${output === "gapless" ? "再エンコード" : "無劣化"}`);
      await exportJoined(tracks, outName, output === "gapless");
      const data = await state.ffmpeg.readFile(outName);
      $("result").innerHTML = `<p><b>完成:</b> ${linkResult(outName, data.slice(0))}</p>`;
      log(`書き出し完了: ${outName}`);
      await state.ffmpeg.deleteFile(outName).catch(() => {});
    }
    if (state.cover) await state.ffmpeg.deleteFile(coverName()).catch(() => {});
    setProgress(1);
  } finally {
    state.running = false;
    $("btnRun").disabled = false;
    $("btnCancel").disabled = true;
  }
}

async function downloadZip(files) {
  const mod = await import("./lib/fflate.mjs");
  const zipped = mod.zipSync(Object.fromEntries(files.map((f) => [f.file, new Uint8Array(f.bytes.buffer)])));
  const blob = new Blob([zipped], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "live-tracks.zip";
  a.click();
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
  log(`タグを ${n} 件読み込みました`);
}

function editJson() {
  return {
    app: "live-splicer",
    version: 2,
    source: { name: state.file ? state.file.name : null, size: state.file ? state.file.size : null, duration: state.duration },
    ranges: state.ranges,
    settings: {
      output: document.querySelector('input[name="output"]:checked').value,
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
  state.ranges = (o.ranges || []).map((r) => ({
    mode: r.mode,
    start: Number(r.start),
    end: Number(r.end),
    title: r.title || "",
  }));
  const s = o.settings || {};
  if (s.output) document.querySelector(`input[name="output"][value="${s.output}"]`).checked = true;
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
  log(`JSON を読み込みました（${trackList().length} 曲）`);
}

function saveLocal() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(editJson()));
    $("jsonInfo").textContent = "自動保存済み " + new Date().toLocaleTimeString();
  } catch (e) {
    /* quota */
  }
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
    $("outName").value = f.name.replace(/\.[^.]+$/, "") + "-joined.m4a";
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

  $("btnAddKeep").addEventListener("click", () => {
    if (!state.selection) return log("先に波形をドラッグして範囲を選んでください");
    const title = $("trackTitle").value.trim();
    addTrack(state.selection.start, state.selection.end, title);
    $("trackTitle").value = "";
    state.selection = null;
    render();
  });
  $("btnAddCut").addEventListener("click", () => {
    if (!state.selection) return log("先に波形をドラッグして範囲を選んでください");
    state.ranges.push({ mode: "cut", start: state.selection.start, end: state.selection.end, title: "" });
    state.selection = null;
    renderRanges();
    render();
    saveLocal();
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
        state.ranges.push({ mode: "cut", start: a, end: b, title: "" });
        n++;
      }
    }
    log(`無音 ${n} 件をカットに追加しました`);
    renderRanges();
    render();
    saveLocal();
  });

  $("ranges").addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset.track == null) return;
    const item = trackList()[Number(t.dataset.track)];
    if (!item) return;
    item.title = t.value;
    saveLocal();
  });

  $("ranges").addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.dataset.playKeep != null) {
      const r = trackList()[Number(t.dataset.playKeep)];
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
    if (t.dataset.delKeep != null) {
      const r = trackList()[Number(t.dataset.delKeep)];
      state.ranges.splice(state.ranges.indexOf(r), 1);
      renderRanges();
      render();
      saveLocal();
    }
    if (t.dataset.playCut != null) {
      const cuts = state.ranges.filter((r) => r.mode === "cut").sort((a, b) => a.start - b.start);
      const r = cuts[Number(t.dataset.playCut)];
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
    if (t.dataset.delCut != null) {
      const cuts = state.ranges.filter((r) => r.mode === "cut").sort((a, b) => a.start - b.start);
      const r = cuts[Number(t.dataset.delCut)];
      state.ranges.splice(state.ranges.indexOf(r), 1);
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

  $("btnRun").addEventListener("click", () => run().catch((e) => log("エラー: " + (e && e.message ? e.message : e))));
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
      const raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) throw new Error("自動保存されたデータがありません");
      applyJson(JSON.parse(raw));
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
log("準備完了。音源を選ぶと解析が始まります");
