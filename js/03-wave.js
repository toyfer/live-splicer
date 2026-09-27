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
      `<td><input class="time-input" data-start="${i}" value="${escapeAttr(fmt(r.start))}" title="開始 (秒または分:秒)"></td>` +
      `<td><input class="time-input" data-end="${i}" value="${escapeAttr(fmt(r.end))}" title="終了 (秒または分:秒)"></td>` +
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
  const snapped = snapRange(start, end);
  if (!(snapped.end > snapped.start)) return;
  if (Math.abs(snapped.start - start) >= 0.0005 || Math.abs(snapped.end - end) >= 0.0005) {
    log(`フレーム境界へスナップ: ${fmt(start)}–${fmt(end)} → ${fmt(snapped.start)}–${fmt(snapped.end)}`);
  }
  start = snapped.start;
  end = snapped.end;
  const next = {
    mode: "keep",
    start: Math.max(0, start),
    end: Math.min(state.duration || end, end),
    title: (title || "").trim() || `Track ${trackList().length + 1}`,
  };
  const hit = trackList().find((r) => overlaps(r, next));
  if (hit) {
    log(`重なっています: ${hit.title || "既存"} ${fmt(hit.start)}–${fmt(hit.end)} と ${fmt(next.start)}–${fmt(next.end)}`);
    return;
  }
  state.ranges.push(next);
  renderRanges();
  render();
  saveLocal();
}

function invertCutsToTracks() {
  if (!state.duration) return log("先に音源を読み込んでください");
  const cuts = mergeRanges(
    state.ranges.filter((r) => r.mode === "cut" && r.end > r.start).map((r) => ({ start: r.start, end: r.end }))
  );
  if (!cuts.length) return log("カットがありません。無音検出か「カットに追加」で印を付けてください");
  const kept = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor + 0.05) kept.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (state.duration - cursor > 0.05) kept.push({ start: cursor, end: state.duration });
  if (!kept.length) return log("カットの残りがありません");
  state.ranges = state.ranges.filter((r) => r.mode !== "keep");
  kept.forEach((k, i) => {
    const snapped = snapRange(k.start, k.end);
    state.ranges.push({
      mode: "keep",
      start: snapped.start,
      end: snapped.end,
      title: `Track ${i + 1}`,
    });
  });
  log(`カットの残りを ${kept.length} 曲にしました`);
  renderRanges();
  render();
  saveLocal();
}
