function preparedKeeps(tracks) {
  return tracks.map((k) => ({ ...k, ...snapRange(k.start, k.end) }));
}

function joinGap(prev, next) {
  const gap = next.start - prev.end;
  return { gap, continuous: gap <= CONFIG.joinEps && gap >= -CONFIG.joinEps };
}

function liveGroups(prepared) {
  const groups = [];
  let cur = [];
  prepared.forEach((k, i) => {
    if (!cur.length) {
      cur = [k];
      return;
    }
    if (joinGap(prepared[i - 1], k).continuous) cur.push(k);
    else {
      groups.push(cur);
      cur = [k];
    }
  });
  if (cur.length) groups.push(cur);
  return groups;
}

function fadeSeconds() {
  if (!$("xuse").checked) return 0;
  const ms = Number($("xfade").value);
  return ms > 0 ? ms / 1000 : 0;
}

function clampedFade(len, fadeSec, fadeIn, fadeOut) {
  if (!(fadeSec > 0) || (!fadeIn && !fadeOut)) return 0;
  const sides = (fadeIn ? 1 : 0) + (fadeOut ? 1 : 0);
  const d = Math.min(fadeSec, len / (sides + 0.5));
  return d >= 0.005 ? d : 0;
}

function fadeChain(len, fadeIn, fadeOut, d) {
  const parts = [];
  if (fadeIn && d > 0) parts.push(`afade=t=in:st=0:d=${d.toFixed(3)}`);
  if (fadeOut && d > 0) parts.push(`afade=t=out:st=${Math.max(0, len - d).toFixed(3)}:d=${d.toFixed(3)}`);
  return parts.join(",");
}

function livePlan(tracks) {
  const prepared = preparedKeeps(tracks);
  const fadeSec = fadeSeconds();
  const groups = liveGroups(prepared);
  const plan = [];
  groups.forEach((g, gi) => {
    const gapBefore = gi > 0;
    const gapAfter = gi < groups.length - 1;
    const re = fadeSec > 0 && (gapBefore || gapAfter);
    g.forEach((k, i) => {
      plan.push({
        k,
        re,
        fadeIn: re && gapBefore && i === 0,
        fadeOut: re && gapAfter && i === g.length - 1,
        gi,
      });
    });
  });
  return { prepared, groups, plan, fadeSec };
}

function logLivePlan(groups, fadeSec) {
  let butts = 0;
  groups.forEach((g, gi) => {
    butts += Math.max(0, g.length - 1);
    if (!gi) return;
    const prev = groups[gi - 1];
    const gap = g[0].start - prev[prev.length - 1].end;
    log(fadeSec > 0
      ? `空き ${gap.toFixed(3)} s → 前の終わりと次の始まりを ${Math.round(fadeSec * 1000)} ms フェード`
      : `空き ${gap.toFixed(3)} s → フェードなしのハードカット`);
  });
  log(`ライブCD: 同じ時刻の突き合わせ ${butts} 箇所${fadeSec ? ` / 空きの端フェード ${Math.round(fadeSec * 1000)} ms` : " / 端フェードなし"}`);
}

async function exportTracks(tracks) {
  const { groups, plan, fadeSec } = livePlan(tracks);
  logLivePlan(groups, fadeSec);
  const files = [];
  const total = plan.length;
  const bitrate = $("bitrate").value;
  for (let i = 0; i < total; i++) {
    const p = plan[i];
    const title = (p.k.title || "").trim() || `Track ${i + 1}`;
    const file = `${String(i + 1).padStart(2, "0")}-${safeName(title, `track-${i + 1}`)}.m4a`;
    log(`トラック ${i + 1}/${total}: ${title} → ${file}`);
    setProgress(i / total);
    let code;
    if (p.re) {
      const len = p.k.end - p.k.start;
      const d = clampedFade(len, fadeSec, p.fadeIn, p.fadeOut);
      const extra = fadeChain(len, p.fadeIn, p.fadeOut, d);
      const chain = `[0:a]atrim=start=${ffTime(p.k.start)}:end=${ffTime(p.k.end)},asetpts=N/SR/TB${extra ? "," + extra : ""}[out]`;
      if (p.fadeIn) log(`  始まりを ${Math.round(d * 1000)} ms フェードイン`);
      if (p.fadeOut) log(`  終わりを ${Math.round(d * 1000)} ms フェードアウト`);
      code = await ffExec([
        "-hide_banner", "-i", state.inputPath,
        ...coverInput(),
        "-filter_complex", chain,
        "-map", "[out]",
        ...coverOutput(),
        "-c:a", "aac", "-b:a", `${bitrate}k`,
        ...trackArgs(title, i + 1, total),
        ...metaArgs(),
        "-movflags", "+faststart",
        "-y", file,
      ]);
    } else {
      code = await ffExec([
        "-hide_banner",
        ...copyCutArgs(p.k),
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
    }
    if (code !== 0) throw new Error("トラックの書き出しに失敗しました: " + title);
    const data = await state.ffmpeg.readFile(file);
    files.push({ file, bytes: data.slice(0) });
    await state.ffmpeg.deleteFile(file).catch(() => {});
  }
  setProgress(1);
  return files;
}

async function exportJoined(tracks, outName, gapless) {
  const prepared = preparedKeeps(tracks);
  const groups = liveGroups(prepared);
  const fadeSec = fadeSeconds();
  if (gapless) {
    logLivePlan(groups, fadeSec);
    const bitrate = $("bitrate").value;
    const parts = [];
    const labels = prepared.map((k, i) => {
      const len = k.end - k.start;
      const fadeIn = i > 0 && !joinGap(prepared[i - 1], k).continuous && fadeSec > 0;
      const fadeOut = i < prepared.length - 1 && !joinGap(k, prepared[i + 1]).continuous && fadeSec > 0;
      const d = clampedFade(len, fadeSec, fadeIn, fadeOut);
      const extra = fadeChain(len, fadeIn, fadeOut, d);
      const src = `a${i}`;
      parts.push(`[0:a]atrim=start=${ffTime(k.start)}:end=${ffTime(k.end)},asetpts=N/SR/TB[${src}]`);
      if (!extra) return src;
      parts.push(`[${src}]${extra}[b${i}]`);
      return `b${i}`;
    });
    let filter = parts.join(";");
    let out = "out";
    if (labels.length > 1) {
      filter += `;${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=0:a=1[out]`;
    } else {
      const tag = `[${labels[0]}]`;
      if (!filter.endsWith(tag)) throw new Error("結合フィルタのラベルが一致しません");
      filter = filter.slice(0, -tag.length) + "[out]";
    }
    const code = await ffExec([
      "-hide_banner", "-i", state.inputPath,
      ...coverInput(),
      "-filter_complex", filter,
      "-map", `[${out}]`,
      ...coverOutput(),
      ...metaArgs(),
      "-c:a", "aac", "-b:a", `${bitrate}k`,
      "-movflags", "+faststart",
      "-y", outName,
    ]);
    if (code !== 0) throw new Error("結合の書き出しに失敗しました");
    return;
  }

  log("無劣化結合: 同じ時刻の連続区間は 1 回の copy。空きはハードカット。端フェードはしません");
  const segs = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const seg = `seg${i}.m4a`;
    segs.push(seg);
    const code = await ffExec([
      "-hide_banner",
      ...copyCutArgs({ start: g[0].start, end: g[g.length - 1].end }),
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
    "-movflags", "+faststart",
    "-y", outName,
  ]);
  if (muxed !== 0) throw new Error("結合ファイルの書き出しに失敗しました");
  for (const s of segs) await state.ffmpeg.deleteFile(s).catch(() => {});
  await state.ffmpeg.deleteFile("list.txt").catch(() => {});
  await state.ffmpeg.deleteFile("joined.m4a").catch(() => {});
}
