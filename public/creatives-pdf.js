// Branded CreativHeads performance report PDF, built in the browser with pdf-lib.
// Theme follows the CreativHeads weekly report: light-blue logo header box, rounded tables
// (blue headers on the summary page, black on detail pages), blue section titles, and
// full-width creative cards with "Label: value" lines.
// Layout: totals, spend by branch, campaign summary, then each campaign -> each location -> its creatives.
let deps = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("PDF dependency could not load"));
    document.head.appendChild(s);
  });
}
async function dependencies() {
  if (!deps) deps = (async () => {
    if (!window.PDFLib) await loadScript("/vendor/pdf-lib.min.js");
    if (!window.fontkit) await loadScript("/vendor/fontkit.umd.min.js");
    const bytes = await Promise.all(["/assets/hanken-regular.ttf", "/assets/hanken-semibold.ttf", "/assets/creativheads-logo.png?v=2"].map(async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error("PDF asset could not load");
      return r.arrayBuffer();
    }));
    return { PDFLib: window.PDFLib, fontkit: window.fontkit, regular: bytes[0], bold: bytes[1], logo: bytes[2] };
  })();
  return deps;
}

async function fetchImage(url) {
  try {
    const r = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  }
}

// SVG path for a rounded rectangle with its top-left at 0,0 (SVG y grows downward).
function roundedPath(w, h, r, corners = "all") {
  const tl = corners === "bottom" ? 0 : r, tr = tl;
  const bl = corners === "top" ? 0 : r, br = bl;
  return `M ${tl} 0 H ${w - tr} Q ${w} 0 ${w} ${tr} V ${h - br} Q ${w} ${h} ${w - br} ${h} H ${bl} Q 0 ${h} 0 ${h - bl} V ${tl} Q 0 0 ${tl} 0 Z`;
}

export async function buildReportPdf(model) {
  const { PDFLib, fontkit, regular, bold, logo } = await dependencies();
  const { PDFDocument, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(model.title);
  doc.setAuthor("CreativHeads");
  doc.setProducer("CreativHeads Ad Reports");
  const font = await doc.embedFont(regular, { subset: true });
  const strong = await doc.embedFont(bold, { subset: true });
  const logoImg = await doc.embedPng(logo);

  const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const C = { ink: hex("#111111"), muted: hex("#5f6672"), blue: hex("#0c75fd"), tint: hex("#e6f0ff"), black: hex("#111111"), line: hex("#cccccc"), rule: hex("#dddddd"), white: rgb(1, 1, 1), photo: hex("#eef1f5") };
  const W = 595.28, H = 841.89, M = 40, CW = W - 2 * M, BOTTOM = 56;
  const sym = model.currency === "AED" ? "AED " : "Rs ";
  const money = (v, d) => (v == null ? "-" : sym + v.toLocaleString("en-IN", { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 }));
  const num = (v) => v.toLocaleString("en-IN");

  // thumbnails, fetched once
  const urls = [...new Set(model.sections.flatMap((s) => s.locs.flatMap((l) => l.ads.map((a) => a.thumb))).filter(Boolean))];
  const images = new Map();
  await Promise.all(urls.map(async (url) => {
    const b = await fetchImage(url);
    if (!b) return;
    try {
      if (b[0] === 0xff && b[1] === 0xd8) images.set(url, await doc.embedJpg(b));
      else if (b[0] === 0x89 && b[1] === 0x50) images.set(url, await doc.embedPng(b));
    } catch { /* unsupported image, leave the placeholder */ }
  }));

  let page, y;
  const width = (s, size, f = font) => f.widthOfTextAtSize(String(s), size);
  const text = (s, x, yy, size = 9, f = font, color = C.ink) => page.drawText(String(s), { x, y: yy, size, font: f, color });
  const right = (s, xr, yy, size = 9, f = font, color = C.ink) => text(s, xr - width(s, size, f), yy, size, f, color);
  const center = (s, cx, yy, size = 9, f = font, color = C.ink) => text(s, cx - width(s, size, f) / 2, yy, size, f, color);
  const fit = (s, max, size, f = font) => {
    s = String(s ?? "");
    if (width(s, size, f) <= max) return s;
    while (s.length && width(s + "…", size, f) > max) s = s.slice(0, -1);
    return s + "…";
  };
  const wrap = (s, max, size, f = font, lines = 2) => {
    const out = [];
    let line = "";
    for (const word of String(s).split(/\s+/)) {
      const next = line ? line + " " + word : word;
      if (width(next, size, f) > max && line) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    if (out.length > lines) { out.length = lines; out[lines - 1] = fit(out[lines - 1] + "…", max, size, f); }
    return out;
  };
  // rounded box; x/top in PDF coordinates (top = upper edge)
  const box = (x, top, w, h, { fill, border, r = 7, corners = "all", bw = 0.8 } = {}) =>
    page.drawSvgPath(roundedPath(w, h, r, corners), { x, y: top, color: fill, borderColor: border, borderWidth: border ? bw : 0 });
  const vline = (x, y1, y2, color = C.rule) => page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: 0.6, color });
  const hline = (x1, x2, yy, color = C.rule) => page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness: 0.6, color });

  function newPage(first = false) {
    page = doc.addPage([W, H]);
    if (first) {
      const top = H - 34, bh = 54;
      box(M, top, CW, bh, { fill: C.tint, border: C.blue, r: 8, bw: 1.1 });
      const lh = 34, lw = (logoImg.width / logoImg.height) * lh;
      page.drawImage(logoImg, { x: M + 10, y: top - bh / 2 - lh / 2, width: lw, height: lh });
      right("PERFORMANCE REPORT", W - M - 12, top - 15, 8, strong, C.blue);
      right("Prepared by CreativHeads", W - M - 12, top - 30, 12, strong, C.ink);
      right("for " + model.account, W - M - 12, top - 42, 8, font, C.muted);
      y = top - bh - 34;
    } else {
      const lh = 18, lw = (logoImg.width / logoImg.height) * lh;
      page.drawImage(logoImg, { x: W - M - lw, y: H - 30 - lh, width: lw, height: lh });
      y = H - 74;
    }
  }
  const ensure = (h) => { if (y - h < BOTTOM) newPage(); };

  function heading(s, size = 15, color = C.blue) {
    ensure(size + 40);
    text(s, M, y, size, strong, color);
    y -= size + 10;
  }

  // rounded table, centered cells; headColor blue on the summary page, black on detail pages
  function table(cols, rows, { headColor = C.black, total = false, rowH = 19, headH = 20, inset = 0 } = {}) {
    const x0 = M + inset, tw = cols.reduce((a, c) => a + c.w, 0);
    let first = true;
    const drawChunk = (chunk, isLast) => {
      const h = headH + chunk.length * rowH;
      box(x0, y, tw, h, { fill: C.white, border: C.line, r: 7 });
      box(x0, y, tw, headH, { fill: headColor, r: 7, corners: "top" });
      let x = x0;
      cols.forEach((c, j) => {
        const label = fit(c.label, c.w - 8, 8, font);
        if (c.align === "left") text(label, x + 7, y - headH + 7, 8, font, C.white);
        else center(label, x + c.w / 2, y - headH + 7, 8, font, C.white);
        if (j) vline(x, y - headH, y - h + 0.5);
        x += c.w;
      });
      chunk.forEach((row, i) => {
        const ry = y - headH - i * rowH;
        if (i) hline(x0, x0 + tw, ry);
        const isTotal = total && isLast && i === chunk.length - 1;
        let cx = x0;
        row.forEach((v, j) => {
          const c = cols[j], f = isTotal ? strong : font;
          const s = fit(v, c.w - 8, 8.5, f);
          if (c.align === "left") text(s, cx + 7, ry - rowH + 6.5, 8.5, f);
          else center(s, cx + c.w / 2, ry - rowH + 6.5, 8.5, f);
          cx += c.w;
        });
      });
      y -= h + 18;
    };
    let rest = rows;
    while (rest.length) {
      const fitRows = Math.max(1, Math.floor((y - BOTTOM - headH - (first ? 0 : 0)) / rowH));
      if (fitRows < 2 && rest.length > 1) { newPage(); continue; }
      const chunk = rest.slice(0, fitRows);
      rest = rest.slice(fitRows);
      drawChunk(chunk, !rest.length);
      if (rest.length) newPage();
      first = false;
    }
  }
  const metricCols = (firstLabel, firstW, totalW = CW) => {
    const rest = totalW - firstW, parts = [0.6, 1.4, 1.2, 0.85, 0.8, 0.95, 1.15, 0.7];
    const labels = ["Ads", "Spend", "Impr.", "Clicks", "CTR", "WA conv.", "Cost/conv.", "Leads"];
    const sum = parts.reduce((a, b) => a + b, 0);
    return [{ label: firstLabel, w: firstW }, ...labels.map((l, i) => ({ label: l, w: (rest * parts[i]) / sum }))];
  };
  const metricCells = (t) => [num(t.ads), money(t.spend), num(t.impressions), num(t.clicks), t.ctr.toFixed(2) + "%", num(t.conv), money(t.cpc), num(t.leads)];

  // Photos fill a rounded frame: clip to a rounded rectangle, then cover-fit the image inside it.
  function clipRounded(x, yy, w, h, r) {
    const { pushGraphicsState, moveTo, lineTo, appendBezierCurve, closePath, clip, endPath } = PDFLib;
    const k = 0.5523 * r; // bezier handle length for a quarter circle
    page.pushOperators(
      pushGraphicsState(),
      moveTo(x + r, yy), lineTo(x + w - r, yy), appendBezierCurve(x + w - r + k, yy, x + w, yy + r - k, x + w, yy + r),
      lineTo(x + w, yy + h - r), appendBezierCurve(x + w, yy + h - r + k, x + w - r + k, yy + h, x + w - r, yy + h),
      lineTo(x + r, yy + h), appendBezierCurve(x + r - k, yy + h, x, yy + h - r + k, x, yy + h - r),
      lineTo(x, yy + r), appendBezierCurve(x, yy + r - k, x + r - k, yy, x + r, yy),
      closePath(), clip(), endPath(),
    );
  }
  function image(url, x, yy, w, h, r = 8) {
    const img = images.get(url);
    clipRounded(x, yy, w, h, Math.min(r, w / 2, h / 2));
    page.drawRectangle({ x, y: yy, width: w, height: h, color: C.photo });
    if (img) {
      const k = Math.max(w / img.width, h / img.height);
      page.drawImage(img, { x: x + (w - img.width * k) / 2, y: yy + (h - img.height * k) / 2, width: img.width * k, height: img.height * k });
    }
    page.pushOperators(PDFLib.popGraphicsState());
    if (!img) center("No preview", x + w / 2, yy + h / 2 - 3, 7, font, C.muted);
  }

  // ---- page 1 ----
  newPage(true);
  for (const line of wrap(model.title, CW, 20, strong, 2)) {
    center(line, W / 2, y, 20, strong, C.ink);
    y -= 25;
  }
  y += 4;
  for (const line of wrap("CreativHeads Performance team. Ads with spend during " + model.period + " (totals for the period), grouped by campaign; inside each campaign every location is shown separately, sorted by spend (high to low). Thumbnails are stills; video ads are not playable in the PDF.", CW, 8.5, font, 3)) {
    text(line, M, y, 8.5, font, C.muted);
    y -= 12;
  }
  y -= 8;
  const t = model.totals;
  {
    const labels = ["Ads", "Spend", "Impressions", "Clicks", "CTR", "WA conv.", "Cost/conv.", "Leads"];
    const parts = [0.6, 1.3, 1.15, 0.8, 0.75, 0.95, 1.05, 0.65], tw = CW - 50, sum = parts.reduce((a, b) => a + b, 0);
    table(labels.map((l, i) => ({ label: l, w: (tw * parts[i]) / sum })), [metricCells(t)], { headColor: C.blue, inset: 25 });
  }
  y -= 4;

  if (model.hasBranches) {
    heading("Spend by branch", 11.5, C.ink);
    table(metricCols("Branch", 118, CW - 20), [...model.branches.map((b) => [b.label, ...metricCells(b.t)]), ["Total", ...metricCells(t)]], { headColor: C.blue, total: true, inset: 10 });
    for (const line of wrap("Branch = the city in the ad set or ad name (KNR, CLT, EKM/Kochi, CBE/Coimbatore). WA conv. = WhatsApp / messaging conversations started.", CW, 7.5, font, 2)) {
      text(line, M, y + 2, 7.5, font, C.muted);
      y -= 10;
    }
    y -= 10;
  }

  heading(`Campaign summary — ${num(t.ads)} ads`, 11.5, C.ink);
  for (const s of model.sections) {
    const rowH = 50;
    ensure(rowH + 4);
    image(s.thumbs[0], M, y - rowH + 4, 40, rowH - 8, 6);
    image(s.thumbs[1] || s.thumbs[0], M + 43, y - rowH + 4, 40, rowH - 8, 6);
    const tx = M + 92, tw = CW - 92 - 150;
    const lines = wrap(s.name + ": " + s.adNames.join(", "), tw, 8.5, font, 3);
    lines.forEach((l, i) => {
      if (i === 0 && l.startsWith(s.name + ":")) {
        text(s.name + ":", tx, y - 11, 8.5, strong);
        text(l.slice(s.name.length + 1), tx + width(s.name + ":", 8.5, strong), y - 11, 8.5);
      } else text(l, tx, y - 11 - i * 11, 8.5);
    });
    const summary = [`${s.t.ads} ads · ${money(s.t.spend, 0)}`, `${num(s.t.conv)} WA conv. · ${money(s.t.cpc)}/conv.`, `${s.locs.map((l) => (l.code === "ALL" ? "All" : l.code)).join(", ")}`];
    summary.forEach((l, i) => right(l, W - M, y - 11 - i * 11, 8, i === 0 ? strong : font, i === 2 ? C.muted : C.ink));
    hline(M, W - M, y - rowH + 1);
    y -= rowH + 4;
  }

  // ---- campaign pages ----
  const cardH = 112, photo = 96;
  model.sections.forEach((s, i) => {
    if (i === 0 || y < H * 0.35) newPage();
    else y -= 8;
    heading(s.name, 17, C.blue);
    text(fit("Meta campaigns: " + s.metaCampaigns.join(" · "), CW, 8), M, y + 4, 8, font, C.muted);
    y -= 12;
    table(metricCols("Location", 118, CW - 50), [...s.locs.map((l) => [l.label, ...metricCells(l.t)]), ["Total", ...metricCells(s.t)]], { total: true, inset: 25 });

    for (const l of s.locs) {
      ensure(24 + cardH);
      text(`${s.name} — ${l.label}`, M, y, 12.5, strong, C.blue);
      y -= 13;
      text(fit(`Location totals: ${money(l.t.spend)} spend · ${num(l.t.conv)} WhatsApp conversations · ${money(l.t.cpc)} per conversation · ${num(l.t.leads)} leads`, CW, 8), M, y, 8, font, C.muted);
      y -= 9;
      l.ads.forEach((a, n) => {
        if (y - cardH - 6 < BOTTOM) {
          newPage();
          text(`${s.name} — ${l.label} (cont.)`, M, y, 12.5, strong, C.blue);
          y -= 18;
        }
        const top = y;
        box(M, top, CW, cardH, { fill: C.white, border: C.line, r: 7 });
        image(a.thumb, M + 8, top - cardH + 8, photo, cardH - 16);
        const tx = M + photo + 20, tw = CW - photo - 30;
        text(fit(`${n + 1}. ${a.name}`, tw, 11, strong), tx, top - 18, 11, strong);
        const ctr = a.impressions ? ((a.clicks / a.impressions) * 100).toFixed(2) : "0.00";
        const lines = [
          [["Campaign", a.campaign]],
          [["Ad set", a.adset]],
          [["Spend", money(a.spend)]],
          [["Impressions", num(a.impressions)]],
          [["Clicks", `${num(a.clicks)} (CTR ${ctr}%)`]],
          [["WA conversations", num(a.conv)], ["Cost/conv.", money(a.conv ? a.spend / a.conv : null)], ["Leads", num(a.leads)]],
        ];
        lines.forEach((pairs, r) => {
          let x = tx;
          const yy = top - 32 - r * 12.5;
          pairs.forEach(([k, v], j) => {
            if (j) { text(" · ", x, yy, 8.5); x += width(" · ", 8.5); }
            text(k + ": ", x, yy, 8.5, strong);
            x += width(k + ": ", 8.5, strong);
            const val = fit(v, tx + tw - x, 8.5);
            text(val, x, yy, 8.5);
            x += width(val, 8.5);
          });
        });
        y -= cardH + 7;
      });
      y -= 10;
    }
  });

  // footers with page x/y
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 36 }, end: { x: W - M, y: 36 }, thickness: 0.9, color: C.blue });
    p.drawText(fit(model.title, CW - 200, 7.5), { x: M, y: 24, size: 7.5, font, color: C.ink });
    const label = `CreativHeads · Performance Report · page ${i + 1}/${pages.length}`;
    p.drawText(label, { x: W - M - width(label, 7.5), y: 24, size: 7.5, font, color: C.blue });
  });
  return doc.save();
}
