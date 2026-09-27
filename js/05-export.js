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
  const primedN = plan.filter((p) => !p.re && primeInfo(p.k)).length;
  const bareN = plan.filter((p) => !p.re && !primeInfo(p.k)).length;
  if (primedN) log(`copy ${primedN} 曲は先頭に 1 フレーム重ね、1024 サンプルを飛ばす印を付けます`);
  if (bareN) log(`copy ${bareN} 曲は音源先頭に近く、重ねるフレームが取れないので印は付けません`);
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
    const prime = p.re ? null : primeInfo(p.k);
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
        ...copyCutArgs(p.k, prime ? { prime: true } : null),
        "-i", state.inputPath,
        ...coverInput(),
        "-map", "0:a:0",
        ...coverOutput(),
        "-c:a", "copy",
        "-avoid_negative_ts", "make_zero",
        ...trackArgs(title, i + 1, total),
        ...metaArgs(),
        ...(prime ? ["-metadata", "gapless_playback=1"] : []),
        "-movflags", "+faststart",
        "-y", file,
      ]);
    }
    if (code !== 0) throw new Error("トラックの書き出しに失敗しました: " + title);
    let data = await state.ffmpeg.readFile(file);
    if (prime) data = stampGapless(data, prime);
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

function itunSmpb(priming, remainder, valid) {
  const h = (n, w) => n.toString(16).padStart(w, "0");
  return ` ${h(0, 8)} ${h(priming, 8)} ${h(remainder, 8)} ${h(valid, 16)}` + " 00000000".repeat(8);
}

function readU32(b, o) {
  return b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function readU64(b, o) {
  return readU32(b, o) * 4294967296 + readU32(b, o + 4);
}

function readI32(b, o) {
  const u = readU32(b, o);
  return u >= 2147483648 ? u - 4294967296 : u;
}

function writeU32(b, o, v) {
  v = Math.floor(v);
  b[o] = Math.floor(v / 16777216) & 255;
  b[o + 1] = Math.floor(v / 65536) & 255;
  b[o + 2] = Math.floor(v / 256) & 255;
  b[o + 3] = v & 255;
}

function writeU64(b, o, v) {
  const hi = Math.floor(v / 4294967296);
  const lo = v - hi * 4294967296;
  writeU32(b, o, hi);
  writeU32(b, o + 4, lo);
}

function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function mp4Boxes(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = readU32(b, o);
    const type = fourcc(b, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = readU64(b, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    out.push({ o, size, header, type, start: o + header, end: o + size });
    o += size;
  }
  return out;
}

function findBox(list, type) {
  return list.find((b) => b.type === type) || null;
}

function fullSkip(type) {
  return type === "meta" || type === "stsd" ? 4 : 0;
}

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "meta", "ilst", "dinf"]);
const GROW_BOXES = new Set(["moov", "udta", "meta", "ilst"]);

function soundTrak(b, moov) {
  const traks = mp4Boxes(b, moov.start, moov.end).filter((x) => x.type === "trak");
  for (const trak of traks) {
    const mdia = findBox(mp4Boxes(b, trak.start, trak.end), "mdia");
    if (!mdia) continue;
    const hdlr = findBox(mp4Boxes(b, mdia.start, mdia.end), "hdlr");
    if (!hdlr || hdlr.start + 12 > hdlr.end) continue;
    if (fourcc(b, hdlr.start + 8) === "soun") return trak;
  }
  return null;
}

function timescaleOf(b, box) {
  if (!box || box.start >= box.end) return 0;
  const version = b[box.start];
  const at = version === 1 ? box.start + 20 : box.start + 12;
  if (at + 4 > box.end) return 0;
  return readU32(b, at);
}

function patchAudioEdit(b, info) {
  const moov = findBox(mp4Boxes(b, 0, b.length), "moov");
  if (!moov) return false;
  const mvhd = findBox(mp4Boxes(b, moov.start, moov.end), "mvhd");
  const movieScale = timescaleOf(b, mvhd);
  const trak = soundTrak(b, moov);
  if (!trak || !movieScale) return false;
  const kids = mp4Boxes(b, trak.start, trak.end);
  const mdia = findBox(kids, "mdia");
  const edts = findBox(kids, "edts");
  if (!mdia || !edts) return false;
  const mdhd = findBox(mp4Boxes(b, mdia.start, mdia.end), "mdhd");
  const elst = findBox(mp4Boxes(b, edts.start, edts.end), "elst");
  const mediaScale = timescaleOf(b, mdhd);
  if (!elst || !mediaScale || elst.start + 8 > elst.end) return false;
  const version = b[elst.start];
  const count = readU32(b, elst.start + 4);
  const stride = version === 1 ? 20 : 12;
  let entry = -1;
  for (let i = 0; i < count; i++) {
    const at = elst.start + 8 + i * stride;
    if (at + stride > elst.end) return false;
    const media = version === 1 ? readU64(b, at + 8) : readI32(b, at + 4);
    if (media >= 0) {
      entry = at;
      break;
    }
  }
  if (entry < 0) return false;
  const oldMedia = version === 1 ? readU64(b, entry + 8) : readI32(b, entry + 4);
  const oldDur = version === 1 ? readU64(b, entry) : readU32(b, entry);
  const newMedia = Math.round(info.priming * mediaScale / info.sampleRate);
  const delta = Math.round((newMedia - oldMedia) * movieScale / mediaScale);
  const newDur = oldDur - delta;
  if (!(newDur > 0) || newMedia < 0) return false;
  if (version === 1) {
    writeU64(b, entry, newDur);
    writeU64(b, entry + 8, newMedia);
  } else {
    writeU32(b, entry, newDur);
    writeU32(b, entry + 4, newMedia);
  }
  return true;
}

function itunBox(text) {
  const mean = new TextEncoder().encode("com.apple.iTunes");
  const name = new TextEncoder().encode("iTunSMPB");
  const data = new TextEncoder().encode(text);
  const meanBox = 12 + mean.length;
  const nameBox = 12 + name.length;
  const dataBox = 16 + data.length;
  const total = 8 + meanBox + nameBox + dataBox;
  const out = new Uint8Array(total);
  writeU32(out, 0, total);
  out.set([0x2d, 0x2d, 0x2d, 0x2d], 4);
  writeU32(out, 8, meanBox);
  out.set([0x6d, 0x65, 0x61, 0x6e], 12);
  out.set(mean, 20);
  writeU32(out, 8 + meanBox, nameBox);
  out.set([0x6e, 0x61, 0x6d, 0x65], 12 + meanBox);
  out.set(name, 20 + meanBox);
  const dataAt = 8 + meanBox + nameBox;
  writeU32(out, dataAt, dataBox);
  out.set([0x64, 0x61, 0x74, 0x61], dataAt + 4);
  writeU32(out, dataAt + 8, 1);
  out.set(data, dataAt + 16);
  return out;
}

function containersHolding(b, point) {
  const found = [];
  function visit(start, end) {
    for (const box of mp4Boxes(b, start, end)) {
      if (!(box.o < point && point <= box.end)) continue;
      if (GROW_BOXES.has(box.type)) found.push(box);
      const inner = box.start + fullSkip(box.type);
      if (inner < box.end && point > inner) visit(inner, box.end);
    }
  }
  visit(0, b.length);
  return found;
}

function bumpChunkOffsets(b, point, delta) {
  function visit(start, end) {
    for (const box of mp4Boxes(b, start, end)) {
      if (box.type === "stco" || box.type === "co64") {
        const wide = box.type === "co64";
        const count = readU32(b, box.start + 4);
        let at = box.start + 8;
        for (let i = 0; i < count; i++) {
          const off = wide ? readU64(b, at) : readU32(b, at);
          if (off >= point) {
            if (wide) writeU64(b, at, off + delta);
            else writeU32(b, at, off + delta);
          }
          at += wide ? 8 : 4;
        }
      }
      if (!MP4_CONTAINERS.has(box.type)) continue;
      const inner = box.start + fullSkip(box.type);
      if (inner < box.end) visit(inner, box.end);
    }
  }
  visit(0, b.length);
}

function assertMp4(b) {
  const boxes = mp4Boxes(b, 0, b.length);
  if (!boxes.length || boxes[boxes.length - 1].end !== b.length) throw new Error("MP4 の箱サイズがファイルと合いません");
  if (!boxes.some((x) => x.type === "moov") || !boxes.some((x) => x.type === "mdat")) throw new Error("moov または mdat がありません");
}

function ilstHasSmpb(b) {
  const moov = findBox(mp4Boxes(b, 0, b.length), "moov");
  if (!moov) return false;
  const udta = findBox(mp4Boxes(b, moov.start, moov.end), "udta");
  if (!udta) return false;
  const meta = findBox(mp4Boxes(b, udta.start, udta.end), "meta");
  if (!meta) return false;
  const ilst = findBox(mp4Boxes(b, meta.start + 4, meta.end), "ilst");
  if (!ilst) return false;
  return mp4Boxes(b, ilst.start, ilst.end).some((x) => x.type === "----");
}

function insertItunSmpb(b, text) {
  const moov = findBox(mp4Boxes(b, 0, b.length), "moov");
  if (!moov) throw new Error("moov がありません");
  const udta = findBox(mp4Boxes(b, moov.start, moov.end), "udta");
  if (!udta) throw new Error("udta がありません");
  const meta = findBox(mp4Boxes(b, udta.start, udta.end), "meta");
  if (!meta) throw new Error("meta がありません");
  const ilst = findBox(mp4Boxes(b, meta.start + 4, meta.end), "ilst");
  if (!ilst) throw new Error("ilst がありません");
  const payload = itunBox(text);
  const point = ilst.end;
  const holders = containersHolding(b, point);
  if (!holders.some((h) => h.type === "ilst")) throw new Error("ilst のサイズを更新できませんでした");
  const out = new Uint8Array(b.length + payload.length);
  out.set(b.subarray(0, point), 0);
  out.set(payload, point);
  out.set(b.subarray(point), point + payload.length);
  for (const box of holders) {
    const next = box.size + payload.length;
    if (box.header === 16) writeU64(out, box.o + 8, next);
    else writeU32(out, box.o, next);
  }
  bumpChunkOffsets(out, point, payload.length);
  return out;
}

function stampGapless(bytes, info) {
  const b = new Uint8Array(bytes);
  if (!patchAudioEdit(b, info)) throw new Error("edit list の media_time を 1024 サンプルにできませんでした");
  const text = itunSmpb(info.priming, 0, info.valid);
  const out = ilstHasSmpb(b) ? b : insertItunSmpb(b, text);
  assertMp4(out);
  if (!ilstHasSmpb(out)) throw new Error("iTunSMPB を書けませんでした");
  return out;
}
