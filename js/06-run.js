function linkResult(file, bytes) {
  const blob = new Blob([bytes.buffer], { type: "audio/mp4" });
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  const mb = (blob.size / 1048576).toFixed(1);
  return `<a href="${url}" download="${file}">${file}</a> <span class="muted">(${mb} MB)</span>`;
}

async function cleanupCover() {
  if (state.cover) await state.ffmpeg.deleteFile(coverName()).catch(() => {});
  if (state.embeddedCover) {
    await state.ffmpeg.deleteFile(state.embeddedCover).catch(() => {});
    state.embeddedCover = null;
  }
}

async function run() {
  if (state.running) return;
  if (!state.ready) await ensureFfmpeg();
  if (!state.file) throw new Error("音源を選択してください");

  const tracks = trackList();
  if (!tracks.length) throw new Error("まず波形から「トラックにする」で曲を追加してください");

  const output = document.querySelector('input[name="output"]:checked').value;
  state.running = true;
  state.abort = new AbortController();
  $("btnRun").disabled = true;
  $("btnCancel").disabled = false;
  $("result").innerHTML = "";
  setProgress(0);

  try {
    await attachInput();
    await prepareCover();
    await extractEmbeddedCover();
    const cuts = state.ranges.filter((r) => r.mode === "cut");
    if (cuts.length) log(`カット ${cuts.length} 件は書き出しに使いません`);

    if (output === "tracks") {
      log(`書き出し開始: 曲ごとに分割 / ${tracks.length} 曲`);
      const files = await exportTracks(tracks);
      $("result").innerHTML =
        `<p><b>完成:</b> ${files.length} 曲を書き出しました</p>` +
        `<ul class="filelist">${files.map((f) => `<li>${linkResult(f.file, f.bytes)}</li>`).join("")}</ul>` +
        `<p><button id="btnZip">まとめてダウンロード（zip）</button></p>`;
      $("btnZip").addEventListener("click", () => {
        log("zip を作っています");
        downloadZip(files).catch((e) => log("zip に失敗しました: " + (e && e.message ? e.message : e)));
      });
      log(`書き出し完了: ${files.length} 曲`);
    } else {
      let outName = safeName($("outName").value.trim() || "live-spliced.m4a", "live-spliced.m4a");
      if (!/\.[A-Za-z0-9]+$/.test(outName)) outName += ".m4a";
      log(`書き出し開始: 1 本結合 / ${output === "gapless" ? "再エンコード" : "無劣化"}`);
      await exportJoined(tracks, outName, output === "gapless");
      const data = await state.ffmpeg.readFile(outName);
      $("result").innerHTML = `<p><b>完成:</b> ${linkResult(outName, data.slice(0))}</p>`;
      log(`書き出し完了: ${outName}`);
      await state.ffmpeg.deleteFile(outName).catch(() => {});
    }
    await cleanupCover();
    setProgress(1);
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if ((e && e.name === "AbortError") || /abort|terminat/i.test(msg)) {
      log("書き出しを中断しました");
    } else {
      throw e;
    }
  } finally {
    state.running = false;
    state.abort = null;
    $("btnRun").disabled = false;
    $("btnCancel").disabled = true;
  }
}

async function downloadZip(files) {
  const mod = await import("../lib/fflate.mjs");
  const zipped = mod.zipSync(Object.fromEntries(files.map((f) => [f.file, new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength)])));
  const blob = new Blob([zipped], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "live-tracks.zip";
  a.click();
  log(`zip を保存しました（${files.length} 曲 / ${(blob.size / 1048576).toFixed(1)} MB）`);
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
