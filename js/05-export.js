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
