// Reading order of the text lines found on a page photo (lib/reader/pageOcr.ts), and the free space
// around each line for its crop. Ported 1:1 from the Python prototype measured on 22 synthetic phone
// photos (books, 3-column newspapers, labels): 99.2% of characters right, columns in the right order.
//   1. Deskew: rotate line positions by the page's median line angle.
//   2. Columns: whitespace through the whole block, allowed to lean from strip to strip (a tilted
//      photo makes columns lean), and only between paragraph text on both sides (a price list or a
//      menu stays row by row).
//   3. Rows: horizontal whitespace splits bands; bands with the same column layout (newspaper rows
//      that line up across columns) are put back together first, so a column is read whole.

export interface Region {
  cx: number; // centre, photo pixels
  cy: number;
  len: number; // along the line
  thick: number; // across the line
  angle: number; // radians, direction of the line
  score: number;
  freeUp: number; // free space above / below (deskewed), set by readingOrder
  freeDown: number;
}

interface Item {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  i: number; // index into the regions
}

const FAR = 1e9;

function middleY(it: Item): number {
  return (it.y0 + it.y1) / 2;
}

function middleX(it: Item): number {
  return (it.x0 + it.x1) / 2;
}

function byPosition(a: Item, b: Item): number {
  return middleY(a) - middleY(b) || a.x0 - b.x0;
}

// Overlapping intervals joined, sorted.
function merged(intervals: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  intervals
    .slice()
    .sort(function (a, b) {
      return a[0] - b[0];
    })
    .forEach(function (item) {
      const last = out[out.length - 1];
      if (last && item[0] <= last[1]) {
        last[1] = Math.max(last[1], item[1]);
      } else {
        out.push([item[0], item[1]]);
      }
    });
  return out;
}

// Horizontal whitespace through the whole block: the y of each gap's middle.
function rowGaps(items: Item[], minGap: number): number[] {
  const iv = merged(
    items.map(function (item) {
      return [item.y0, item.y1] as [number, number];
    }),
  );
  const out: number[] = [];
  for (let k = 1; k < iv.length; k++) {
    if (iv[k][0] - iv[k - 1][1] > minGap) {
      out.push((iv[k][0] + iv[k - 1][1]) / 2);
    }
  }
  return out;
}

interface Piece {
  top: number;
  bottom: number;
  x: number; // where the cut runs in this strip
}

// Vertical whitespace through the whole block, allowed to lean a little from strip to strip.
function columnCuts(items: Item[], tMed: number, minGap: number): Piece[][] {
  let y0 = FAR;
  let y1 = -FAR;
  items.forEach(function (item) {
    y0 = Math.min(y0, item.y0);
    y1 = Math.max(y1, item.y1);
  });
  const h = Math.max(4 * tMed, 1);
  const strips: { top: number; bottom: number; gaps: [number, number][] }[] = [];
  for (let y = y0; y < y1; y += h) {
    const inside = items.filter(function (item) {
      return item.y0 < y + h && item.y1 > y;
    });
    if (!inside.length) {
      continue;
    }
    // Empty space at the strip's edges counts too: a column that ended (or hasn't started yet)
    // leaves the gutter next to it open.
    const edges: [number, number][] = [[-FAR, -FAR] as [number, number]]
      .concat(
        merged(
          inside.map(function (item) {
            return [item.x0, item.x1] as [number, number];
          }),
        ),
      )
      .concat([[FAR, FAR]]);
    const gaps: [number, number][] = [];
    for (let k = 1; k < edges.length; k++) {
      if (edges[k][0] - edges[k - 1][1] > minGap) {
        gaps.push([edges[k - 1][1], edges[k][0]]);
      }
    }
    strips.push({ top: y, bottom: y + h, gaps });
  }
  if (!strips.length) {
    return [];
  }
  let paths: { top: number; bottom: number; gap: [number, number] }[][] = strips[0].gaps
    .filter(function (item) {
      return item[0] > -FAR && item[1] < FAR;
    })
    .map(function (item) {
      return [{ top: strips[0].top, bottom: strips[0].bottom, gap: item }];
    });
  for (let s = 1; s < strips.length; s++) {
    const strip = strips[s];
    const alive: typeof paths = [];
    paths.forEach(function (item) {
      const last = item[item.length - 1].gap;
      let best: [number, number] | null = null;
      let bestOverlap = -FAR;
      strip.gaps.forEach(function (g) {
        const overlap = Math.min(g[1], last[1]) - Math.max(g[0], last[0]);
        if (g[0] < last[1] && g[1] > last[0] && overlap > bestOverlap) {
          best = g;
          bestOverlap = overlap;
        }
      });
      if (best) {
        alive.push(item.concat([{ top: strip.top, bottom: strip.bottom, gap: best }]));
      }
    });
    paths = alive;
  }
  return paths.map(function (item) {
    return item.map(function (p) {
      const g = p.gap;
      const x = g[0] <= -FAR ? g[1] - minGap / 2 : g[1] >= FAR ? g[0] + minGap / 2 : (g[0] + g[1]) / 2;
      return { top: p.top, bottom: p.bottom, x };
    });
  });
}

function rightOf(it: Item, path: Piece[]): boolean {
  const cy = middleY(it);
  for (const p of path) {
    if (p.top <= cy && cy < p.bottom) {
      return middleX(it) >= p.x;
    }
  }
  return middleX(it) >= (cy < path[0].top ? path[0].x : path[path.length - 1].x);
}

// Paragraph text (a newspaper column, a book page), not a price list or a lone label.
function texty(part: Item[], tMed: number): boolean {
  const lens = part
    .map(function (item) {
      return item.x1 - item.x0;
    })
    .sort(function (a, b) {
      return a - b;
    });
  return part.length >= 2 && lens[Math.floor(lens.length / 2)] >= 6 * tMed;
}

// Side-by-side text with a vertical gap between (a row of a multi-column layout).
function columnar(items: Item[]): boolean {
  return (
    merged(
      items.map(function (item) {
        return [item.x0, item.x1] as [number, number];
      }),
    ).length > 1
  );
}

function xycut(items: Item[], tMed: number, minGap: number): Item[] {
  if (items.length <= 1) {
    return items;
  }
  for (const path of columnCuts(items, tMed, minGap)) {
    const left = items.filter(function (item) {
      return !rightOf(item, path);
    });
    const right = items.filter(function (item) {
      return rightOf(item, path);
    });
    if (left.length && right.length && texty(left, tMed) && texty(right, tMed)) {
      return xycut(left, tMed, minGap).concat(xycut(right, tMed, minGap));
    }
  }
  const cuts = rowGaps(items, minGap);
  if (!cuts.length) {
    return items.slice().sort(byPosition);
  }
  const bands: Item[][] = cuts.map(function () {
    return [];
  });
  bands.push([]);
  items.forEach(function (item) {
    const y = middleY(item);
    bands[
      cuts.filter(function (c) {
        return y >= c;
      }).length
    ].push(item);
  });
  const groups: Item[][] = [];
  bands
    .filter(function (item) {
      return item.length > 0;
    })
    .forEach(function (item) {
      const cur = groups[groups.length - 1];
      if (cur && columnar(cur) && columnar(item) && columnar(cur.concat(item))) {
        groups[groups.length - 1] = cur.concat(item);
      } else {
        groups.push(item);
      }
    });
  if (groups.length === 1) {
    return items.slice().sort(byPosition);
  }
  let out: Item[] = [];
  groups.forEach(function (item) {
    out = out.concat(xycut(item, tMed, minGap));
  });
  return out;
}

function median(values: number[]): number {
  const s = values.slice().sort(function (a, b) {
    return a - b;
  });
  const m = Math.floor(s.length / 2);
  return !s.length ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Deskewed axis-aligned boxes of the lines.
function deskewed(regions: Region[]): Item[] {
  const long = regions.filter(function (item) {
    return item.len > 3 * item.thick;
  });
  const skew = median(
    long.map(function (item) {
      return item.angle;
    }),
  );
  const c = Math.cos(-skew);
  const s = Math.sin(-skew);
  return regions.map(function (item, i) {
    const x = item.cx * c - item.cy * s;
    const y = item.cx * s + item.cy * c;
    return { x0: x - item.len / 2, y0: y - item.thick / 2, x1: x + item.len / 2, y1: y + item.thick / 2, i };
  });
}

// Gap to the nearest text above and below each line, so its crop never shows the next line.
function freeSpace(items: Item[], regions: Region[]): void {
  items.forEach(function (it) {
    let up = FAR;
    let down = FAR;
    const half = (it.y1 - it.y0) / 2;
    items.forEach(function (o) {
      if (o === it || o.x1 <= it.x0 || o.x0 >= it.x1) {
        return;
      }
      if (o.y1 <= it.y0 + half && o.y0 < it.y0) {
        up = Math.min(up, Math.max(0, it.y0 - o.y1));
      } else if (o.y0 >= it.y0 + half && o.y1 > it.y1) {
        down = Math.min(down, Math.max(0, o.y0 - it.y1));
      }
    });
    regions[it.i].freeUp = up;
    regions[it.i].freeDown = down;
  });
}

export interface Ordered {
  order: number[]; // region indices in reading order
  breakAfter: boolean[]; // per position in `order`: a paragraph / column / heading ends after this line
}

export function readingOrder(regions: Region[]): Ordered {
  if (!regions.length) {
    return { order: [], breakAfter: [] };
  }
  const items = deskewed(regions);
  const tMed = median(
    regions.map(function (item) {
      return item.thick;
    }),
  );
  freeSpace(items, regions);
  const ordered = xycut(items, tMed, 0.3 * tMed);
  // Gap between a line and the next one in the same column: a much bigger gap = new paragraph.
  const gaps: number[] = [];
  for (let k = 0; k + 1 < ordered.length; k++) {
    const a = ordered[k];
    const b = ordered[k + 1];
    if (b.x0 < a.x1 && b.x1 > a.x0 && b.y0 >= a.y1) {
      gaps.push(b.y0 - a.y1);
    }
  }
  const gapMed = median(gaps);
  const breakAfter = ordered.map(function (a, k) {
    const b = ordered[k + 1];
    if (!b) {
      return true;
    }
    const sameColumn = b.x0 < a.x1 && b.x1 > a.x0 && b.y0 >= a.y0;
    const ta = a.y1 - a.y0;
    const tb = b.y1 - b.y0;
    const sizeChange = Math.max(ta, tb) / Math.max(1, Math.min(ta, tb)) > 1.35;
    return !sameColumn || sizeChange || b.y0 - a.y1 > 1.6 * gapMed + 0.2 * tMed;
  });
  return {
    order: ordered.map(function (item) {
      return item.i;
    }),
    breakAfter,
  };
}
