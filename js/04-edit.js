function stopPreview() {
  if (state.playStop) {
    player.removeEventListener("timeupdate", state.playStop);
    state.playStop = null;
  }
}

function playRange(r) {
  if (!r) return;
  stopPreview();
  player.currentTime = r.start;
  const stop = () => {
    if (player.currentTime >= r.end) {
      player.pause();
      stopPreview();
    }
  };
  state.playStop = stop;
  player.addEventListener("timeupdate", stop);
  const p = player.play();
  if (p && typeof p.catch === "function") p.catch((e) => log("再生できません: " + (e && e.message ? e.message : e)));
}

function applyTrackTime(index, which, raw) {
  const item = trackList()[index];
  if (!item) return;
  const t = parseTime(raw);
  if (!isFinite(t)) {
    log("時刻の形式が不正です（例: 12.5 または 1:23.400）");
    renderRanges();
    return;
  }
  const next = { start: item.start, end: item.end };
  const clamped = Math.max(0, Math.min(state.duration || t, t));
  const snapped = snapTime(clamped);
  if (Math.abs(snapped - t) >= 0.0005) log(`フレーム境界へスナップ: ${fmt(t)} → ${fmt(snapped)}`);
  next[which] = snapped;
  const minStep = (state.audio && state.audio.frameDur) || 0.001;
  if (!(next.end > next.start + minStep * 0.5)) {
    log("終了は開始より後ろにしてください");
    renderRanges();
    return;
  }
  const hit = trackList().find((r, i) => i !== index && overlaps(r, next));
  if (hit) {
    log(`重なっています: ${hit.title || "既存"} ${fmt(hit.start)}–${fmt(hit.end)}`);
    renderRanges();
    return;
  }
  item.start = next.start;
  item.end = next.end;
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

function activeCover() {
  if (state.cover) return coverName();
  return state.embeddedCover;
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
  ];
}

function coverInput() {
  const name = activeCover();
  return name ? ["-i", name] : [];
}

function coverOutput() {
  if (!activeCover()) return [];
  return ["-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"];
}

async function prepareCover() {
  if (state.cover) {
    await state.ffmpeg.writeFile(coverName(), new Uint8Array(await state.cover.arrayBuffer()));
  }
}

async function extractEmbeddedCover() {
  if (state.embeddedCover) {
    await state.ffmpeg.deleteFile(state.embeddedCover).catch(() => {});
    state.embeddedCover = null;
  }
  if (state.cover || !state.hasCover) return null;
  const name = "srccover" + (state.coverExt || ".jpg");
  const code = await state.ffmpeg.exec([
    "-hide_banner", "-i", state.inputPath,
    "-map", "0:v:0", "-c", "copy", "-frames:v", "1", "-y", name,
  ]);
  if (code !== 0) {
    log("元ファイルのカバーを取り出せなかったので、画像なしで続けます");
    await state.ffmpeg.deleteFile(name).catch(() => {});
    return null;
  }
  const bytes = await state.ffmpeg.readFile(name).catch(() => null);
  if (!bytes || bytes.length < 32) {
    log("元ファイルのカバーを取り出せなかったので、画像なしで続けます");
    await state.ffmpeg.deleteFile(name).catch(() => {});
    return null;
  }
  state.embeddedCover = name;
  log("元ファイルのカバーを取り出して、各曲に付けます");
  return name;
}

async function ffExec(args) {
  const opts = state.abort ? { signal: state.abort.signal } : {};
  return state.ffmpeg.exec(args, -1, opts);
}
