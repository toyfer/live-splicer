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
  let coreURL;
  let wasmURL;
  if (state.coreBlob) {
    coreURL = state.coreBlob.coreURL;
    wasmURL = state.coreBlob.wasmURL;
    log("保持している ffmpeg-core を再利用します");
  } else {
    coreURL = await blobFrom(CONFIG.localCoreBase + "/ffmpeg-core.js", "text/javascript", "core.js");
    wasmURL = await blobFrom(CONFIG.localCoreBase + "/ffmpeg-core.wasm", "application/wasm", "core.wasm");
    state.coreBlob = { coreURL, wasmURL };
  }
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
  if (a) {
    state.info.audio = `${a[1].trim()} / ${a[2]} Hz / ${a[3].trim()}`;
    setAudioGrid(a[1].trim(), Number(a[2]));
  } else {
    state.audio = null;
  }
  const v = text.match(/Video:\s*([^\s,]+)/);
  state.hasCover = /Stream #0:\d+.*Video:/.test(text);
  state.coverExt = v && /png/i.test(v[1]) ? ".png" : ".jpg";
  const frameNote = state.audio && state.audio.snap ? ` / フレーム ${(state.audio.frameDur * 1000).toFixed(3)} ms` : "";
  log(`解析結果: 長さ ${fmt(state.duration)} / 音声 ${state.info.audio || "不明"}${frameNote} / 画像 ${state.hasCover ? "あり" : "なし"}`);
  if (state.ranges.length) snapAllRanges("解析後");
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
