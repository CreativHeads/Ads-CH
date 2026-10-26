// Ad creatives: campaign (treatment) -> each location -> its ads, from live Meta data.
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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let data = null;
let currency = "INR";

function money(v) {
  if (v == null) return "—";
  const sym = currency === "AED" ? "AED " : "₹";
  return sym + v.toLocaleString("en-IN", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 });
}
const num = (v) => v.toLocaleString("en-IN");

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
  return t;
}

const HEADS = ["Ads", "Spend", "Impressions", "Clicks", "CTR", "Conversations", "Leads", "Cost / conv."];
const cells = (t) => [num(t.ads), money(t.spend), num(t.impressions), num(t.clicks), t.ctr.toFixed(2) + "%", num(t.conv), num(t.leads), money(t.cpc)];
function table(first, rows, total, extraHead = []) {
  const head = `<tr><th>${first}</th>${extraHead.map((h) => `<th>${h}</th>`).join("")}${HEADS.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const body = rows.map((r) => `<tr${r.target ? ` class="link" data-target="${r.target}"` : ""}>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  const foot = total ? `<tr class="total">${total.map((c) => `<td>${c}</td>`).join("")}</tr>` : "";
  return `<div class="scroll"><table><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>`;
}

function adCard(a) {
  const ctr = a.impressions ? ((a.clicks / a.impressions) * 100).toFixed(2) : "0.00";
  const thumb = a.thumb ? `<img src="${esc(a.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith('No preview')">` : "No preview";
  return `<article class="ad"><div class="thumb">${thumb}</div><div><strong>${esc(a.name)}</strong><small>Ad set: ${esc(a.adset)}</small>
    <dl><dt>Spend</dt><dd>${money(a.spend)}</dd><dt>Impr.</dt><dd>${num(a.impressions)}</dd>
    <dt>Clicks</dt><dd>${num(a.clicks)}</dd><dt>CTR</dt><dd>${ctr}%</dd>
    <dt>Conv.</dt><dd>${num(a.conv)}</dd><dt>Leads</dt><dd>${num(a.leads)}</dd>
    <dt>Cost/conv.</dt><dd>${money(a.conv ? a.spend / a.conv : null)}</dd></dl></div></article>`;
}

function periodLabel(from, to) {
  const f = new Date(from + "T00:00:00"), t = new Date(to + "T00:00:00");
  const d = (x, o) => x.toLocaleDateString("en-GB", o);
  if (from === to) return d(t, { day: "numeric", month: "short", year: "numeric" });
  return f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()
    ? `${f.getDate()}–${d(t, { day: "numeric", month: "short", year: "numeric" })}`
    : `${d(f, { day: "numeric", month: "short" })} – ${d(t, { day: "numeric", month: "short", year: "numeric" })}`;
}

function render() {
  const account = $("account").value;
  const ads = data.ads.filter((a) => a.account === account).map((a) => ({ ...a, loc: locationOf(a), treat: treatmentOf(a) }));
  const out = $("report");
  if (!ads.length) {
    out.innerHTML = `<p class="status">No ads with spend for ${esc(account || "this client")} in this period.</p>`;
    return;
  }
  currency = ads[0].currency;
  const known = TREATMENTS.map((t) => t[0]);
  const groups = new Map();
  for (const a of ads) groups.set(a.treat, [...(groups.get(a.treat) || []), a]);
  const order = [...groups.keys()].sort((x, y) => ((known.indexOf(x) + 1 || 99) - (known.indexOf(y) + 1 || 99)) || totals(groups.get(y)).spend - totals(groups.get(x)).spend);
  const all = totals(ads);
  const period = periodLabel(data.from, data.to);
  document.title = `${account} — Ad Creatives — ${period}`;

  const tiles = [["Ads", num(all.ads)], ["Spend", money(all.spend)], ["Impressions", num(all.impressions)], ["Clicks", num(all.clicks)], ["CTR", all.ctr.toFixed(2) + "%"], ["Conversations", num(all.conv)], ["Leads", num(all.leads)], ["Cost / conv.", money(all.cpc)]];
  let html = `<section class="title"><h2>${esc(account)} — Ad Creatives — ${esc(period)}</h2>
    <p>Ads with spend in the period, grouped by campaign. Inside each campaign every location is shown separately with its own creatives, sorted by spend. Synced ${new Date(data.syncedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST.</p></section>
    <div class="tiles">${tiles.map(([l, v]) => `<div class="tile"><small>${l}</small><strong>${v}</strong></div>`).join("")}</div>`;

  html += `<h3>Campaigns at a glance</h3>` + table("Campaign",
    order.map((t, i) => {
      const g = groups.get(t);
      const locs = LOC_ORDER.filter((c) => g.some((a) => a.loc === c)).map((c) => (c === "ALL" ? "All" : c)).join(", ");
      return { target: "cp" + i, cells: [esc(t), locs, ...cells(totals(g))] };
    }),
    ["Total", "", ...cells(all)], ["Locations"]);

  const byLoc = LOC_ORDER.map((c) => [c, ads.filter((a) => a.loc === c)]).filter(([, l]) => l.length);
  html += `<h3>Spend by location</h3>` + table("Location", byLoc.map(([c, l]) => ({ cells: [LOC_LABEL[c], ...cells(totals(l))] })), ["Total", ...cells(all)]);
  html += `<p class="note">Location comes from the ad set or ad name (KNR, CLT, EKM/Kochi, CBE/Coimbatore). Conversations = messaging conversations started.</p>`;

  order.forEach((t, i) => {
    const g = groups.get(t);
    const locs = LOC_ORDER.filter((c) => g.some((a) => a.loc === c));
    html += `<section class="campaign" id="cp${i}"><header><h2>${esc(t)}</h2><p>Meta campaigns: ${[...new Set(g.map((a) => a.campaign))].map(esc).join(" · ")}</p></header>`;
    html += table("Location", locs.map((c) => ({ cells: [LOC_LABEL[c], ...cells(totals(g.filter((a) => a.loc === c)))] })), ["Total", ...cells(totals(g))]);
    for (const c of locs) {
      const la = g.filter((a) => a.loc === c).sort((x, y) => y.spend - x.spend);
      const lt = totals(la);
      html += `<div class="loc"><h4>${esc(t)} — ${LOC_LABEL[c]}<span>${lt.ads} ad${lt.ads === 1 ? "" : "s"} · ${money(lt.spend)} · ${num(lt.conv)} conv. · ${num(lt.leads)} leads</span></h4>
        <div class="ads">${la.map(adCard).join("")}</div></div>`;
    }
    html += `</section>`;
  });
  out.innerHTML = html;
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
  const yesterday = shift(istToday(), -1);
  $("to").value = yesterday;
  $("from").value = p === "mtd" ? yesterday.slice(0, 8) + "01" : shift(yesterday, 1 - Number(p));
}

async function load() {
  const params = new URLSearchParams({ from: $("from").value, to: $("to").value });
  history.replaceState(null, "", `?${params}&account=${encodeURIComponent($("account").value || "")}`);
  $("report").innerHTML = `<p class="status">Loading live Meta data… a new date range can take up to a minute.</p>`;
  try {
    const response = await fetch(`/api/creatives?${params}`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "request failed");
    data = await response.json();
  } catch (error) {
    $("report").innerHTML = `<p class="status">Could not load live data (${esc(error.message)}). Try again in a minute.</p>`;
    return;
  }
  const wanted = $("account").value || new URLSearchParams(location.search).get("account");
  $("account").innerHTML = data.accounts.map((a) => `<option ${a === wanted ? "selected" : ""}>${esc(a)}</option>`).join("");
  if (!data.accounts.includes(wanted) && data.accounts.includes("EDS Health care")) $("account").value = "EDS Health care";
  render();
}

const query = new URLSearchParams(location.search);
if (query.get("from") && query.get("to")) {
  $("from").value = query.get("from");
  $("to").value = query.get("to");
} else preset(7);
if (query.get("account")) $("account").innerHTML = `<option selected>${esc(query.get("account"))}</option>`;

$("filters").addEventListener("submit", (e) => { e.preventDefault(); load(); });
document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { preset(b.dataset.preset); load(); }));
$("account").addEventListener("change", () => {
  history.replaceState(null, "", `?from=${$("from").value}&to=${$("to").value}&account=${encodeURIComponent($("account").value)}`);
  if (data) render();
});
$("pdf").addEventListener("click", () => window.print());
$("report").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-target]");
  if (row) document.getElementById(row.dataset.target)?.scrollIntoView({ behavior: "smooth" });
});
load();
