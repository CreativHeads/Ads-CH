// Reports & creatives: daily/weekly report messages, campaign -> location -> creatives, and a PDF download.
import { buildReportPdf } from "/creatives-pdf.js";

const LOCATIONS = [
  ["KNR", "KNR (Kannur)", ["knr", "kannur"]],
  ["CLT", "CLT (Calicut)", ["clt", "calicut", "kozhikode"]],
  ["EKM", "EKM (Ernakulam)", ["ekm", "ekm2", "kochi", "ernakulam", "cochin"]],
  ["CBE", "CBE (Coimbatore)", ["cbe", "coimbatore"]],
];
const TREATMENTS = [ // first match wins
  ["Dental Implant", ["implant"]],
  ["Aligner", ["aligner", "invisalign", "ortho"]],
  ["Veneer", ["veneer"]],
  ["Crown", ["crown"]],
  ["Pediatric", ["pediatric", "paediatric", "zoya", "vidhu 16"]],
  ["Engagement", ["engagement"]],
  ["Root Canal", ["root canal"]],
];
const LOC_ORDER = [...LOCATIONS.map((l) => l[0]), "ALL"];
const LOC_LABEL = Object.fromEntries([...LOCATIONS.map((l) => [l[0], l[1]]), ["ALL", "All locations"]]);
const ALL_CLIENTS = "__all";
const CONV_NOTE = "Note: Meta link clicks ≠ WhatsApp conversations — clicks count taps on the ad link; conversations count chats actually started.";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let live = null; // /api/live, with per-day ad rows
let ranged = null; // /api/creatives fallback for dates outside the live window
let current = null; // model for the selected client, used by the PDF button

function moneyIn(currency, v, decimals) {
  if (v == null) return "—";
  const sym = currency === "AED" ? "AED " : "₹";
  const d = decimals ?? (v >= 1000 ? 0 : 2);
  return sym + v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const num = (v) => v.toLocaleString("en-IN");
const lakh = (v) => (v >= 100000 ? (v / 100000).toFixed(2) + "L" : num(v));

function locationOf(ad) {
  const tokens = (ad.adset + " " + ad.name).toLowerCase().match(/[a-z0-9]+/g) || [];
  return LOCATIONS.find(([, , keys]) => keys.some((k) => tokens.includes(k)))?.[0] || "ALL";
}
function treatmentOf(ad) {
  const text = `${ad.name} ${ad.adset} ${ad.campaign}`.toLowerCase();
  return TREATMENTS.find(([, keys]) => keys.some((k) => text.includes(k)))?.[0] || ad.campaign || "Other";
}
function totals(ads) {
  const t = { ads: ads.length, spend: 0, impressions: 0, clicks: 0, leads: 0, conv: 0 };
  for (const a of ads) for (const k of ["spend", "impressions", "clicks", "leads", "conv"]) t[k] += a[k];
  t.ctr = t.impressions ? (t.clicks / t.impressions) * 100 : 0;
  t.cpc = t.conv ? t.spend / t.conv : null;
  t.cpl = t.leads ? t.spend / t.leads : null;
  return t;
}
const groupBy = (list, key) => {
  const g = new Map();
  for (const x of list) g.set(key(x), [...(g.get(key(x)) || []), x]);
  return g;
};

// ---- data ----
function liveWindow() {
  if (!live?.endDate) return null;
  return { from: shift(live.endDate, -44), to: live.endDate };
}
function adsFor(account, from, to) {
  const win = liveWindow();
  if (win && from >= win.from && to <= win.to && live.accounts.some((a) => a.ads?.length)) {
    const acc = live.accounts.find((a) => a.name === account);
    return (acc?.ads || []).map((ad) => {
      const row = { name: ad.name, campaign: ad.campaign, adset: ad.adset, thumb: ad.thumb, currency: acc.currency, spend: 0, impressions: 0, clicks: 0, leads: 0, conv: 0 };
      for (const [d, m] of Object.entries(ad.days)) {
        if (d < from || d > to) continue;
        for (const k of ["spend", "impressions", "clicks", "leads", "conv"]) row[k] += Number(m[k]) || 0;
      }
      return row;
    }).filter((a) => a.spend > 0);
  }
  return (ranged?.ads || []).filter((a) => a.account === account);
}
function accountNames() {
  const win = liveWindow();
  const from = $("from").value, to = $("to").value;
  if (win && from >= win.from && to <= win.to) return live.accounts.filter((a) => a.ads?.length).map((a) => a.name).sort();
  return ranged?.accounts || [];
}

// ---- report messages ----
function dailyMessage(account, date, ads, cur) {
  const t = totals(ads);
  const m = (v) => moneyIn(cur, v, 2);
  const camps = [...groupBy(ads, (a) => a.campaign).entries()].map(([name, l]) => [name, totals(l)]).sort((a, b) => b[1].spend - a[1].spend);
  return [
    `Daily Ad Report — ${account} — ${longDate(date)}`, "",
    `Spend: ${m(t.spend)}`,
    `Impressions: ${num(t.impressions)}`,
    `Link clicks: ${num(t.clicks)}`,
    `Leads: ${num(t.leads)} (CPL: ${m(t.cpl)})`,
    `Messaging conversations: ${num(t.conv)} (Cost per conversation: ${m(t.cpc)})`, "",
    "Campaigns",
    ...camps.map(([name, c], i) => `${i + 1}. ${name} — ${m(c.spend)} · ${num(c.conv)} conversations · ${num(c.leads)} leads`), "",
    CONV_NOTE,
  ].join("\n");
}
function periodMessage(account, period, ads, cur) {
  const t = totals(ads);
  const m = (v) => moneyIn(cur, v, 0);
  const lines = [
    `*${account} — Meta Ads, ${period}*`, "",
    `Spend: ${m(t.spend)} | ${t.ads} ads`,
    `Impressions: ${lakh(t.impressions)} | Clicks: ${num(t.clicks)} (CTR ${t.ctr.toFixed(2)}%)`,
    `Messaging conversations: ${num(t.conv)} | Leads: ${num(t.leads)}`,
  ];
  const byLoc = [...groupBy(ads, locationOf).entries()].map(([c, l]) => [c, totals(l)]).sort((a, b) => b[1].spend - a[1].spend);
  if (byLoc.some(([c]) => c !== "ALL")) {
    lines.push("", "*Spend by branch*");
    for (const [c, b] of byLoc) lines.push(`• ${c === "ALL" ? "Other / no branch" : c}: ${m(b.spend)} (${num(b.conv)} conv.${b.leads ? `, ${num(b.leads)} lead${b.leads === 1 ? "" : "s"}` : ""})`);
  }
  const camps = [...groupBy(ads, (a) => a.campaign).entries()].map(([name, l]) => [name, totals(l)]).sort((a, b) => b[1].spend - a[1].spend);
  lines.push("", "*Top campaigns*", ...camps.slice(0, 5).map(([name, c], i) => `${i + 1}. ${name}: ${m(c.spend)} · ${num(c.conv)} conv.`));
  const top = [...ads].sort((a, b) => b.spend - a.spend)[0];
  const best = [...ads].sort((a, b) => b.conv - a.conv || b.leads - a.leads)[0];
  lines.push("", `Top ad: ${top.name}, ${m(top.spend)}.` + (best.conv || best.leads ? ` Best response: ${best.name}, ${num(best.conv)} conv.${best.leads ? ` + ${num(best.leads)} lead${best.leads === 1 ? "" : "s"}` : ""} on ${m(best.spend)}.` : ""));
  lines.push("Full creatives PDF attached.");
  return lines.join("\n");
}
function messageFor(account, ads) {
  const cur = ads[0]?.currency || "INR";
  const from = $("from").value, to = $("to").value;
  return from === to ? dailyMessage(account, to, ads, cur) : periodMessage(account, periodLabel(from, to), ads, cur);
}
function messageCard(account, text) {
  return `<section class="message"><header><strong>${esc(account)}</strong><span>${$("from").value === $("to").value ? "Daily report" : "Period summary"} · ready to paste</span>
    <button type="button" class="copy" data-copy="${esc(text)}">Copy</button></header><pre>${esc(text)}</pre></section>`;
}

// ---- tables / cards ----
const HEADS = ["Ads", "Spend", "Impressions", "Clicks", "CTR", "WA conv.", "Cost / conv.", "Leads"];
function table(money, first, rows, total, extraHead = []) {
  const cells = (t) => [num(t.ads), money(t.spend), num(t.impressions), num(t.clicks), t.ctr.toFixed(2) + "%", num(t.conv), money(t.cpc), num(t.leads)];
  const head = `<tr><th>${first}</th>${extraHead.map((h) => `<th>${h}</th>`).join("")}${HEADS.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const body = rows.map((r) => `<tr${r.target ? ` class="link" data-target="${r.target}"` : ""}>${[...r.lead, ...cells(r.t)].map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  const foot = total ? `<tr class="total">${[...total.lead, ...cells(total.t)].map((c) => `<td>${c}</td>`).join("")}</tr>` : "";
  return `<div class="scroll"><table><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>`;
}
function adCard(a, money) {
  const ctr = a.impressions ? ((a.clicks / a.impressions) * 100).toFixed(2) : "0.00";
  const thumb = a.thumb ? `<img src="${esc(a.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith('No preview')">` : "No preview";
  return `<article class="ad"><div class="thumb">${thumb}</div><div><strong>${esc(a.name)}</strong><small>Ad set: ${esc(a.adset)} · ${esc(a.campaign)}</small>
    <dl><dt>Spend</dt><dd>${money(a.spend)}</dd><dt>Impr.</dt><dd>${num(a.impressions)}</dd>
    <dt>Clicks</dt><dd>${num(a.clicks)}</dd><dt>CTR</dt><dd>${ctr}%</dd>
    <dt>WA conv.</dt><dd>${num(a.conv)}</dd><dt>Leads</dt><dd>${num(a.leads)}</dd>
    <dt>Cost/conv.</dt><dd>${money(a.conv ? a.spend / a.conv : null)}</dd></dl></div></article>`;
}

// ---- dates ----
function longDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function periodLabel(from, to) {
  const f = new Date(from + "T00:00:00"), t = new Date(to + "T00:00:00");
  const d = (x, o) => x.toLocaleDateString("en-GB", o);
  if (from === to) return longDate(to);
  return f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()
    ? `${f.getDate()}–${d(t, { day: "numeric", month: "short", year: "numeric" })}`
    : `${d(f, { day: "numeric", month: "short" })} – ${d(t, { day: "numeric", month: "short", year: "numeric" })}`;
}
function istToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
function shift(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function preset(p) {
  const yesterday = live?.endDate || shift(istToday(), -1);
  $("to").value = yesterday;
  $("from").value = p === "mtd" ? yesterday.slice(0, 8) + "01" : shift(yesterday, 1 - Number(p));
}
const spanDays = () => Math.round((Date.parse($("to").value) - Date.parse($("from").value)) / 86400000) + 1;

// ---- model + render ----
function buildModel(account, ads) {
  const cur = ads[0].currency;
  const money = (v) => moneyIn(cur, v);
  const rows = ads.map((a) => ({ ...a, loc: locationOf(a), treat: treatmentOf(a) }));
  const known = TREATMENTS.map((t) => t[0]);
  const groups = groupBy(rows, (a) => a.treat);
  const order = [...groups.keys()].sort((x, y) => ((known.indexOf(x) + 1 || 99) - (known.indexOf(y) + 1 || 99)) || totals(groups.get(y)).spend - totals(groups.get(x)).spend);
  const days = spanDays();
  const kind = days === 1 ? "Daily" : days === 7 ? "Weekly" : days >= 28 ? "Monthly" : "";
  const period = periodLabel($("from").value, $("to").value);
  return {
    account, currency: cur, money, period, from: $("from").value, to: $("to").value,
    title: `${account} — ${kind ? kind + " " : ""}Performance Report — ${period}`,
    totals: totals(rows),
    branches: LOC_ORDER.map((c) => ({ code: c, label: c === "ALL" ? "Other / no branch" : LOC_LABEL[c], t: totals(rows.filter((a) => a.loc === c)) })).filter((b) => b.t.ads),
    hasBranches: rows.some((a) => a.loc !== "ALL"),
    sections: order.map((name) => {
      const g = groups.get(name);
      return {
        name, t: totals(g),
        metaCampaigns: [...new Set(g.map((a) => a.campaign))],
        thumbs: [...g].sort((a, b) => b.spend - a.spend).map((a) => a.thumb).filter(Boolean).slice(0, 2),
        adNames: [...g].sort((a, b) => b.spend - a.spend).map((a) => a.name),
        locs: LOC_ORDER.filter((c) => g.some((a) => a.loc === c)).map((c) => {
          const la = g.filter((a) => a.loc === c).sort((a, b) => b.spend - a.spend);
          return { code: c, label: LOC_LABEL[c], t: totals(la), ads: la };
        }),
      };
    }),
  };
}

function render() {
  const out = $("report");
  const account = $("account").value;
  current = null;
  $("pdf").disabled = account === ALL_CLIENTS;
  if (account === ALL_CLIENTS) {
    const cards = accountNames().map((name) => [name, adsFor(name, $("from").value, $("to").value)]).filter(([, ads]) => ads.length)
      .sort((a, b) => totals(b[1]).spend - totals(a[1]).spend).map(([name, ads]) => messageCard(name, messageFor(name, ads)));
    out.innerHTML = `<section class="title"><h2>All clients — ${esc(periodLabel($("from").value, $("to").value))}</h2><p>One ready-to-paste report per client, highest spend first. Pick a client to see creatives and download its PDF.</p></section>`
      + (cards.join("") || `<p class="status">No spend in this period.</p>`);
    return;
  }
  const ads = adsFor(account, $("from").value, $("to").value);
  if (!ads.length) {
    out.innerHTML = `<p class="status">No ads with spend for ${esc(account || "this client")} in this period.</p>`;
    return;
  }
  const model = current = buildModel(account, ads);
  const { money, totals: all } = model;
  document.title = model.title;
  const tiles = [["Ads", num(all.ads)], ["Spend", money(all.spend)], ["Impressions", num(all.impressions)], ["Clicks", num(all.clicks)], ["CTR", all.ctr.toFixed(2) + "%"], ["WA conversations", num(all.conv)], ["Cost / conv.", money(all.cpc)], ["Leads", num(all.leads)]];
  let html = `<section class="title"><h2>${esc(model.title)}</h2>
    <p>Ads with spend in the period, grouped by campaign. Inside each campaign every location is shown separately with its own creatives, sorted by spend. Live Meta sync${live?.syncedLabel ? " · " + esc(live.syncedLabel.replace("Live Meta sync · ", "")) : ""}.</p></section>
    <div class="tiles">${tiles.map(([l, v]) => `<div class="tile"><small>${l}</small><strong>${v}</strong></div>`).join("")}</div>`;
  html += messageCard(account, messageFor(account, ads));
  html += `<h3>Campaigns at a glance</h3>` + table(money, "Campaign",
    model.sections.map((s, i) => ({ target: "cp" + i, lead: [esc(s.name), s.locs.map((l) => (l.code === "ALL" ? "All" : l.code)).join(", ")], t: s.t })),
    { lead: ["Total", ""], t: all }, ["Locations"]);
  if (model.hasBranches) {
    html += `<h3>Spend by location</h3>` + table(money, "Location", model.branches.map((b) => ({ lead: [b.label], t: b.t })), { lead: ["Total"], t: all });
    html += `<p class="note">Location comes from the ad set or ad name (KNR, CLT, EKM/Kochi, CBE/Coimbatore). WA conv. = WhatsApp / messaging conversations started.</p>`;
  }
  model.sections.forEach((s, i) => {
    html += `<section class="campaign" id="cp${i}"><header><h2>${esc(s.name)}</h2><p>Meta campaigns: ${s.metaCampaigns.map(esc).join(" · ")}</p></header>`;
    html += table(money, "Location", s.locs.map((l) => ({ lead: [l.label], t: l.t })), { lead: ["Total"], t: s.t });
    for (const l of s.locs) {
      html += `<div class="loc"><h4>${esc(s.name)} — ${l.label}<span>${l.t.ads} ad${l.t.ads === 1 ? "" : "s"} · ${money(l.t.spend)} · ${num(l.t.conv)} WA conv. · ${money(l.t.cpc)}/conv. · ${num(l.t.leads)} leads</span></h4>
        <div class="ads">${l.ads.map((a) => adCard(a, money)).join("")}</div></div>`;
    }
    html += `</section>`;
  });
  out.innerHTML = html;
}

function syncURL() {
  history.replaceState(null, "", `?from=${$("from").value}&to=${$("to").value}&account=${encodeURIComponent($("account").value || "")}`);
}
function fillAccounts(wanted) {
  const names = accountNames();
  $("account").innerHTML = `<option value="${ALL_CLIENTS}">All clients</option>` + names.map((a) => `<option ${a === wanted ? "selected" : ""}>${esc(a)}</option>`).join("");
  if (wanted === ALL_CLIENTS) $("account").value = ALL_CLIENTS;
  else if (!names.includes(wanted)) $("account").value = names.includes("EDS Health care") ? "EDS Health care" : names[0] || ALL_CLIENTS;
}

async function load() {
  const from = $("from").value, to = $("to").value;
  const wanted = $("account").value || new URLSearchParams(location.search).get("account");
  const win = liveWindow();
  ranged = null;
  if (!(win && from >= win.from && to <= win.to && live.accounts.some((a) => a.ads?.length))) {
    $("report").innerHTML = `<p class="status">Loading live Meta data for these dates… this can take up to a minute.</p>`;
    try {
      const response = await fetch(`/api/creatives?${new URLSearchParams({ from, to })}`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "request failed");
      ranged = await response.json();
    } catch (error) {
      $("report").innerHTML = `<p class="status">Could not load live data (${esc(error.message)}). Try again in a minute.</p>`;
      return;
    }
  }
  fillAccounts(wanted);
  syncURL();
  render();
}

async function downloadPdf() {
  if (!current) return;
  const button = $("pdf");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Building PDF…";
  try {
    const bytes = await buildReportPdf(current);
    const d0 = new Date(current.from + "T00:00:00"), d1 = new Date(current.to + "T00:00:00");
    const mon = d1.toLocaleDateString("en-GB", { month: "short" });
    const dates = current.from === current.to ? `${d1.getDate()}-${mon}-${d1.getFullYear()}` : `${d0.getDate()}-${d1.getDate()}-${mon}-${d1.getFullYear()}`;
    const kind = current.title.match(/— (Daily|Weekly|Monthly) /)?.[1];
    const name = `${current.account.replace(/[^a-z0-9]+/gi, "-")}-${kind ? kind + "-" : ""}Performance-Report-${dates}.pdf`;
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error(error);
    alert("The PDF could not be built. Please try again.");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---- wiring ----
$("filters").addEventListener("submit", (e) => { e.preventDefault(); load(); });
document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { preset(b.dataset.preset); load(); }));
$("account").addEventListener("change", () => { syncURL(); render(); });
$("pdf").addEventListener("click", downloadPdf);
$("report").addEventListener("click", async (e) => {
  const copy = e.target.closest("button[data-copy]");
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); } catch {
      const area = Object.assign(document.createElement("textarea"), { value: copy.dataset.copy });
      document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    }
    copy.textContent = "Copied";
    setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    return;
  }
  const row = e.target.closest("tr[data-target]");
  if (row) document.getElementById(row.dataset.target)?.scrollIntoView({ behavior: "smooth" });
});

(async () => {
  try {
    const response = await fetch("/api/live");
    live = response.ok ? await response.json() : null;
  } catch { live = null; }
  const query = new URLSearchParams(location.search);
  if (query.get("from") && query.get("to")) {
    $("from").value = query.get("from");
    $("to").value = query.get("to");
  } else preset(7);
  if (query.get("account")) $("account").innerHTML = `<option selected value="${esc(query.get("account"))}">${esc(query.get("account"))}</option>`;
  load();
})();
