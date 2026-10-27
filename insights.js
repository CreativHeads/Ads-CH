// Account audit for the Insights page: pulls Meta breakdowns through Windsor (ads with their
// goal/button/destination, placement, age and gender, hour of day, region, ad-set targeting),
// turns them into findings and suggestions, and asks OpenAI for a plain-English summary.
// Nothing here changes anything in Meta.

const CONV = "actions_onsite_conversion_messaging_conversation_started_7d";
const BASE = `account_name,spend,impressions,link_clicks,actions_lead,${CONV}`;
const QUERIES = {
  ads: `account_name,campaign,campaign_objective,adset_name,adset_optimization_goal,adset_destination_type,ad_name,call_to_action_type,spend,impressions,reach,frequency,link_clicks,actions_lead,${CONV}`,
  placement: `${BASE},publisher_platform,platform_position`,
  demo: `${BASE},age,gender`,
  hour: `${BASE},hourly_stats_aggregated_by_advertiser_time_zone`,
  region: `${BASE},region`,
  targeting: "account_name,campaign,adset_name,adset_targeting,spend",
};
const MESSAGING_DESTINATIONS = ["WHATSAPP", "MESSENGER", "INSTAGRAM_DIRECT", "MESSAGING_INSTAGRAM_DIRECT_MESSENGER", "MESSAGING_MESSENGER_WHATSAPP", "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP", "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP"];
const LABELS = {
  OUTCOME_AWARENESS: "Awareness", OUTCOME_ENGAGEMENT: "Engagement", OUTCOME_LEADS: "Leads", OUTCOME_SALES: "Sales", OUTCOME_TRAFFIC: "Traffic", OUTCOME_APP_PROMOTION: "App promotion",
  CONVERSATIONS: "Conversations", PROFILE_AND_PAGE_ENGAGEMENT: "Profile visits", REACH: "Reach", LINK_CLICKS: "Link clicks", LEAD_GENERATION: "Instant form leads", THRUPLAY: "Video views", POST_ENGAGEMENT: "Post engagement",
  WHATSAPP: "WhatsApp", MESSENGER: "Messenger", INSTAGRAM_PROFILE: "Instagram profile", ON_AD: "Instant form", WEBSITE: "Website", UNDEFINED: "Not set",
  WHATSAPP_MESSAGE: "Send WhatsApp message", VIEW_INSTAGRAM_PROFILE: "View Instagram profile", LEARN_MORE: "Learn more", MESSAGE_PAGE: "Send message", SIGN_UP: "Sign up", CALL_NOW: "Call now",
};
const label = (v) => LABELS[v] || String(v || "Not set").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const POSITION = { feed: "Feed", facebook_reels: "Reels", instagram_reels: "Reels", instagram_stories: "Stories", facebook_stories: "Stories", story: "Stories", reels: "Reels", explore: "Explore", explore_home: "Explore home", marketplace: "Marketplace", video_feeds: "Video feeds", search: "Search", an_classic: "Audience Network", instream_video: "In-stream video", profile_feed: "Profile feed", instagram_profile_reels: "Profile reels", facebook_profile_feed: "Profile feed" };

const n = (v) => Number(v) || 0;
const metrics = (rows) => {
  const t = { spend: 0, impressions: 0, clicks: 0, conv: 0, leads: 0 };
  for (const r of rows) { t.spend += n(r.spend); t.impressions += n(r.impressions); t.clicks += n(r.link_clicks); t.conv += n(r[CONV]); t.leads += n(r.actions_lead); }
  t.cpc = t.conv ? t.spend / t.conv : null;
  t.ctr = t.impressions ? (t.clicks / t.impressions) * 100 : 0;
  return t;
};
const group = (rows, key) => {
  const g = new Map();
  for (const r of rows) { const k = key(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  return [...g.entries()].map(([k, list]) => ({ key: k, ...metrics(list) })).filter((x) => x.spend > 0).sort((a, b) => b.spend - a.spend);
};
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

function parseTargeting(raw) {
  let t = raw;
  if (typeof t === "string") { try { t = JSON.parse(t); } catch { return null; } }
  if (!t || typeof t !== "object") return null;
  const geo = t.geo_locations || {}, ex = t.excluded_geo_locations || {};
  const place = (p) => `${p.radius ? `${p.radius} km around ` : ""}${p.name || p.address_string || (p.latitude ? `${Number(p.latitude).toFixed(3)}, ${Number(p.longitude).toFixed(3)}` : "a pin")}`;
  const include = [...(geo.custom_locations || []), ...(geo.places || []), ...(geo.cities || [])].map(place)
    .concat((geo.regions || []).map((r) => r.name), (geo.countries || []).map((c) => c));
  const exclude = [...(ex.custom_locations || []), ...(ex.places || []), ...(ex.cities || [])].map((p) => p.name || place(p)).concat((ex.regions || []).map((r) => r.name));
  const interests = [];
  for (const spec of t.flexible_spec || []) for (const k of ["interests", "behaviors", "work_positions", "education_majors", "industries", "life_events"]) for (const i of spec[k] || []) interests.push(i.name);
  for (const k of ["interests", "behaviors"]) for (const i of t[k] || []) interests.push(i.name);
  const genders = (t.genders || []).map((g) => (g === 1 ? "men" : g === 2 ? "women" : g));
  return {
    age: `${t.age_min || 18}–${t.age_max || 65}`,
    genders: genders.length ? genders.join(", ") : "all",
    include: include.length ? include : ["Not set"],
    exclude,
    locales: t.locales || [],
    interests: [...new Set(interests)],
    signature: JSON.stringify([geo, ex, t.age_min, t.age_max, t.genders || [], t.locales || [], t.flexible_spec || []]),
  };
}

const daypart = (h) => (h < 6 ? "Night (12–6 AM)" : h < 12 ? "Morning (6 AM–12 PM)" : h < 18 ? "Afternoon (12–6 PM)" : "Evening (6 PM–12 AM)");

export function buildAudit(raw, account, money) {
  const mine = (rows) => (rows || []).filter((r) => r.account_name === account && n(r.spend) > 0);
  const adsRaw = mine(raw.ads);
  const totals = metrics(adsRaw);
  const reach = adsRaw.reduce((s, r) => s + n(r.reach), 0);

  const ads = adsRaw.map((r) => {
    const m = metrics([r]);
    const destination = String(r.adset_destination_type || "");
    const messaging = MESSAGING_DESTINATIONS.includes(destination) || r.call_to_action_type === "WHATSAPP_MESSAGE" || r.adset_optimization_goal === "CONVERSATIONS";
    return {
      name: String(r.ad_name || "").trim(), campaign: r.campaign, adset: r.adset_name, ...m,
      reach: n(r.reach), frequency: n(r.frequency), share: pct(m.spend, totals.spend),
      objective: label(r.campaign_objective), goal: label(r.adset_optimization_goal), destination: label(destination || "UNDEFINED"), button: label(r.call_to_action_type),
      messaging, costPerClick: m.clicks ? m.spend / m.clicks : null,
    };
  }).sort((a, b) => b.spend - a.spend);

  const placements = group(mine(raw.placement), (r) => `${r.publisher_platform === "instagram" ? "Instagram" : r.publisher_platform === "facebook" ? "Facebook" : label(r.publisher_platform)} ${POSITION[r.platform_position] || label(r.platform_position)}`);
  const demoRows = mine(raw.demo);
  const ages = group(demoRows, (r) => r.age || "Unknown");
  const genders = group(demoRows, (r) => (r.gender === "female" ? "Women" : r.gender === "male" ? "Men" : "Unknown"));
  const hourRows = mine(raw.hour).map((r) => ({ ...r, h: parseInt(String(r.hourly_stats_aggregated_by_advertiser_time_zone || "0"), 10) || 0 }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...metrics(hourRows.filter((r) => r.h === h)) }));
  const dayparts = group(hourRows, (r) => daypart(r.h));
  const regions = group(mine(raw.region), (r) => r.region || "Unknown");

  const seen = new Map();
  for (const r of mine(raw.targeting)) {
    const key = `${r.campaign}|${r.adset_name}`;
    const prev = seen.get(key);
    if (prev) { prev.spend += n(r.spend); continue; }
    const t = parseTargeting(r.adset_targeting);
    if (t) seen.set(key, { campaign: r.campaign, adset: r.adset_name, spend: n(r.spend), ...t });
  }
  const targeting = [...seen.values()].sort((a, b) => b.spend - a.spend);
  const overlapGroups = [...group(targeting.map((t) => ({ ...t, spend: t.spend })), (t) => t.signature)]
    .map((g) => targeting.filter((t) => t.signature === g.key)).filter((list) => list.length > 1);

  // ---- findings: each one is a fact backed by the numbers above ----
  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, title, detail });
  const m = (v) => money(v);

  const notMessaging = ads.filter((a) => a.conv === 0 && !a.messaging);
  if (notMessaging.length) {
    const spend = notMessaging.reduce((s, a) => s + a.spend, 0);
    add("high", `${notMessaging.length} ad${notMessaging.length > 1 ? "s" : ""} with no conversations ${notMessaging.length > 1 ? "are" : "is"} not set up for WhatsApp chats`,
      notMessaging.map((a) => `${a.name}: ${a.objective} goal, optimising for ${a.goal.toLowerCase()}, button "${a.button}", destination ${a.destination}. ${m(a.spend)} spent, ${a.clicks} link clicks at ${m(a.costPerClick)} each.`).join("\n")
      + `\nTogether ${m(spend)}. Fine if the aim is reach or profile visits; rebuild them as WhatsApp conversation ads if chats are the goal.`);
  }
  const silentMessaging = ads.filter((a) => a.conv === 0 && a.messaging && a.spend >= Math.max(300, totals.spend * 0.05));
  if (silentMessaging.length) add("high", "WhatsApp ads spending without starting chats", silentMessaging.map((a) => `${a.name}: ${m(a.spend)}, ${a.clicks} clicks, 0 conversations.`).join("\n") + "\nCheck the creative, the WhatsApp number and the greeting message.");

  const maxFreq = Math.max(0, ...ads.map((a) => a.frequency));
  if (maxFreq >= 3) add("medium", "Some people are seeing the same ad too often", ads.filter((a) => a.frequency >= 3).map((a) => `${a.name}: ${a.frequency.toFixed(1)} times per person.`).join(" ") + " Expect cost per conversation to rise; refresh the creative or widen the audience.");
  else if (ads.length) add("good", "No ad fatigue", `People saw each ad ${Math.min(...ads.map((a) => a.frequency)).toFixed(1)}–${maxFreq.toFixed(1)} times in the period.`);

  const top = ads[0];
  if (top && top.share >= 60 && ads.length > 1) add("info", `${top.name} carries ${top.share}% of spend`, `${m(top.spend)} of ${m(totals.spend)}, ${top.conv} conversations at ${m(top.cpc)} each. Results depend heavily on this one ad.`);

  const withConv = (list) => list.filter((x) => x.conv > 0);
  const enough = (x) => x.conv >= Math.max(5, totals.conv * 0.15);
  const bestOf = (list) => withConv(list).filter(enough).sort((a, b) => a.cpc - b.cpc)[0];
  const compare = (list, what) => {
    const ok = withConv(list).filter((x) => x.conv >= 3 && x.spend >= totals.spend * 0.05);
    const best = bestOf(list);
    if (!best || ok.length < 2 || !totals.conv) return;
    const worst = [...ok].sort((a, b) => b.cpc - a.cpc)[0];
    if (worst.cpc < best.cpc * 1.3) return;
    add("medium", `${what}: ${best.key} brings chats at the best cost`, `${best.key} brought ${best.conv} conversations (${pct(best.conv, totals.conv)}%) at ${m(best.cpc)} each${worst.key !== best.key ? `, against ${m(worst.cpc)} for ${worst.key}` : ""}.`);
  };
  compare(placements, "Placement");
  compare(dayparts, "Time of day");
  compare(ages, "Age");
  const clickHeavy = placements.filter((p) => p.clicks >= 30 && p.conv <= 1 && p.spend >= totals.spend * 0.08);
  if (clickHeavy.length) add("medium", "Placements with clicks but almost no chats", clickHeavy.map((p) => `${p.key}: ${m(p.spend)}, ${p.clicks} clicks, ${p.conv} conversations.`).join(" "));

  for (const list of overlapGroups) {
    add("medium", "Ad sets compete for the same people", `${list.map((t) => `${t.adset} (${t.campaign})`).join(", ")} have identical targeting (${list[0].include.slice(0, 2).join("; ")}, ages ${list[0].age}). When they run together they bid against each other; combine them into one ad set.`);
  }
  const locales = targeting.filter((t) => t.locales.length);
  if (locales.length) add("medium", "Ad sets limited by app language", `${locales.map((t) => `${t.adset} (${t.campaign}): language code ${t.locales.join(", ")}`).join("; ")}. People whose Facebook or Instagram is set to another language (often English) will not see these ads. Check this in Ads Manager.`);
  const interestSets = targeting.filter((t) => t.interests.length);
  if (interestSets.length) add("info", "Interest targeting to double-check", interestSets.map((t) => `${t.adset} (${t.campaign}): ${t.interests.slice(0, 8).join(", ")}${t.interests.length > 8 ? " and more" : ""}`).join("; ") + ". Make sure these match the business.");

  // ---- suggestions ----
  const suggestions = [];
  if (overlapGroups.length) suggestions.push("Run one ad set per audience instead of duplicates with identical targeting.");
  const bestPlacement = bestOf(placements);
  if (bestPlacement) suggestions.push(`Move budget toward ${bestPlacement.key} (${m(bestPlacement.cpc)} per conversation).`);
  const bestPart = bestOf(dayparts);
  if (bestPart) suggestions.push(`Weight spend toward ${bestPart.key} (${pct(bestPart.conv, totals.conv)}% of chats at ${m(bestPart.cpc)} each).`);
  if (locales.length) suggestions.push("Test a copy of the main WhatsApp ad set open to all languages.");
  if (notMessaging.length) suggestions.push("Rebuild the zero-chat ads as WhatsApp conversation ads if chats are the goal.");
  if (maxFreq >= 3) suggestions.push("Refresh the most-shown creatives.");
  suggestions.push("Ask the client how many chats turned into orders or bookings, and record it under Lead feedback.");

  return {
    account, totals: { ...totals, reach, ads: ads.length },
    ads, placements, ages, genders, hours, dayparts, regions, targeting: targeting.map(({ signature, ...t }) => t),
    findings, suggestions,
  };
}

export function createInsights({ windsorKey, openaiKey, model, db }) {
  const cache = new Map(); // "from|to" -> { at, raw } or { promise }
  db.exec(`CREATE TABLE IF NOT EXISTS ai_insights (
    key TEXT PRIMARY KEY, account TEXT, date_from TEXT, date_to TEXT, text TEXT NOT NULL, model TEXT, created_by TEXT, created_at TEXT NOT NULL
  )`);

  async function query(fields, from, to) {
    const url = new URL("https://connectors.windsor.ai/facebook");
    url.searchParams.set("api_key", windsorKey());
    url.searchParams.set("fields", fields);
    url.searchParams.set("date_from", from);
    url.searchParams.set("date_to", to);
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error("Meta data request failed"), { status: 502 });
    return Array.isArray(payload) ? payload : payload.data || [];
  }

  async function raw(from, to) {
    if (!windsorKey()) throw Object.assign(new Error("live data not configured"), { status: 503 });
    const key = `${from}|${to}`, hit = cache.get(key);
    if (hit?.raw && Date.now() - hit.at < 2 * 60 * 60 * 1000) return hit.raw;
    if (hit?.promise) return hit.promise;
    const promise = (async () => {
      const entries = await Promise.all(Object.entries(QUERIES).map(async ([k, fields]) => [k, await query(fields, from, to)]));
      return Object.fromEntries(entries);
    })();
    cache.set(key, { promise });
    try {
      const data = await promise;
      cache.set(key, { at: Date.now(), raw: data });
      if (cache.size > 30) cache.delete(cache.keys().next().value);
      return data;
    } catch (error) {
      cache.delete(key);
      console.error("insights sync failed", error.message);
      throw error;
    }
  }

  const summaryKey = (account, from, to) => `${account}|${from}|${to}`;
  const savedSummary = (account, from, to) => db.prepare("SELECT text, model, created_by, created_at FROM ai_insights WHERE key = ?").get(summaryKey(account, from, to)) || null;

  async function writeSummary(audit, period, user) {
    if (!openaiKey()) throw Object.assign(new Error("OpenAI is not connected yet."), { status: 409 });
    const facts = {
      period, totals: audit.totals, findings: audit.findings, suggestions: audit.suggestions,
      ads: audit.ads.map(({ name, campaign, adset, spend, conv, leads, clicks, frequency, objective, goal, destination, button }) => ({ name, campaign, adset, spend: Math.round(spend), conv, leads, clicks, frequency: Number(frequency.toFixed(2)), objective, goal, destination, button })),
      placements: audit.placements.slice(0, 8), dayparts: audit.dayparts, ages: audit.ages, genders: audit.genders, regions: audit.regions,
      targeting: audit.targeting.map(({ campaign, adset, age, genders, include, exclude, locales, interests }) => ({ campaign, adset, age, genders, include, exclude, locales, interests })),
    };
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey()}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: model(),
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: [
            "You are a senior Meta Ads performance analyst at CreativHeads, a marketing agency in Kerala, writing an internal account review for the agency team.",
            "Use ONLY the numbers in the supplied JSON. Never invent figures, causes or results. If something is uncertain, say it is worth checking.",
            "Write in plain, direct English for busy marketers. Money in rupees like ₹1,234. 'Conversations' means WhatsApp chats started.",
            "Write cost per conversation as '₹58 per conversation'. Never write CPC, CPA or CPM. When a period has few conversations, say the numbers are small.",
            "Return JSON only, in this shape:",
            '{"headline":"the single most important finding, one sentence with numbers",',
            '"verdict":"good" | "mixed" | "poor",',
            '"sections":[{"title":"2-4 words, e.g. Zero-chat ads, Ad fatigue, Placement, Time of day, Audience, Overlap, Language, Targeting","tone":"good" | "warn" | "bad" | "info","points":["1-2 short sentences with the numbers"]}],',
            '"actions":[{"title":"short imperative, under 8 words","detail":"one sentence: why, with the number","impact":"high" | "medium" | "low"}]}',
            "Use 3-6 sections and 3-5 actions, most important first. Skip topics with nothing useful. Keep the whole review under 300 words.",
            "Do not mention data vendors, APIs or AI tools. Nothing has been changed in Meta.",
          ].join(" ") },
          { role: "user", content: `Account: ${audit.account}\n${JSON.stringify(facts)}` },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const text = payload.choices?.[0]?.message?.content;
    if (!response.ok || !text) {
      console.error("openai summary failed", response.status, payload.error?.code || "");
      throw Object.assign(new Error(payload.error?.code === "invalid_api_key" ? "The OpenAI key was rejected." : "OpenAI did not return a summary. Try again."), { status: 502 });
    }
    db.prepare("INSERT INTO ai_insights (key, account, date_from, date_to, text, model, created_by, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET text = excluded.text, model = excluded.model, created_by = excluded.created_by, created_at = excluded.created_at")
      .run(summaryKey(audit.account, period.from, period.to), audit.account, period.from, period.to, text, model(), user?.name || "", new Date().toISOString());
    return savedSummary(audit.account, period.from, period.to);
  }

  return { raw, writeSummary, savedSummary, openaiConnected: () => !!openaiKey(), model };
}
