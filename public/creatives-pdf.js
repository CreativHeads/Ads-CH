// Branded CreativHeads performance report PDF, built in the browser with pdf-lib.
// Layout: header + totals, spend by branch, campaign summary, then each campaign -> each location -> its creatives.
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
    const bytes = await Promise.all(["/assets/hanken-regular.ttf", "/assets/hanken-semibold.ttf", "/assets/creativheads-logo.png"].map(async (url) => {
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
  const C = { ink: hex("#1b2430"), muted: hex("#6b7480"), navy: hex("#12213f"), blue: hex("#1a6ff0"), line: hex("#dde2e8"), light: hex("#f3f6fa"), white: rgb(1, 1, 1), green: hex("#1f8f7a") };
  const W = 595.28, H = 841.89, M = 38, CW = W - 2 * M;
  const sym = model.currency === "AED" ? "AED " : "Rs ";
  const money = (v, d) => (v == null ? "—" : sym + v.toLocaleString("en-IN", { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 }));
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
  const rect = (x, yy, w, h, color, border) => page.drawRectangle({ x, y: yy, width: w, height: h, color, borderColor: border, borderWidth: border ? 0.6 : 0 });

  function newPage(first = false) {
    page = doc.addPage([W, H]);
    if (first) {
      const lh = 40, lw = (logoImg.width / logoImg.height) * lh;
      page.drawImage(logoImg, { x: M, y: H - M - lh, width: lw, height: lh });
      right("PERFORMANCE REPORT", W - M, H - M - 10, 8, strong, C.blue);
      right("Prepared by CreativHeads", W - M, H - M - 25, 12.5, strong, C.ink);
      right("for " + model.account, W - M, H - M - 38, 8.5, font, C.muted);
      page.drawLine({ start: { x: M, y: H - M - 52 }, end: { x: W - M, y: H - M - 52 }, thickness: 1.2, color: C.blue });
      y = H - M - 80;
    } else {
      const lh = 15, lw = (logoImg.width / logoImg.height) * lh;
      page.drawImage(logoImg, { x: W - M - lw, y: H - M + 4 - lh, width: lw, height: lh });
      y = H - M - 26;
    }
  }
  const ensure = (h) => { if (y - h < 52) newPage(); };

  function heading(s, size = 15, color = C.navy) {
    ensure(size + 30);
    text(s, M, y, size, strong, color);
    y -= size + 9;
  }

  // generic table: cols = [{label, w, align}], rows = [[...cells]], bold last row when total
  function table(cols, rows, { total = false, rowH = 18 } = {}) {
    const head = () => {
      rect(M, y - rowH + 5, CW, rowH, C.navy);
      let x = M;
      for (const c of cols) {
        const label = fit(c.label, c.w - 10, 7.5, strong);
        if (c.align === "left") text(label, x + 6, y - 7, 7.5, strong, C.white);
        else right(label, x + c.w - 6, y - 7, 7.5, strong, C.white);
        x += c.w;
      }
      y -= rowH;
    };
    ensure(rowH * 2 + 8);
    head();
    rows.forEach((row, i) => {
      if (y - rowH < 52) { newPage(); head(); }
      const isTotal = total && i === rows.length - 1;
      if (isTotal) rect(M, y - rowH + 5, CW, rowH, C.light);
      let x = M;
      row.forEach((v, j) => {
        const c = cols[j], f = isTotal || j === 0 ? strong : font;
        const s = fit(v, c.w - 10, 8, f);
        if (c.align === "left") text(s, x + 6, y - 7, 8, f);
        else right(s, x + c.w - 6, y - 7, 8, f);
        x += c.w;
      });
      page.drawLine({ start: { x: M, y: y - rowH + 5 }, end: { x: W - M, y: y - rowH + 5 }, thickness: 0.5, color: C.line });
      y -= rowH;
    });
    y -= 10;
  }
  const metricCols = (firstLabel, firstW) => {
    const rest = CW - firstW, parts = [0.6, 1.35, 1.15, 0.85, 0.8, 0.9, 1.15, 0.7];
    const labels = ["Ads", "Spend", "Impr.", "Clicks", "CTR", "WA conv.", "Cost/conv.", "Leads"];
    const sum = parts.reduce((a, b) => a + b, 0);
    return [{ label: firstLabel, w: firstW, align: "left" }, ...labels.map((l, i) => ({ label: l, w: (rest * parts[i]) / sum }))];
  };
  const metricCells = (t) => [num(t.ads), money(t.spend), num(t.impressions), num(t.clicks), t.ctr.toFixed(2) + "%", num(t.conv), money(t.cpc), num(t.leads)];

  function image(url, x, yy, w, h) {
    rect(x, yy, w, h, C.light);
    const img = images.get(url);
    if (!img) {
      text("No preview", x + (w - width("No preview", 6.5)) / 2, yy + h / 2 - 2, 6.5, font, C.muted);
      return;
    }
    const k = Math.min(w / img.width, h / img.height);
    page.drawImage(img, { x: x + (w - img.width * k) / 2, y: yy + (h - img.height * k) / 2, width: img.width * k, height: img.height * k });
  }

  // ---- page 1 ----
  newPage(true);
  for (const line of wrap(model.title, CW, 19, strong, 2)) {
    text(line, M + (CW - width(line, 19, strong)) / 2, y, 19, strong, C.ink);
    y -= 24;
  }
  for (const line of wrap("CreativHeads Performance team. Ads with spend during " + model.period + " (totals for the period), grouped by campaign; inside each campaign every location is shown separately, sorted by spend (high to low). Thumbnails are stills; video ads are not playable in the PDF.", CW, 8.5, font, 3)) {
    text(line, M, y, 8.5, font, C.muted);
    y -= 12;
  }
  y -= 8;
  const t = model.totals;
  {
    const labels = ["Ads", "Spend", "Impressions", "Clicks", "CTR", "WA conv.", "Cost/conv.", "Leads"];
    const vals = metricCells(t), w = CW / labels.length;
    rect(M, y - 13, CW, 18, C.navy);
    rect(M, y - 33, CW, 20, C.white, C.line);
    labels.forEach((l, i) => {
      text(l, M + i * w + (w - width(l, 7.5, strong)) / 2, y - 7, 7.5, strong, C.white);
      text(vals[i], M + i * w + (w - width(vals[i], 9, strong)) / 2, y - 27, 9, strong, C.ink);
    });
    y -= 52;
  }

  if (model.hasBranches) {
    heading("Spend by branch", 11.5, C.ink);
    table(metricCols("Branch", 120), [...model.branches.map((b) => [b.label, ...metricCells(b.t)]), ["Total", ...metricCells(t)]], { total: true });
    for (const line of wrap("Branch = the city in the ad set or ad name (KNR, CLT, EKM/Kochi, CBE/Coimbatore). WA conv. = WhatsApp / messaging conversations started.", CW, 7.5, font, 2)) {
      text(line, M, y + 4, 7.5, font, C.muted);
      y -= 10;
    }
    y -= 8;
  }

  heading(`Campaign summary — ${num(t.ads)} ads`, 11.5, C.ink);
  for (const s of model.sections) {
    const rowH = 48;
    ensure(rowH + 4);
    image(s.thumbs[0], M, y - rowH + 6, 38, rowH - 6);
    image(s.thumbs[1] || s.thumbs[0], M + 41, y - rowH + 6, 38, rowH - 6);
    const tx = M + 88, tw = CW - 88 - 150;
    const lines = wrap(s.name + ": " + s.adNames.join(", "), tw, 8.5, font, 3);
    lines.forEach((l, i) => {
      if (i === 0 && l.startsWith(s.name + ":")) {
        text(s.name + ":", tx, y - 9, 8.5, strong);
        text(l.slice(s.name.length + 1), tx + width(s.name + ":", 8.5, strong), y - 9, 8.5);
      } else text(l, tx, y - 9 - i * 11, 8.5);
    });
    const summary = [`${s.t.ads} ads · ${money(s.t.spend, 0)}`, `${num(s.t.conv)} WA conv. · ${money(s.t.cpc)}/conv.`, `${s.locs.map((l) => (l.code === "ALL" ? "All" : l.code)).join(", ")}`];
    summary.forEach((l, i) => right(l, W - M, y - 9 - i * 11, 8, i === 0 ? strong : font, i === 2 ? C.muted : C.ink));
    page.drawLine({ start: { x: M, y: y - rowH + 2 }, end: { x: W - M, y: y - rowH + 2 }, thickness: 0.5, color: C.line });
    y -= rowH + 4;
  }

  // ---- campaign pages ----
  const cardW = (CW - 10) / 2, cardH = 84;
  newPage();
  model.sections.forEach((s, i) => {
    if (i > 0) {
      if (y < H * 0.3) newPage();
      else {
        y -= 6;
        page.drawLine({ start: { x: M, y: y + 12 }, end: { x: W - M, y: y + 12 }, thickness: 0.8, color: C.line });
        y -= 10;
      }
    }
    heading(s.name, 17, C.navy);
    text(fit("Meta campaigns: " + s.metaCampaigns.join(" · "), CW, 8), M, y + 3, 8, font, C.muted);
    y -= 14;
    table(metricCols("Location", 120), [...s.locs.map((l) => [l.label, ...metricCells(l.t)]), ["Total", ...metricCells(s.t)]], { total: true });

    for (const l of s.locs) {
      ensure(22 + cardH);
      text(`${s.name} — ${l.label}`, M, y, 11.5, strong, C.green);
      const sub = `${l.t.ads} ad${l.t.ads === 1 ? "" : "s"} · ${money(l.t.spend)} · ${num(l.t.conv)} WA conv. · ${money(l.t.cpc)}/conv. · ${num(l.t.leads)} leads`;
      right(fit(sub, CW - width(`${s.name} — ${l.label}`, 11.5, strong) - 12, 7.5), W - M, y, 7.5, font, C.muted);
      y -= 10;
      l.ads.forEach((a, i) => {
        const col = i % 2;
        if (col === 0 && y - cardH - 6 < 52) {
          newPage();
          text(`${s.name} — ${l.label} (cont.)`, M, y, 11.5, strong, C.green);
          y -= 10;
        }
        const x = M + col * (cardW + 10), top = y;
        rect(x, top - cardH, cardW, cardH, C.white, C.line);
        image(a.thumb, x + 5, top - cardH + 5, 60, cardH - 10);
        const tx = x + 72, tw = cardW - 78;
        const ctr = a.impressions ? ((a.clicks / a.impressions) * 100).toFixed(2) : "0.00";
        text(fit(`${i + 1}. ${a.name}`, tw, 9, strong), tx, top - 14, 9, strong);
        text(fit(`Ad set: ${a.adset}`, tw, 7), tx, top - 25, 7, font, C.muted);
        const rows = [
          [["Spend", money(a.spend)], ["Impr.", num(a.impressions)]],
          [["Clicks", num(a.clicks)], ["CTR", ctr + "%"]],
          [["WA conv.", num(a.conv)], ["Leads", num(a.leads)]],
          [["Cost/conv.", money(a.conv ? a.spend / a.conv : null)]],
        ];
        rows.forEach((pairs, r) => pairs.forEach(([k, v], c) => {
          const px = tx + c * (tw / 2), py = top - 40 - r * 11;
          text(k, px, py, 7.5, font, C.muted);
          text(fit(v, tw / 2 - width(k, 7.5) - 6, 7.5, strong), px + width(k, 7.5) + 4, py, 7.5, strong);
        }));
        if (col === 1 || i === l.ads.length - 1) y -= cardH + 6;
      });
      y -= 8;
    }
  });

  // footers with page x/y
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 34 }, end: { x: W - M, y: 34 }, thickness: 0.8, color: C.blue });
    p.drawText(fit(model.title, CW - 190, 7), { x: M, y: 22, size: 7, font, color: C.muted });
    const label = `CreativHeads · Performance Report · page ${i + 1}/${pages.length}`;
    p.drawText(label, { x: W - M - width(label, 7), y: 22, size: 7, font, color: C.blue });
  });
  return doc.save();
}
