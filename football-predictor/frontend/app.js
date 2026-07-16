/* Dashboard del predictor: liga → próximos partidos + simulador de cruce.
   Vanilla JS, sin dependencias: consume la API REST del backend. */

"use strict";

const $ = (sel) => document.querySelector(sel);
const state = { leagues: [], league: null, teams: [] };

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* cuerpo no-JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const pct = (x, dec = 0) => (100 * x).toFixed(dec) + "%";

function fmtDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/* ---------------------------------------------------------------- barra */
/* Barra apilada L/E/V. El texto va SIEMPRE en tinta (caption + tooltip);
   los segmentos llevan aria-label y data-tip para el hover. */
function probBar(probs, { thin = false } = {}) {
  const segs = [
    ["home", "Victoria local", probs.home],
    ["draw", "Empate", probs.draw],
    ["away", "Victoria visitante", probs.away],
  ].map(([k, label, p]) =>
    `<div class="seg seg-${k}" style="flex:${(100 * p).toFixed(2)}"
          role="img" aria-label="${label}: ${pct(p, 1)}"
          data-tip="${label} — ${pct(p, 1)}"></div>`
  ).join("");
  const caption = thin ? "" : `
    <div class="prob-caption">
      <span><i class="dot dot-home"></i>Local <b>${pct(probs.home)}</b></span>
      <span><i class="dot dot-draw"></i>Empate <b>${pct(probs.draw)}</b></span>
      <span><i class="dot dot-away"></i>Visita <b>${pct(probs.away)}</b></span>
    </div>`;
  return `<div class="prob-bar${thin ? " thin" : ""}">${segs}</div>${caption}`;
}

function predictionExtras(p) {
  return `<div class="match-extra">Marcador más probable <b>${esc(p.most_likely_score)}</b>
    · Goles esperados <b>${p.expected_goals.home.toFixed(1)}–${p.expected_goals.away.toFixed(1)}</b>
    · Elo <b>${p.elo_ratings.home}</b> vs <b>${p.elo_ratings.away}</b></div>
    ${p.notes.map((n) => `<div class="note">⚠ ${esc(n)}</div>`).join("")}`;
}

/* ---------------------------------------------------------------- ligas */
async function init() {
  const [leagues, meta] = await Promise.all([api("/api/leagues"), api("/api/meta")]);
  state.leagues = leagues;
  $("#footer-disclaimer").textContent = meta.disclaimer;

  const nav = $("#league-nav");
  nav.innerHTML = leagues.map((l) =>
    `<button class="league-chip" data-id="${esc(l.id)}">${l.flag} ${esc(l.name)}</button>`).join("");
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".league-chip");
    if (btn) selectLeague(btn.dataset.id);
  });

  const preferred = leagues.find((l) => l.id === "liga-mx") || leagues[0];
  await selectLeague(preferred.id);
}

async function selectLeague(id) {
  state.league = id;
  document.querySelectorAll(".league-chip").forEach((b) =>
    b.classList.toggle("active", b.dataset.id === id));
  $("#fixtures-list").innerHTML = "<p class='meta'>Cargando…</p>";
  $("#sim-result").innerHTML = "";
  $("#h2h").innerHTML = "";

  const info = state.leagues.find((l) => l.id === id);
  $("#fixtures-meta").textContent =
    `datos: ${info.first_season} → ${info.last_season} (hasta ${info.last_played_date})`;

  try {
    const [preds, teams] = await Promise.all([
      api(`/api/leagues/${id}/predictions?limit=12`),
      api(`/api/leagues/${id}/teams`),
    ]);
    state.teams = teams.teams;
    renderFixtures(preds, info);
    setupSimulator();
  } catch (err) {
    $("#fixtures-list").innerHTML = `<div class="error-box">Error: ${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------- fixtures */
function renderFixtures(preds, info) {
  const box = $("#fixtures-list");
  if (!preds.count) {
    box.innerHTML = `
      <div class="empty">
        <h3>Sin partidos próximos en la fuente de datos</h3>
        <p>La fuente aún no publica el calendario de la siguiente temporada de
           <b>${esc(info.name)}</b> (último dato: ${fmtDate(info.last_played_date)}).
           En cuanto lo publique, aparecerá aquí tras correr
           <code>python scripts/update_data.py</code>.</p>
        <p>Mientras tanto, usa el <b>simulador de cruce</b> → para ver la barra de
           probabilidades de cualquier enfrentamiento.</p>
      </div>`;
    return;
  }
  box.innerHTML = preds.predictions.map(({ fixture, prediction }) => `
    <article class="match-card">
      <div class="match-when">${fmtDate(fixture.date)}${fixture.time ? " · " + esc(fixture.time) : ""}${fixture.stage ? " · " + esc(fixture.stage) : ""}</div>
      <div class="match-teams"><span>${esc(fixture.home_team)}</span><span class="vs">vs</span><span>${esc(fixture.away_team)}</span></div>
      ${probBar(prediction.probs)}
      ${predictionExtras(prediction)}
    </article>`).join("");
}

/* ------------------------------------------------------------ simulador */
function setupSimulator() {
  const opts = state.teams.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  const home = $("#sim-home"), away = $("#sim-away");
  home.innerHTML = opts;
  away.innerHTML = opts;
  home.selectedIndex = 0;
  away.selectedIndex = Math.min(1, state.teams.length - 1);

  home.onchange = away.onchange = runSimulation;
  $("#sim-swap").onclick = () => {
    const h = home.value;
    home.value = away.value;
    away.value = h;
    runSimulation();
  };
  runSimulation();
}

async function runSimulation() {
  const home = $("#sim-home").value, away = $("#sim-away").value;
  const box = $("#sim-result"), h2hBox = $("#h2h");
  if (home === away) {
    box.innerHTML = "<div class='error-box'>Elige dos equipos distintos.</div>";
    h2hBox.innerHTML = "";
    return;
  }
  box.innerHTML = "<p class='meta'>Calculando…</p>";
  try {
    const q = new URLSearchParams({ league: state.league, home, away });
    const data = await api(`/api/predict?${q}`);
    const p = data.prediction;
    box.innerHTML = `
      <article class="match-card">
        <div class="match-teams"><span>${esc(p.home)}</span><span class="vs">vs</span><span>${esc(p.away)}</span></div>
        ${probBar(p.probs)}
        ${predictionExtras(p)}
        <div class="components">
          <div class="comp-row"><span class="lbl">Poisson</span>${probBar(p.components.poisson, { thin: true })}</div>
          <div class="comp-row"><span class="lbl">Elo</span>${probBar(p.components.elo, { thin: true })}</div>
        </div>
      </article>`;
    renderH2H(data, home, away);
  } catch (err) {
    box.innerHTML = `<div class="error-box">Error: ${esc(err.message)}</div>`;
    h2hBox.innerHTML = "";
  }
}

function formChips(form) {
  return `<span class="form-chips">${form.map((f) =>
    `<i class="chip chip-${f.result}" data-tip="${fmtDate(f.date)} · ${esc(f.venue)} vs ${esc(f.opponent)} (${esc(f.score)})">${f.result === "W" ? "G" : f.result === "D" ? "E" : "P"}</i>`
  ).join("")}</span>`;
}

function renderH2H(data, home, away) {
  const { summary, matches } = data.h2h;
  const box = $("#h2h");
  const rows = matches.map((m) => `
    <tr>
      <td class="when">${fmtDate(m.date)}</td>
      <td>${esc(m.home_team)} – ${esc(m.away_team)}</td>
      <td class="score">${m.home_goals}–${m.away_goals}</td>
    </tr>`).join("");

  box.innerHTML = `
    <h3>Enfrentamientos directos (últimos ${matches.length || 0})</h3>
    ${matches.length ? `
      <p class="h2h-summary"><b>${esc(summary.team_a)}</b> ${summary.wins_a}G ·
        ${summary.draws}E · ${summary.wins_b}G <b>${esc(summary.team_b)}</b>
        (goles ${summary.goals_a}–${summary.goals_b})</p>
      <table class="h2h-table"><tbody>${rows}</tbody></table>`
      : `<p class="h2h-summary">Sin enfrentamientos directos en el historial cargado.</p>`}
    <div class="form-row">Forma ${esc(home)}: ${formChips(data.form.home)}</div>
    <div class="form-row">Forma ${esc(away)}: ${formChips(data.form.away)}</div>`;
}

/* -------------------------------------------------------------- tooltip */
const tip = $("#tip");
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
});
document.addEventListener("mousemove", (e) => {
  if (!tip.hidden) { tip.style.left = e.clientX + "px"; tip.style.top = e.clientY + "px"; }
});
document.addEventListener("mouseout", () => { tip.hidden = true; });

init().catch((err) => {
  $("#fixtures-list").innerHTML = `<div class="error-box">No se pudo cargar la API: ${esc(err.message)}.
    ¿Corriste <code>python scripts/update_data.py</code> y levantaste el servidor?</div>`;
});
