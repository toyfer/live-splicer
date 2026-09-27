async function exportTracks(tracks) {
  const files = [];
  const total = tracks.length;
  for (let i = 0; i < total; i++) {
    const k = tracks[i];
    const title = (k.title || "").trim() || `Track ${i + 1}`;
    const file = `${String(i + 1).padStart(2, "0")}-${safeName(title, `track-${i + 1}`)}.m4a`;
    log(`トラック ${i + 1}/${total}: ${title} → ${file}`);
    setProgress(i / total);

    const code = await ffExec([
      "-hide_banner",
      ...copyCutArgs(k),
      "-i", state.inputPath,
      ...coverInput(),
      "-map", "0:a:0",
      ...coverOutput(),
      "-c:a", "copy",
      "-avoid_negative_ts", "make_zero",
      ...trackArgs(title, i + 1, total),
      ...metaArgs(),
      "-movflags", "+faststart",
      "-y", file,
    ]);
    if (code !== 0) throw new Error("トラックの書き出しに失敗しました: " + title);

    const data = await state.ffmpeg.readFile(file);
    files.push({ file, bytes: data.slice(0) });
    await state.ffmpeg.deleteFile(file).catch(() => {});
  }
  setProgress(1);
  return files;
}

function crossfadeSeconds(prev, next, requested) {
  if (!(requested > 0)) return 0;
  const maxD = Math.min(prev.end - prev.start, next.end - next.start) * 0.45;
  const d = Math.min(requested, maxD);
  return d >= 0.005 ? d : 0;
}

function joinSteps(tracks, useX, cf) {
  const steps = [];
  for (let i = 1; i < tracks.length; i++) {
    const gap = tracks[i].start - tracks[i - 1].end;
    const continuous = gap <= CONFIG.joinEps && gap >= -CONFIG.joinEps;
    const d = continuous ? 0 : crossfadeSeconds(tracks[i - 1], tracks[i], useX ? cf : 0);
    steps.push({ i, gap, mode: d > 0 ? "xfade" : "concat", d });
  }
  return steps;
}

async function exportJoined(tracks, outName, gapless) {
  if (gapless) {
    const bitrate = $("bitrate").value;
    const useX = $("xuse").checked;
    const cf = Math.max(0, Number($("xfade").value) / 1000);

    const prepared = tracks.map((k) => ({ ...k, ...snapRange(k.start, k.end) }));
    let filter = prepared.map((k, i) =>
      `[0:a]atrim=start=${ffTime(k.start)}:end=${ffTime(k.end)},asetpts=N/SR/TB[a${i}]`
    ).join(";");

    if (prepared.length === 1) {
      filter = filter.replace(/\[a0\]$/, "[out]");
    } else {
      const steps = joinSteps(prepared, useX, cf);
      const fades = steps.filter((s) => s.mode === "xfade").length;
      const butts = steps.length - fades;
      log(useX && cf > 0
        ? `再エンコード結合: 連続（${Math.round(CONFIG.joinEps * 1000)} ms 以内）は突き合わせ ${butts} / クロスフェード ${fades}`
        : `再エンコード結合: クロスフェードなしで突き合わせ ${butts}`);
      let node = "a0";
      steps.forEach((s) => {
        const label = s.i === prepared.length - 1 ? "out" : `j${s.i}`;
        if (s.mode === "xfade") {
          filter += `;[${node}][a${s.i}]acrossfade=d=${s.d.toFixed(3)}:c1=tri:c2=tri[${label}]`;
          log(`結合 ${s.i}: ソース間隔 ${s.gap.toFixed(3)} s → クロスフェード ${Math.round(s.d * 1000)} ms`);
        } else {
          filter += `;[${node}][a${s.i}]concat=n=2:v=0:a=1[${label}]`;
        }
        node = label;
      });
    }

    const code = await ffExec([
      "-hide_banner", "-i", state.inputPath,
      ...coverInput(),
      "-filter_complex", filter, "-map", "[out]",
      ...coverOutput(),
      ...metaArgs(),
      "-c:a", "aac", "-b:a", `${bitrate}k`, "-movflags", "+faststart", "-y", outName,
    ]);
    if (code !== 0) throw new Error("結合の書き出しに失敗しました");
  } else {
    log("無劣化結合: フレーム境界で切り出して連結します。クロスフェードは使いません");
    const segs = [];
    for (let i = 0; i < tracks.length; i++) {
      const k = tracks[i];
      const seg = `seg${i}.m4a`;
      segs.push(seg);
      const code = await ffExec([
        "-hide_banner",
        ...copyCutArgs(k),
        "-i", state.inputPath,
        "-map", "0:a:0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-y", seg,
      ]);
      if (code !== 0) throw new Error("区間の切り出しに失敗しました");
    }
    await state.ffmpeg.writeFile("list.txt", segs.map((s) => `file '${s}'`).join("\n"));
    const joined = await ffExec([
      "-hide_banner", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-y", "joined.m4a",
    ]);
    if (joined !== 0) throw new Error("区間の結合に失敗しました");
    const muxed = await ffExec([
      "-hide_banner", "-i", "joined.m4a",
      ...coverInput(),
      "-map", "0:a:0",
      ...coverOutput(),
      "-c:a", "copy",
      ...metaArgs(),
      "-movflags", "+faststart", "-y", outName,
    ]);
    if (muxed !== 0) throw new Error("結合ファイルの書き出しに失敗しました");
    for (const s of segs) await state.ffmpeg.deleteFile(s).catch(() => {});
    await state.ffmpeg.deleteFile("list.txt").catch(() => {});
    await state.ffmpeg.deleteFile("joined.m4a").catch(() => {});
  }
}
