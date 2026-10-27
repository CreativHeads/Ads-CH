// Insights: account audit (findings, suggestions, breakdowns) with an AI-written summary on top.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const embed = new URLSearchParams(location.search).get("embed");
if (embed) document.body.classList.add("embed");

let me = null, live = null, data = null;

const svg = (d, cls = "ico") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  alert: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  users: svg('<path d="M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="8" r="4"/><path d="M22 20v-1a4 4 0 0 0-3-3.9M16 4.1a4 4 0 0 1 0 7.8"/>'),
  target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
};
const TONE = { high: ["Fix now", ICON.alert], medium: ["Worth a look", ICON.eye], good: ["Good news", ICON.check], info: ["FYI", ICON.info] };
const SECTION_ICON = { good: ICON.check, warn: ICON.eye, bad: ICON.alert, info: ICON.info };

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

// ---- AI summary: new saves are JSON (headline, sections, actions); older ones are markdown text ----
function parseSummary(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j && j.headline && Array.isArray(j.sections)) return j;
  } catch { /* parse as text/markdown */ }

  const lines = String(text).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const headline = lines[0];
  const sections = [];
  const actions = [];
  let currentSection = null;
  let inActions = false;

  const isHeader = (l) => {
    if (l.length > 55 || /[.!?]$/.test(l)) return false;
    if (/^(what to change|suggested changes|actions|recommended next steps|recommendations)/i.test(l)) return "actions";
    if (/^(location error|location mismatch|zero-conversation|zero-chat|no ad fatigue|ad fatigue|placement|time of day|age\/gender|age and gender|audience|overlap|language|targeting)/i.test(l)) return "section";
    if (/^[#*]{1,4}\s*(.+)$/.test(l)) return "section";
    return false;
  };

  const getTone = (title) => {
    const t = title.toLowerCase();
    if (/no\s*(ad\s*)?fatigue|good|best|cost-effective|efficient/.test(t)) return "good";
    if (/mismatch|wrong|error|zero|overlap|compete|silent|bad|waste/.test(t)) return "bad";
    if (/fatigue|lagged|watch|warn|limited|language/.test(t)) return "warn";
    return "info";
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const headerType = isHeader(line);
    if (headerType === "actions") {
      inActions = true;
      currentSection = null;
      continue;
    }
    if (headerType === "section") {
      inActions = false;
      const cleanTitle = line.replace(/^[#*]+\s*|\s*[*#]+$/g, "").trim();
      currentSection = { title: cleanTitle, tone: getTone(cleanTitle), points: [] };
      sections.push(currentSection);
      continue;
    }
    if (inActions) {
      const match = line.match(/^(\d+[.)]|\*|-)\s*(?:[*]{2})?([^*:]+)(?:[*]{2})?[:\-]?\s*(.*)$/);
      if (match) {
        actions.push({ title: match[2].trim(), detail: match[3]?.trim() || "", impact: "high" });
      } else {
        actions.push({ title: line, detail: "", impact: "medium" });
      }
    } else if (currentSection) {
      currentSection.points.push(line.replace(/^[-*•]\s+/, ""));
    }
  }

  return { headline, verdict: "mixed", sections, actions };
}
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
function summaryText(s) {
  const j = parseSummary(s.text);
  if (!j) return s.text;
  return [`*${data.account} — ${period(data.from, data.to)}*`, "", j.headline, "",
    ...j.sections.flatMap((x) => [`*${x.title}*`, ...(x.points || []).map((p) => `• ${p}`), ""]),
    "*What to change*", ...(j.actions || []).map((a, i) => `${i + 1}. ${a.title}: ${a.detail}`)].join("\n");
}
function aiBody(s) {
  const j = parseSummary(s.text);
  if (!j) return `<div class="text">${markdown(s.text)}</div>`;
  const verdict = { good: "Going well", mixed: "Mixed", poor: "Needs work" }[j.verdict];
  return `<div class="headline">${ICON.spark}<p>${esc(j.headline)}</p></div>
    ${verdict ? `<p style="margin:-6px 0 14px"><span class="pill ${esc(j.verdict)}">Overall: ${verdict}</span></p>` : ""}
    <div class="sections">${j.sections.map((x) => {
      const tone = ["good", "warn", "bad", "info"].includes(x.tone) ? x.tone : "info";
      return `<div class="section ${tone}"><h4>${SECTION_ICON[tone]}${esc(x.title)}</h4>${(x.points || []).map((p) => `<p>${esc(p)}</p>`).join("")}</div>`;
    }).join("")}</div>
    ${(j.actions || []).length ? `<p class="actions-title">What to change</p><ol class="actions">${j.actions.map((a) => `<li><div><strong>${esc(a.title)}</strong><span>${esc(a.detail)}</span></div><span class="pill ${["high", "medium", "low"].includes(a.impact) ? a.impact : "low"}">${esc(a.impact || "low")} impact</span></li>`).join("")}</ol>` : ""}`;
}
function aiCard() {
  const s = data.summary, canWrite = me && me.role !== "staff";
  const when = s ? new Date(s.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  let body;
  if (s) body = aiBody(s) + `<p class="footnote">Written ${esc(when)}${s.created_by ? " for " + esc(s.created_by) : ""} from the numbers on this page. Nothing was changed in Meta. Check before sharing.</p>`;
  else if (!data.openai) body = `<div class="notice">${ICON.info}<div>The AI summary needs OpenAI to be connected. An admin adds the key once on the server. The findings and suggestions below work without it.</div></div>`;
  else body = `<div class="empty"><span>No summary for ${esc(data.account)} in this period yet.</span>${canWrite ? `<button type="button" class="btn dark" data-write>${ICON.spark}Write summary</button>` : ""}</div>`;
  const tools = s ? `<span class="tools"><button type="button" class="btn light" id="copy">Copy text</button>${data.openai && canWrite ? `<button type="button" class="btn dark" data-write>${ICON.spark}Rewrite</button>` : ""}</span>` : "";
  return `<section class="card ai"><div class="card-head"><h3>${ICON.spark}AI summary</h3><span class="pill model">${data.openai ? esc(data.model) : "OpenAI not connected"}</span>${tools}</div>${body}</section>`;
}

// ---- breakdown rows: bar = share of conversations; numbers written out ----
function rows(list, totalConv) {
  const useful = list.filter((x) => x.spend >= 1);
  if (!useful.length) return `<p class="footnote">No data for this period.</p>`;
  const best = useful.filter((x) => x.conv >= Math.max(3, totalConv * 0.15)).sort((a, b) => a.cpc - b.cpc)[0];
  const max = Math.max(1, ...useful.map((x) => x.conv));
  return `<div class="rows">${useful.slice(0, 8).map((x) => `<div class="brow">
      <div class="name">${esc(x.key)}${best && x.key === best.key ? `<span class="best">best cost</span>` : ""}<small>${money(x.spend)} · ${num(x.clicks)} clicks</small></div>
      <div class="track" role="img" aria-label="${esc(x.key)}: ${x.conv} conversations"><div class="fill" style="width:${(x.conv / max) * 100}%"></div></div>
      <div class="val"><b>${num(x.conv)}</b> conv.<small>${money(x.cpc)} each</small></div></div>`).join("")}</div>
    <details class="table"><summary>Show as table</summary><div class="scroll"><table><thead><tr><th></th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">Conv.</th><th class="num">Cost / conv.</th></tr></thead><tbody>${list.map((x) => `<tr><td>${esc(x.key)}</td><td class="num">${money(x.spend)}</td><td class="num">${num(x.clicks)}</td><td class="num">${num(x.conv)}</td><td class="num">${money(x.cpc)}</td></tr>`).join("")}</tbody></table></div></details>`;
}
function hourChart(hours) {
  const max = Math.max(1, ...hours.map((h) => h.conv));
  const top = [...hours].sort((x, y) => y.conv - x.conv).slice(0, 4).filter((h) => h.conv).map((h) => h.hour);
  const label = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
  return `<div class="chart"><div class="plot">${hours.map((h) => `<div class="col ${top.includes(h.hour) ? "top" : ""}" tabindex="0" aria-label="${label(h.hour)}: ${h.conv} conversations, ${money(h.spend)} spent">
      <i style="height:${Math.max(1.5, (h.conv / max) * 100)}%"></i><span class="tip">${label(h.hour)}–${label((h.hour + 1) % 24)} · <b>${h.conv}</b> conv. · ${money(h.cpc)} each</span></div>`).join("")}</div>
    <div class="axis">${hours.map((h) => `<span>${h.hour % 3 === 0 ? label(h.hour) : ""}</span>`).join("")}</div></div>`;
}

const FINDING_SECTIONS = [
  { key: "high", label: "Fix now", ico: ICON.alert },
  { key: "medium", label: "Worth a look", ico: ICON.eye },
  { key: "good", label: "Good news", ico: ICON.check },
  { key: "info", label: "FYI", ico: ICON.info },
];

function renderFindingsList(allFindings, filter) {
  const items = allFindings.filter((f) => f.severity === filter);
  if (!items.length) {
    return `<div class="empty" style="margin-top:10px"><p>No findings in this category.</p></div>`;
  }

  return `<div class="findings">
    ${items.map((f) => {
      const [lab, ico] = TONE[f.severity] || TONE.info;
      return `<div class="finding ${f.severity} ${f.detail.length > 260 ? "wide" : ""}">
        <span class="badge">${ico}</span>
        <div>
          <span class="label">${lab}</span>
          <strong>${esc(f.title)}</strong>
          <span class="detail">${esc(f.detail)}</span>
        </div>
      </div>`;
    }).join("")}
  </div>`;
}

function render() {
  const a = data.audit, t = a.totals;
  if (!t.spend) {
    $("out").innerHTML = `<div class="status">No spend for ${esc(data.account)} in ${esc(period(data.from, data.to))}.</div>`;
    return;
  }
  const kpis = [["Spend", money(t.spend), true], ["WA conversations", num(t.conv)], ["Cost / conversation", money(t.cpc)], ["Reach", num(t.reach)], ["Link clicks", num(t.clicks)], ["CTR", t.ctr.toFixed(2) + "%"], ["Leads", num(t.leads)], ["Ads running", num(t.ads)]];
  const order = { high: 0, medium: 1, good: 2, info: 3 };
  const findings = [...a.findings].sort((x, y) => order[x.severity] - order[y.severity]);
  const mismatchMap = new Map((a.locationMismatches || []).map((m) => [m.adset, m]));

  const availableSections = FINDING_SECTIONS.filter((s) => findings.some((f) => f.severity === s.key));
  const defaultSection = availableSections[0] || FINDING_SECTIONS[0];
  const defaultFilter = defaultSection.key;
  const defaultCount = findings.filter((f) => f.severity === defaultFilter).length;

  let html = `<section class="hero"><div><div class="eyebrow">Meta ads audit</div><h2>${esc(data.account)}</h2><p>What is working, what is wasting money, and what to change. Nothing here changes anything in Meta.</p></div>
    <div class="chips"><span class="chip">${esc(period(data.from, data.to))}</span><span class="chip"><i class="dot"></i>Live Meta data</span></div></section>`;
  html += `<div class="kpis">${kpis.map(([l, v, accent]) => `<div class="kpi ${accent ? "accent" : ""}"><small>${l}</small><strong>${v}</strong></div>`).join("")}</div>`;
  html += aiCard();
  html += `<section class="card" id="findings-card">
    <div class="card-head findings-head">
      <div>
        <h3>${ICON.alert}Findings</h3>
        <small id="findings-counter">${defaultCount} ${defaultSection.label.toLowerCase()} item${defaultCount !== 1 ? 's' : ''} from the numbers</small>
      </div>
      <div class="findings-filter" role="tablist" aria-label="Filter findings by category">
        ${availableSections.map((s) => {
          const count = findings.filter((f) => f.severity === s.key).length;
          const isActive = s.key === defaultFilter;
          return `<button type="button" class="filter-btn ${s.key} ${isActive ? 'active' : ''}" data-filter="${s.key}">${s.ico}${s.label} <span class="count">${count}</span></button>`;
        }).join("")}
      </div>
    </div>
    <div id="findings-body">
      ${renderFindingsList(findings, defaultFilter)}
    </div>
  </section>`;
  html += `<section class="card"><div class="card-head"><h3>${ICON.list}Suggested changes</h3><small>for whoever manages the ad account</small></div><ol class="steps">${a.suggestions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>`;
  html += `<div class="grid2 row-gap"><section class="card"><div class="card-head"><h3>${ICON.grid}Placement</h3><small>conversations and cost per conversation</small></div>${rows(a.placements, t.conv)}</section>
    <section class="card"><div class="card-head"><h3>${ICON.clock}Time of day</h3><small>conversations by hour · hover a bar</small></div>${hourChart(a.hours)}${rows(a.dayparts, t.conv)}</section></div>`;
  html += `<div class="grid2 row-gap"><section class="card"><div class="card-head"><h3>${ICON.users}Age</h3></div>${rows(a.ages, t.conv)}</section>
    <section class="card"><div class="card-head"><h3>${ICON.users}Gender</h3></div>${rows(a.genders, t.conv)}<p class="footnote">Where the ads ran: ${a.regions.filter((r) => r.spend >= t.spend * 0.01).map((r) => `${esc(r.key)} ${Math.round((r.spend / t.spend) * 100)}%`).join(", ") || "—"}. Meta does not report conversations by town.</p></section></div>`;
  html += `<section class="card"><div class="card-head"><h3>${ICON.chart}Every ad</h3><small>goal, button and destination decide whether an ad can start WhatsApp chats</small></div><div class="ads">${a.ads.map((x) => {
    const mis = mismatchMap.get(x.adset);
    let tagHtml;
    if (!x.messaging) {
      tagHtml = `<span class="tag warn" title="Not WhatsApp destination">Profile visit</span>`;
    } else if (mis) {
      tagHtml = `<span class="tag" style="background:#fee2e2;color:#991b1b;border:1px solid #f87171" title="Targeting location error">Wrong location</span>`;
    } else {
      tagHtml = `<span class="tag">WhatsApp</span>`;
    }
    return `<div class="ad">
      <div class="ad-top"><div><strong>${esc(x.name)}</strong><small>${esc(x.campaign)} · ${esc(x.adset)}</small></div>${tagHtml}</div>
      <div class="share" title="${x.share}% of spend"><i style="width:${x.share}%"></i></div>
      <div class="mini"><div><small>Spend</small><b>${money(x.spend)}</b></div><div><small>Conv.</small><b>${num(x.conv)}</b></div><div><small>Cost / conv.</small><b>${money(x.cpc)}</b></div><div><small>Frequency</small><b>${x.frequency.toFixed(1)}×</b></div></div>
      <div class="setup">${x.share}% of spend · ${num(x.reach)} reached · ${num(x.clicks)} clicks · ${esc(x.objective)} goal · button “${esc(x.button)}”</div></div>`;
  }).join("")}</div></section>`;
  html += `<section class="card"><div class="card-head"><h3>${ICON.target}Targeting by ad set</h3><small>as set in Ads Manager</small></div><div class="targets">${a.targeting.map((x) => {
    const mis = mismatchMap.get(x.adset);
    return `<div class="target ${mis ? "has-mismatch" : ""}">
      ${mis ? `<div style="background:#fef2f2;border:1px solid #f87171;color:#991b1b;border-radius:6px;padding:6px 10px;margin-bottom:10px;font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px">⚠️ Location mismatch: targets ${esc(mis.actual)} instead of ${esc(mis.expected)}</div>` : ""}
      <h4>${esc(x.adset)}<small>${esc(x.campaign)}</small></h4><dl>
      <dt>Location</dt><dd>${esc(x.include.join("; "))}</dd>
      ${x.exclude.length ? `<dt>Excluded</dt><dd>${esc(x.exclude.join(", "))}</dd>` : ""}
      <dt>Ages</dt><dd>${esc(x.age)} · ${esc(x.genders)}</dd>
      <dt>App language</dt><dd>${x.locales.length ? `<span class="tag warn">Limited · code ${esc(x.locales.join(", "))}</span>` : "All languages"}</dd>
      <dt>Interests</dt><dd>${esc(x.interests.join(", ") || "None (broad)")}</dd></dl></div>`;
  }).join("") || `<p class="footnote">No targeting details for this period.</p>`}</div></section>`;
  $("out").innerHTML = html;

  document.querySelectorAll(".findings-filter .filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".findings-filter .filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filterKey = btn.dataset.filter;
      const sec = FINDING_SECTIONS.find((s) => s.key === filterKey);
      const count = findings.filter((f) => f.severity === filterKey).length;
      const counterEl = $("findings-counter");
      if (counterEl) {
        counterEl.textContent = `${count} ${sec ? sec.label.toLowerCase() : filterKey} item${count !== 1 ? 's' : ''} from the numbers`;
      }
      const bodyEl = $("findings-body");
      if (bodyEl) {
        bodyEl.innerHTML = renderFindingsList(findings, filterKey);
      }
    });
  });

  document.querySelectorAll("[data-write]").forEach((b) => b.addEventListener("click", writeSummary));
  $("copy")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(summaryText(data.summary)); b.textContent = "Copied"; } catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy text"; }, 1500);
  });
}

async function writeSummary(e) {
  const button = e.currentTarget;
  button.disabled = true;
  button.textContent = "Writing… about 15 seconds";
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

function skeletonInsights(acc) {
  const accountName = esc(acc || "client");
  return `
    <div class="skeleton-pill"><span class="pulse-dot"></span>Analysing ${accountName}… live Meta audit in progress</div>
    <section class="hero" aria-hidden="true">
      <div style="flex:1">
        <span class="ch-skeleton ch-skeleton-text" style="width:110px;height:12px;margin-bottom:8px"></span>
        <div class="ch-skeleton" style="width:240px;height:34px;margin-bottom:8px"></div>
        <div class="ch-skeleton ch-skeleton-text" style="width:380px;height:14px"></div>
      </div>
      <div class="chips">
        <div class="ch-skeleton" style="width:130px;height:28px;border-radius:99px"></div>
        <div class="ch-skeleton" style="width:110px;height:28px;border-radius:99px"></div>
      </div>
    </section>
    <div class="kpis" aria-hidden="true">
      <div class="kpi accent"><span class="ch-skeleton ch-skeleton-dark ch-skeleton-text" style="width:50%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton ch-skeleton-dark" style="width:80%;height:26px"></div></div>
      <div class="kpi"><span class="ch-skeleton ch-skeleton-text" style="width:60%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton" style="width:75%;height:26px"></div></div>
      <div class="kpi"><span class="ch-skeleton ch-skeleton-text" style="width:55%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton" style="width:80%;height:26px"></div></div>
      <div class="kpi"><span class="ch-skeleton ch-skeleton-text" style="width:50%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton" style="width:70%;height:26px"></div></div>
      <div class="kpi"><span class="ch-skeleton ch-skeleton-text" style="width:55%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton" style="width:75%;height:26px"></div></div>
      <div class="kpi"><span class="ch-skeleton ch-skeleton-text" style="width:45%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton" style="width:65%;height:26px"></div></div>
      <div class="kpi"><span class="ch-skeleton ch-skeleton-text" style="width:50%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton" style="width:70%;height:26px"></div></div>
      <div class="kpi"><span class="ch-skeleton ch-skeleton-text" style="width:60%;height:11px;margin-bottom:8px"></span><div class="ch-skeleton" style="width:75%;height:26px"></div></div>
    </div>
    <section class="card" aria-hidden="true" style="padding:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="ch-skeleton ch-skeleton-circle" style="width:22px;height:22px"></div>
          <div class="ch-skeleton" style="width:160px;height:18px"></div>
        </div>
        <div class="ch-skeleton" style="width:90px;height:24px;border-radius:99px"></div>
      </div>
      <div class="ch-skeleton" style="width:92%;height:20px;margin-bottom:12px"></div>
      <div class="ch-skeleton" style="width:65%;height:14px;margin-bottom:20px"></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:20px">
        <div style="background:#f8fafd;border:1px solid #eef2f6;border-radius:12px;padding:16px"><div class="ch-skeleton" style="width:40%;height:14px;margin-bottom:12px"></div><div class="ch-skeleton ch-skeleton-text" style="width:95%"></div><div class="ch-skeleton ch-skeleton-text" style="width:88%"></div><div class="ch-skeleton ch-skeleton-text" style="width:70%"></div></div>
        <div style="background:#f8fafd;border:1px solid #eef2f6;border-radius:12px;padding:16px"><div class="ch-skeleton" style="width:40%;height:14px;margin-bottom:12px"></div><div class="ch-skeleton ch-skeleton-text" style="width:95%"></div><div class="ch-skeleton ch-skeleton-text" style="width:88%"></div><div class="ch-skeleton ch-skeleton-text" style="width:70%"></div></div>
        <div style="background:#f8fafd;border:1px solid #eef2f6;border-radius:12px;padding:16px"><div class="ch-skeleton" style="width:40%;height:14px;margin-bottom:12px"></div><div class="ch-skeleton ch-skeleton-text" style="width:95%"></div><div class="ch-skeleton ch-skeleton-text" style="width:88%"></div><div class="ch-skeleton ch-skeleton-text" style="width:70%"></div></div>
      </div>
      <div style="border-top:1px solid #eef2f6;padding-top:16px">
        <div class="ch-skeleton" style="width:140px;height:14px;margin-bottom:12px"></div>
        <div style="display:flex;gap:10px;margin-bottom:10px;align-items:center"><div class="ch-skeleton ch-skeleton-circle" style="width:18px;height:18px"></div><div class="ch-skeleton" style="flex:1;height:14px"></div></div>
        <div style="display:flex;gap:10px;margin-bottom:10px;align-items:center"><div class="ch-skeleton ch-skeleton-circle" style="width:18px;height:18px"></div><div class="ch-skeleton" style="flex:1;height:14px"></div></div>
      </div>
    </section>
    <section class="card" aria-hidden="true" style="padding:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:12px">
        <div>
          <div class="ch-skeleton" style="width:120px;height:18px;margin-bottom:6px"></div>
          <div class="ch-skeleton ch-skeleton-text" style="width:180px;height:12px"></div>
        </div>
        <div style="display:flex;gap:8px">
          <div class="ch-skeleton" style="width:88px;height:32px;border-radius:99px"></div>
          <div class="ch-skeleton" style="width:110px;height:32px;border-radius:99px"></div>
          <div class="ch-skeleton" style="width:96px;height:32px;border-radius:99px"></div>
          <div class="ch-skeleton" style="width:70px;height:32px;border-radius:99px"></div>
        </div>
      </div>
      <div class="findings">
        <div class="finding" style="border-left-color:#e2e8f0"><div class="ch-skeleton ch-skeleton-circle" style="width:28px;height:28px"></div><div style="flex:1"><div class="ch-skeleton" style="width:60px;height:10px;margin-bottom:6px"></div><div class="ch-skeleton" style="width:220px;height:16px;margin-bottom:8px"></div><div class="ch-skeleton ch-skeleton-text" style="width:90%"></div><div class="ch-skeleton ch-skeleton-text" style="width:75%"></div></div></div>
        <div class="finding" style="border-left-color:#e2e8f0"><div class="ch-skeleton ch-skeleton-circle" style="width:28px;height:28px"></div><div style="flex:1"><div class="ch-skeleton" style="width:60px;height:10px;margin-bottom:6px"></div><div class="ch-skeleton" style="width:220px;height:16px;margin-bottom:8px"></div><div class="ch-skeleton ch-skeleton-text" style="width:90%"></div><div class="ch-skeleton ch-skeleton-text" style="width:75%"></div></div></div>
        <div class="finding" style="border-left-color:#e2e8f0"><div class="ch-skeleton ch-skeleton-circle" style="width:28px;height:28px"></div><div style="flex:1"><div class="ch-skeleton" style="width:60px;height:10px;margin-bottom:6px"></div><div class="ch-skeleton" style="width:220px;height:16px;margin-bottom:8px"></div><div class="ch-skeleton ch-skeleton-text" style="width:90%"></div><div class="ch-skeleton ch-skeleton-text" style="width:75%"></div></div></div>
      </div>
    </section>
  `;
}

async function load() {
  const params = new URLSearchParams({ account: $("account").value, from: $("from").value, to: $("to").value });
  if (!embed) history.replaceState(null, "", `?${params}`);
  $("out").innerHTML = skeletonInsights($("account").value);
  try {
    const r = await fetch(`/api/insights?${params}`);
    if (r.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); return; }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "request failed");
    data = j;
    render();
  } catch (error) {
    $("out").innerHTML = `<div class="status">Could not load the analysis (${esc(error.message)}). Try again in a minute.</div>`;
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
  if (!names.length) { $("out").innerHTML = `<div class="status">No live accounts yet.</div>`; return; }
  load();
})();
