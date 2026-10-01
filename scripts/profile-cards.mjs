// Genera las tarjetas de estadísticas y racha del perfil como SVG propios.
// Sin dependencias: corre con Node 20+ dentro del workflow `profile.yml`.
//
//   GH_TOKEN=... USERNAME=CcastilloMoraga OUT_DIR=dist node scripts/profile-cards.mjs
//   node scripts/profile-cards.mjs --mock      (datos de prueba, sin red)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USERNAME = process.env.USERNAME || "CcastilloMoraga";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR || "dist";
const MOCK = process.argv.includes("--mock");

const C = {
  bg: "#07050a", p900: "#1a0b2e", p800: "#2d0050", p600: "#4a1a7a", p500: "#7b2fbe",
  p400: "#9966cc", p300: "#b48ae0", p100: "#e0c8ff", muted: "#a090b0", dim: "#6c5a80",
};
const MONO = "'Fira Code','JetBrains Mono','Cascadia Code',Consolas,monospace";
const SANS = "'Segoe UI',Ubuntu,'Helvetica Neue',Arial,sans-serif";
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// ───────────────────────────── datos ─────────────────────────────
async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-cards" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${res.status} ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

async function fetchData() {
  const main = await gql(
    `query($login:String!){ user(login:$login){
      followers{ totalCount }
      repositories(ownerAffiliations:OWNER, privacy:PUBLIC, isFork:false, first:100){ totalCount nodes{ stargazerCount } }
      contributionsCollection{
        contributionYears
        totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions
        totalIssueContributions restrictedContributionsCount
        contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount contributionLevel weekday } } }
      }
    }}`,
    { login: USERNAME },
  );
  const u = main.user;
  const years = u.contributionsCollection.contributionYears;
  const aliases = years
    .map((y) => `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z"){
        contributionCalendar{ weeks{ contributionDays{ date contributionCount } } } }`)
    .join("\n");
  const hist = years.length ? (await gql(`query($login:String!){ user(login:$login){ ${aliases} } }`, { login: USERNAME })).user : {};

  const days = new Map();
  for (const y of years)
    for (const w of hist[`y${y}`].contributionCalendar.weeks)
      for (const d of w.contributionDays) days.set(d.date, d.contributionCount);

  const cc = u.contributionsCollection;
  return {
    year: {
      total: cc.contributionCalendar.totalContributions,
      commits: cc.totalCommitContributions,
      prs: cc.totalPullRequestContributions,
      reviews: cc.totalPullRequestReviewContributions,
      issues: cc.totalIssueContributions,
      priv: cc.restrictedContributionsCount,
      weeks: cc.contributionCalendar.weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0)),
      calendar: cc.contributionCalendar.weeks.map((w) =>
        w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount, weekday: d.weekday, level: LEVELS[d.contributionLevel] ?? 0 })),
      ),
    },
    repos: u.repositories.totalCount,
    stars: u.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0),
    followers: u.followers.totalCount,
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

function mockData() {
  const days = [];
  const start = new Date("2024-03-01T00:00:00Z");
  const end = new Date();
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wk = d.getUTCDay() % 6 !== 0;
    days.push([d.toISOString().slice(0, 10), rnd() < (wk ? 0.8 : 0.35) ? Math.floor(rnd() * 12) + 1 : 0]);
  }
  // calendario de ~53 semanas que empieza en domingo, como el de GitHub
  let k = days.length - 365;
  while (new Date(days[k][0] + "T00:00:00Z").getUTCDay() !== 0) k--;
  const last = days.slice(k);
  const weeks = [], calendar = [];
  for (let i = 0; i < last.length; i += 7) {
    const chunk = last.slice(i, i + 7);
    weeks.push(chunk.reduce((s, [, c]) => s + c, 0));
    calendar.push(chunk.map(([date, count], wd) => ({ date, count, weekday: wd, level: count ? Math.min(4, Math.ceil(count / 3)) : 0 })));
  }
  return {
    year: { total: last.reduce((s, [, c]) => s + c, 0), commits: 412, prs: 23, reviews: 9, issues: 6, priv: 1180, weeks, calendar },
    repos: 11, stars: 4, followers: 6, days,
  };
}

// ─────────────────────────── cálculos ───────────────────────────
function streaks(days) {
  let total = 0, best = { len: 0 }, run = null;
  for (const [date, c] of days) {
    total += c;
    if (c > 0) {
      run = run ? { ...run, end: date, len: run.len + 1 } : { start: date, end: date, len: 1 };
      if (run.len > best.len) best = run;
    } else run = null;
  }
  // racha actual: si hoy aún no hay contribuciones, se cuenta hasta ayer
  let i = days.length - 1;
  if (i >= 0 && days[i][1] === 0) i--;
  let cur = { len: 0 };
  if (i >= 0 && days[i][1] > 0) {
    let j = i;
    while (j >= 0 && days[j][1] > 0) j--;
    cur = { start: days[j + 1][0], end: days[i][0], len: i - j };
  }
  const first = days.find(([, c]) => c > 0)?.[0];
  return { total, best, cur, first, today: days.at(-1)?.[0] };
}

// ───────────────────────────── SVG ─────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const num = (n) => Number(n).toLocaleString("es-CL");
const fecha = (iso, year = true) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MESES[m - 1]}${year ? ` ${y}` : ""}`;
};
const rango = (a, b) => {
  if (!a) return "sin racha activa";
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return a === b ? fecha(a) : `${fecha(a, !sameYear)} – ${fecha(b)}`;
};

function frame(w, h, label, inner, aria) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(aria)}">
<defs>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${C.p900}"/></pattern>
<linearGradient id="bd" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${C.p500}"/><stop offset="50%" stop-color="${C.p800}"/><stop offset="100%" stop-color="${C.p500}"/></linearGradient>
<linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${C.p400}" stop-opacity=".45"/><stop offset="100%" stop-color="${C.p400}" stop-opacity="0"/></linearGradient>
<style>
  .f{animation:in .7s ease-out both}
  .d1{animation-delay:.1s}.d2{animation-delay:.2s}.d3{animation-delay:.3s}.d4{animation-delay:.4s}.d5{animation-delay:.5s}.d6{animation-delay:.6s}
  .draw{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.6s cubic-bezier(.3,.7,.2,1) .3s forwards}
  .grow{animation:draw 1.6s cubic-bezier(.3,.7,.2,1) .3s both}
  .live{animation:live 1.6s ease-in-out infinite}
  @keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @keyframes draw{to{stroke-dashoffset:0}}
  @keyframes live{50%{opacity:.2}}
  @media (prefers-reduced-motion: reduce){*{animation:none!important}.draw{stroke-dashoffset:0}}
</style>
</defs>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="14" fill="${C.bg}" stroke="url(#bd)" stroke-width="1.5"/>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="14" fill="url(#dots)"/>
<text x="26" y="36" font-family="${MONO}" font-size="12" fill="${C.p400}" letter-spacing="2.5">${esc(label)}</text>
<circle class="live" cx="${w - 30}" cy="32" r="4" fill="${C.p300}"/>
${inner}
</svg>
`;
}

function statsCard(d) {
  const W = 540, H = 210;
  const y = d.year;
  // sparkline de contribuciones semanales
  const sx = 26, sy = 166, sw = 200, sh = 38;
  const max = Math.max(1, ...y.weeks);
  const pts = y.weeks.map((v, i) => [sx + (i / Math.max(1, y.weeks.length - 1)) * sw, sy - (v / max) * sh]);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `${line} L${sx + sw},${sy} L${sx},${sy} Z`;

  const items = [
    ["Commits", y.commits], ["Pull requests", y.prs], ["Code reviews", y.reviews],
    ["Issues", y.issues], ["Privadas", y.priv], ["Repos", d.repos],
  ];
  const gx = 270, gy = 76, cw = 128, rh = 44;
  const grid = items.map(([k, v], i) => {
    const x = gx + (i % 2) * cw, yy = gy + Math.floor(i / 2) * rh;
    return `<g class="f d${i + 1}"><rect x="${x}" y="${yy}" width="3" height="30" rx="1.5" fill="${i === 4 ? C.p100 : C.p600}"/>
  <text x="${x + 12}" y="${yy + 12}" font-family="${SANS}" font-size="11.5" fill="${C.muted}">${esc(k)}</text>
  <text x="${x + 12}" y="${yy + 30}" font-family="${MONO}" font-size="17" font-weight="700" fill="${C.p100}">${num(v)}</text></g>`;
  }).join("\n");

  const inner = `
<g class="f">
  <text x="26" y="88" font-family="${MONO}" font-size="40" font-weight="700" fill="${C.p100}">${num(y.total)}</text>
  <text x="26" y="110" font-family="${SANS}" font-size="12.5" fill="${C.muted}">contribuciones · último año</text>
</g>
<path d="M${sx},${sy} H${sx + sw}" stroke="${C.p800}" stroke-width="1"/>
<path d="${area}" fill="url(#area)" class="f d3"/>
<path d="${line}" fill="none" stroke="${C.p300}" stroke-width="1.6" stroke-linejoin="round" pathLength="1" class="draw"/>
<text x="${sx}" y="${sy + 17}" font-family="${MONO}" font-size="10" fill="${C.dim}">-52 sem</text>
<text x="${sx + sw}" y="${sy + 17}" font-family="${MONO}" font-size="10" fill="${C.dim}" text-anchor="end">hoy</text>
<path d="M248,62 V${H - 26}" stroke="${C.p800}"/>
${grid}`;
  return frame(W, H, "// GITHUB STATS", inner, `Estadísticas de GitHub: ${y.total} contribuciones en el último año`);
}

function streakCard(s) {
  const W = 540, H = 210;
  const cx = W / 2, cy = 112, r = 44;
  // el anillo muestra la racha actual respecto de la más larga
  const frac = s.best.len ? Math.max(0.03, Math.min(1, s.cur.len / s.best.len)).toFixed(3) : 0;
  const col = (x, big, label, sub, cls) => `<g class="f ${cls}" text-anchor="middle">
  <text x="${x}" y="108" font-family="${MONO}" font-size="28" font-weight="700" fill="${C.p100}">${big}</text>
  <text x="${x}" y="132" font-family="${SANS}" font-size="12.5" fill="${C.muted}">${esc(label)}</text>
  <text x="${x}" y="152" font-family="${MONO}" font-size="10.5" fill="${C.dim}">${esc(sub)}</text></g>`;
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const a = (i * 10 - 90) * (Math.PI / 180);
    const r1 = r + 8, r2 = r + (i % 3 === 0 ? 13 : 10);
    return `M${(cx + r1 * Math.cos(a)).toFixed(1)},${(cy + r1 * Math.sin(a)).toFixed(1)} L${(cx + r2 * Math.cos(a)).toFixed(1)},${(cy + r2 * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  const inner = `
${col(92, num(s.total), "Contribuciones totales", s.first ? `${fecha(s.first)} – hoy` : "—", "d1")}
<g>
  <path d="${ticks}" stroke="${C.p800}" stroke-width="1.2"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.p900}" stroke="${C.p800}" stroke-width="5"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.p400}" stroke-width="5" stroke-linecap="round" pathLength="1" stroke-dasharray="${frac} 1" stroke-dashoffset="${frac}" class="grow" transform="rotate(-90 ${cx} ${cy})"/>
  <g>
    <animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="6s" repeatCount="indefinite"/>
    <circle cx="${cx}" cy="${cy - r - 10.5}" r="2.6" fill="${C.p100}"/>
  </g>
  <text x="${cx}" y="${cy + 10}" text-anchor="middle" font-family="${MONO}" font-size="30" font-weight="700" fill="${C.p100}" class="f d2">${num(s.cur.len)}</text>
  <text x="${cx}" y="${cy + 26}" text-anchor="middle" font-family="${MONO}" font-size="9.5" fill="${C.muted}" letter-spacing="1.5">DÍAS</text>
</g>
<g class="f d3" text-anchor="middle">
  <text x="${cx}" y="${H - 22}" font-family="${SANS}" font-size="12.5" fill="${C.p300}" font-weight="600">Racha actual</text>
</g>
<text x="${cx}" y="36" text-anchor="middle" font-family="${MONO}" font-size="10.5" fill="${C.dim}">${esc(rango(s.cur.start, s.cur.end))}</text>
${col(W - 92, num(s.best.len), "Racha más larga", s.best.len ? rango(s.best.start, s.best.end) : "—", "d4")}
<path d="M178,70 V160 M${W - 178},70 V160" stroke="${C.p800}"/>`;
  return frame(W, H, "// STREAK", inner, `Racha actual: ${s.cur.len} días. Racha más larga: ${s.best.len} días.`);
}


function activityCard(y) {
  const W = 1000, H = 250;
  const cell = 13, gap = 3, step = cell + gap;
  const cols = y.calendar.length;
  const gridW = cols * step - gap;
  const x0 = Math.round((W - gridW) / 2) + 14, y0 = 78;
  const colors = ["#130c1c", "#3d0a6e", "#6a2bb0", "#9966cc", "#e0c8ff"];
  const first = y.calendar[0]?.[0]?.date, last = y.calendar.at(-1)?.at(-1)?.date;

  // etiquetas de mes: en la primera semana cuyo primer día cae en un mes nuevo
  let prevMonth = -1, lastLabelX = -99;
  const months = y.calendar.map((week, i) => {
    const m = Number(week[0].date.slice(5, 7)) - 1;
    if (m === prevMonth) return "";
    prevMonth = m;
    const x = x0 + i * step;
    if (i === 0 && week.length && Number(week[0].date.slice(8, 10)) > 20) return ""; // mes cortado al inicio
    if (x - lastLabelX < 30) return "";
    lastLabelX = x;
    return `<text x="${x}" y="${y0 - 10}" font-family="${MONO}" font-size="10.5" fill="${C.muted}">${MESES[m]}</text>`;
  }).join("");

  const wdays = [[1, "lun"], [3, "mié"], [5, "vie"]].map(([r, t]) =>
    `<text x="${x0 - 10}" y="${y0 + r * step + cell - 3}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${C.dim}">${t}</text>`).join("");

  const grid = y.calendar.map((week, i) => {
    const rects = week.map((d) => {
      const yy = y0 + (d.weekday ?? 0) * step;
      const glow = d.level === 4 ? ` filter="url(#gl)"` : "";
      return `<rect x="${x0 + i * step}" y="${yy}" width="${cell}" height="${cell}" rx="3" fill="${colors[d.level]}"${glow}><title>${esc(fecha(d.date))}: ${d.count}</title></rect>`;
    }).join("");
    return `<g class="col" style="animation-delay:${(i * 0.018).toFixed(3)}s">${rects}</g>`;
  }).join("\n");

  const legend = colors.map((c, i) =>
    `<rect x="${W - 150 + i * 17}" y="${H - 40}" width="${cell}" height="${cell}" rx="3" fill="${c}"/>`).join("");

  const gh = 7 * step - gap;
  const inner = `
<defs>
  <filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <linearGradient id="beam" x1="0" x2="1"><stop offset="0%" stop-color="${C.p300}" stop-opacity="0"/><stop offset="80%" stop-color="${C.p300}" stop-opacity=".22"/><stop offset="100%" stop-color="${C.p100}" stop-opacity=".55"/></linearGradient>
  <clipPath id="gridclip"><rect x="${x0 - 4}" y="${y0 - 4}" width="${gridW + 8}" height="${gh + 8}"/></clipPath>
</defs>
<style>.col{animation:pop .5s cubic-bezier(.2,.8,.2,1) both}@keyframes pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}</style>
<text x="${W / 2}" y="36" text-anchor="middle" font-family="${MONO}" font-size="10.5" fill="${C.dim}">${esc(rango(first, last))}</text>
${months}
${wdays}
${grid}
<g clip-path="url(#gridclip)">
  <rect y="${y0 - 4}" width="60" height="${gh + 8}" fill="url(#beam)" x="${x0 - 60}">
    <animate attributeName="x" values="${x0 - 60};${x0 + gridW + 4}" dur="7s" begin="1.5s" repeatCount="indefinite"/>
  </rect>
</g>
<text x="${x0}" y="${H - 29}" font-family="${MONO}" font-size="15" font-weight="700" fill="${C.p100}">${num(y.total)}<tspan font-family="${SANS}" font-size="12.5" font-weight="400" fill="${C.muted}" dx="8">contribuciones en el último año</tspan></text>
<text x="${W - 158}" y="${H - 29.5}" text-anchor="end" font-family="${SANS}" font-size="11" fill="${C.dim}">menos</text>
${legend}
<text x="${W - 63}" y="${H - 29.5}" font-family="${SANS}" font-size="11" fill="${C.dim}">más</text>`;
  return frame(W, H, "// ACTIVITY", inner, `Calendario de contribuciones: ${y.total} en el último año`);
}

// ───────────────────────────── main ─────────────────────────────
if (!MOCK && !TOKEN) {
  console.error("Falta GH_TOKEN");
  process.exit(1);
}
const data = MOCK ? mockData() : await fetchData();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "stats.svg"), statsCard(data));
writeFileSync(join(OUT_DIR, "streak.svg"), streakCard(streaks(data.days)));
writeFileSync(join(OUT_DIR, "activity.svg"), activityCard(data.year));
console.log(`Tarjetas generadas en ${OUT_DIR}/ (${data.days.length} días de historial)`);
