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
  const lastGi = groups.length - 1;
  const plan = [];
  groups.forEach((g, gi) => {
    const gapBefore = gi > 0;
    const gapAfter = gi < lastGi;
    const flags = g.map((_, i) => ({
      fadeIn: fadeSec > 0 && i === 0 && (gapBefore || gi === 0),
      fadeOut: fadeSec > 0 && i === g.length - 1 && (gapAfter || gi === lastGi),
    }));
    const re = flags.some((f) => f.fadeIn || f.fadeOut);
    g.forEach((k, i) => {
      plan.push({ k, re, fadeIn: flags[i].fadeIn, fadeOut: flags[i].fadeOut, gi });
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
      ? `空き ${gap.toFixed(3)} s \u2192 \u524d\u306e\u7d42\u308f\u308a\u3068\u6b21\u306e\u59cb\u307e\u308a\u3092 ${Math.round(fadeSec * 1000)} ms \u30d5\u30a7\u30fc\u30c9`
      : `空き ${gap.toFixed(3)} s \u2192 \u30d5\u30a7\u30fc\u30c9\u306a\u3057\u306e\u30cf\u30fc\u30c9\u30ab\u30c3\u30c8`);
  });
  log(`\u30e9\u30a4\u30d6CD: \u540c\u3058\u6642\u523b\u306e\u7a81\u304d\u5408\u308f\u305b ${butts} \u7b87\u6240${fadeSec ? ` / \u7aef\u30d5\u30a7\u30fc\u30c9 ${Math.round(fadeSec * 1000)} ms\uff08\u7a7a\u304d\u3068\u3001\u6700\u521d\u30fb\u6700\u5f8c\uff09` : " / \u7aef\u30d5\u30a7\u30fc\u30c9\u306a\u3057"}`);
}
