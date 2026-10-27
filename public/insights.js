// Insights: account audit (findings, suggestions, breakdowns) with an AI-written summary on top.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const embed = new URLSearchParams(location.search).get("embed");
if (embed) document.body.classList.add("embed");

let me = null, live = null, data = null;

const num = (v) => Math.round(v).toLocaleString("en-IN");
function money(v) {
  if (v == null) return "—";
  const sym = data?.currency === "AED" ? "AED " : "₹";
  return sym + v.toLocaleString("en-IN", { maximumFractionDigits: v >= 100 ? 0 : 2 });
}
function shift(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function preset(p) {
  const end = live?.endDate || shift(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()), -1);
  $("to").value = end;
  $("from").value = p === "mtd" ? end.slice(0, 8) + "01" : shift(end, 1 - Number(p));
}
function period(from, to) {
  const f = new Date(from + "T00:00:00"), t = new Date(to + "T00:00:00");
  const o = { day: "numeric", month: "short" };
  return from === to ? t.toLocaleDateString("en-GB", { ...o, year: "numeric" }) : `${f.toLocaleDateString("en-GB", o)} – ${t.toLocaleDateString("en-GB", { ...o, year: "numeric" })}`;
}

// Small, safe markdown: paragraphs, **bold**, and - / 1. lists.
function markdown(text) {
  const lines = esc(text).split(/\n/);
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trim().replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/^#{1,4}\s*(.+)$/, "<strong>$1</strong>");
    const bullet = line.match(/^[-*•]\s+(.*)$/), ordered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { close(); html += `<${kind}>`; list = kind; }
      html += `<li>${(bullet || ordered)[1]}</li>`;
    } else if (!line) close();
    else { close(); html += `<p>${line}</p>`; }
  }
  close();
  return html;
}

function table(heads, rows) {
  return `<div class="scroll"><table><thead><tr>${heads.map((h, i) => `<th class="${i ? "num" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const breakdown = (list) => table(["", "Spend", "Clicks", "Conv.", "Cost / conv."], list.map((x) => [esc(x.key), money(x.spend), num(x.clicks), num(x.conv), money(x.cpc)]));

function aiCard() {
  const s = data.summary, canWrite = me && me.role !== "staff";
  const when = s ? new Date(s.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  let body;
  if (s) body = `<div class="text">${markdown(s.text)}</div><p class="note">Written ${esc(when)}${s.created_by ? " for " + esc(s.created_by) : ""} from the numbers below. Check before sharing.</p>`;
  else if (!data.openai) body = `<div class="notice">The AI summary needs OpenAI to be connected. An admin adds the key once on the server (deploy/vps/set-openai-key.sh). The findings and suggestions below work without it.</div>`;
  else body = `<p class="note">No summary for this client and period yet.${canWrite ? " Write one from the numbers below." : ""}</p>`;
  const button = data.openai && canWrite ? `<button type="button" class="dark" id="write">${s ? "Rewrite summary" : "Write summary"}</button>` : "";
  const copy = s ? `<button type="button" class="light" id="copy">Copy</button>` : "";
  return `<section class="card ai"><header><h3>AI summary</h3><small>${data.openai ? esc(data.model) : "OpenAI not connected"}</small><span class="grow">${copy}${button}</span></header>${body}</section>`;
}

function render() {
  const a = data.audit, t = a.totals;
  if (!t.spend) {
    $("out").innerHTML = `<p class="status">No spend for ${esc(data.account)} in ${esc(period(data.from, data.to))}.</p>`;
    return;
  }
  const tiles = [["Spend", money(t.spend)], ["Reach", num(t.reach)], ["Link clicks", num(t.clicks)], ["CTR", t.ctr.toFixed(2) + "%"], ["WA conversations", num(t.conv)], ["Cost / conv.", money(t.cpc)], ["Leads", num(t.leads)], ["Ads", num(t.ads)]];
  const maxConv = Math.max(1, ...a.hours.map((h) => h.conv));
  const topHours = [...a.hours].sort((x, y) => y.conv - x.conv).slice(0, 4).map((h) => h.hour);
  let html = embed ? `<div class="embed-tools"></div>` : "";
  html += `<section class="title"><h2>${esc(data.account)} — Insights — ${esc(period(data.from, data.to))}</h2><p>Meta ads audit: what is working, what is wasting money, and what to change. Nothing here changes anything in Meta.</p></section>`;
  html += `<div class="tiles">${tiles.map(([l, v]) => `<div class="tile"><small>${l}</small><strong>${v}</strong></div>`).join("")}</div>`;
  html += aiCard();
  html += `<section class="card"><header><h3>Findings</h3><small>${a.findings.length} from the numbers</small></header><div class="findings">${a.findings.map((f) => `<div class="finding ${f.severity}"><i class="dot"></i><div><strong>${esc(f.title)}</strong><span>${esc(f.detail)}</span></div></div>`).join("")}</div></section>`;
  html += `<section class="card"><header><h3>Suggested changes</h3><small>for whoever manages the ad account</small></header><ol class="suggest">${a.suggestions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>`;
  html += `<section class="card"><header><h3>Every ad</h3><small>goal, button and destination decide whether an ad can start WhatsApp chats</small></header>${table(
    ["Ad", "Spend", "Share", "Reach", "Freq.", "Clicks", "Conv.", "Cost / conv.", "Setup"],
    a.ads.map((x) => [`<strong>${esc(x.name)}</strong><br><small class="note">${esc(x.campaign)} · ${esc(x.adset)}</small>`, money(x.spend), x.share + "%", num(x.reach), x.frequency.toFixed(1), num(x.clicks), num(x.conv), money(x.cpc),
      `<span class="tag ${x.messaging ? "" : "warn"}">${x.messaging ? "WhatsApp" : esc(x.destination)}</span><br><small class="note">${esc(x.objective)} · ${esc(x.button)}</small>`]))}</section>`;
  html += `<div class="grid2"><section class="card"><header><h3>Placement</h3></header>${breakdown(a.placements)}</section>
    <section class="card"><header><h3>Time of day</h3><small>conversations by hour</small></header>
      <div class="bars">${a.hours.map((h) => `<div class="${topHours.includes(h.hour) && h.conv ? "top" : ""}" style="height:${Math.max(2, (h.conv / maxConv) * 100)}%" title="${h.hour}:00 · ${h.conv} conversations · ${money(h.cpc)} each"></div>`).join("")}</div>
      <div class="hours">${a.hours.map((h) => `<span>${h.hour % 3 === 0 ? h.hour : ""}</span>`).join("")}</div>
      ${breakdown(a.dayparts)}</section></div>`;
  html += `<div class="grid2"><section class="card"><header><h3>Age</h3></header>${breakdown(a.ages)}</section><section class="card"><header><h3>Gender</h3></header>${breakdown(a.genders)}<p class="note" style="margin-top:10px">Where the ads ran: ${a.regions.map((r) => `${esc(r.key)} ${Math.round((r.spend / t.spend) * 100)}%`).join(", ") || "—"}. Meta does not report conversations by town.</p></section></div>`;
  html += `<section class="card"><header><h3>Targeting by ad set</h3><small>as set in Ads Manager</small></header>${table(
    ["Ad set", "Location", "Excluded", "Ages", "Gender", "App language", "Interests"],
    a.targeting.map((x) => [`<strong>${esc(x.adset)}</strong><br><small class="note">${esc(x.campaign)}</small>`, esc(x.include.join("; ")), esc(x.exclude.join(", ") || "—"), esc(x.age), esc(x.genders), x.locales.length ? `<span class="tag warn">code ${esc(x.locales.join(", "))}</span>` : "All", esc(x.interests.join(", ") || "—")]))}</section>`;
  $("out").innerHTML = html;

  $("write")?.addEventListener("click", writeSummary);
  $("copy")?.addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(data.summary.text); e.target.textContent = "Copied"; } catch { e.target.textContent = "Copy failed"; }
    setTimeout(() => { e.target.textContent = "Copy"; }, 1500);
  });
}

async function writeSummary(e) {
  const button = e.target;
  button.disabled = true;
  button.textContent = "Writing…";
  try {
    const r = await fetch("/api/insights/summary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: data.account, from: data.from, to: data.to }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not write the summary.");
    data.summary = j.summary;
    render();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Try again";
    alert(error.message);
  }
}

async function load() {
  const params = new URLSearchParams({ account: $("account").value, from: $("from").value, to: $("to").value });
  if (!embed) history.replaceState(null, "", `?${params}`);
  $("out").innerHTML = `<p class="status">Analysing ${esc($("account").value)}… the first run for a date range takes up to a minute.</p>`;
  try {
    const r = await fetch(`/api/insights?${params}`);
    if (r.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); return; }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "request failed");
    data = j;
    render();
  } catch (error) {
    $("out").innerHTML = `<p class="status">Could not load the analysis (${esc(error.message)}). Try again in a minute.</p>`;
  }
}

$("filters").addEventListener("submit", (e) => { e.preventDefault(); load(); });
document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { preset(b.dataset.preset); load(); }));
$("account").addEventListener("change", load);

(async () => {
  const [meRes, liveRes] = await Promise.all([fetch("/api/auth/me"), fetch("/api/live")]);
  if (meRes.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); return; }
  me = (await meRes.json()).user;
  live = liveRes.ok ? await liveRes.json() : null;
  const q = new URLSearchParams(location.search);
  const names = (live?.accounts || []).filter((a) => Object.values(a.days || {}).some((d) => d.spend > 0)).map((a) => a.name).sort();
  const wanted = q.get("account") && names.includes(q.get("account")) ? q.get("account") : names.includes("Staxhaus") ? "Staxhaus" : names[0];
  $("account").innerHTML = names.map((n) => `<option ${n === wanted ? "selected" : ""}>${esc(n)}</option>`).join("");
  if (q.get("from") && q.get("to")) { $("from").value = q.get("from"); $("to").value = q.get("to"); } else preset(7);
  if (!names.length) { $("out").innerHTML = `<p class="status">No live accounts yet.</p>`; return; }
  load();
})();
