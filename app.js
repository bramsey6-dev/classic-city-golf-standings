// ===================================================================
// Classic City Golf Pool - Live Standings
// Fetches team/standings data from the published Google Sheet, and
// refreshes live scores directly from ESPN's public API in-browser
// (sidesteps the server-to-server blocking issue Apps Script hit,
// since this is a normal browser fetch).
// ===================================================================

const ESPN_CANDIDATES = [
  'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard',
  'https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'
];

const POINTS_SCALE = [50,38,36,34,32,30,28,26,24,22,20,18,16,14,12,10,8,6,4,2];
function pointsForRank(rank) {
  if (rank < 1 || rank > POINTS_SCALE.length) return 0;
  return POINTS_SCALE[rank - 1];
}

// Distinct, legible tag colors auto-assigned to each person, in the
// order their name appears as a Teams tab header. Chosen to stay
// readable with white text and to sit comfortably alongside the
// existing green/gold/ivory palette without clashing. Supports more
// people than currently exist in the pool - if the Teams tab ever
// grows past this list's length, it cycles back to the start rather
// than erroring.
const TEAM_COLOR_PALETTE = [
  '#C9A24B', // gold (same as the original "Drafted" tag, so the first
             // team keeps the site's existing accent color)
  '#2E6F8E', // slate blue
  '#A6473D', // brick red
  '#4B7A4E', // moss green
  '#7A5AA6', // muted purple
  '#B5722F', // burnt orange
  '#3D8C86', // teal
  '#8C5C7A'  // mauve
];

function buildPersonColorMap(personNamesInOrder) {
  const map = {};
  personNamesInOrder.forEach((name, idx) => {
    map[name] = TEAM_COLOR_PALETTE[idx % TEAM_COLOR_PALETTE.length];
  });
  return map;
}

// In-memory snapshot of last-rendered standings, keyed by person name,
// used purely to compute up/down movement arrows between refreshes.
// Intentionally NOT persisted (no localStorage - unsupported in some
// embed contexts and unnecessary here); resets on page load, which is
// fine since there's nothing to compare against on first load anyway.
let previousRankByName = {};
let currentTeams = {};      // { personName: [golferName, ...] }
let currentSeasonScore = {}; // { personName: number }
let isRefreshing = false;

function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/export?format=csv&gid=${gid}`;
}

// Minimal CSV parser: handles quoted fields containing commas, and
// strips a trailing blank line. Good enough for Sheets' own CSV export
// format without pulling in a dependency.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

async function fetchSheetTab(gid) {
  const res = await fetch(csvUrl(gid), { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Sheet fetch failed (HTTP ${res.status}). Make sure the sheet is shared as "Anyone with the link can view".`);
  }
  const text = await res.text();
  if (text.trim().startsWith('<')) {
    // Google returns an HTML login/error page instead of CSV when the
    // sheet isn't publicly viewable.
    throw new Error('Sheet is not publicly viewable. In Google Sheets, click Share > General access > "Anyone with the link".');
  }
  return parseCSV(text);
}

function normalizeGolferName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (Åberg -> Aberg)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseScoreToNumber(scoreRaw) {
  if (scoreRaw === null || scoreRaw === undefined) return null;
  const s = String(scoreRaw).trim();
  if (s === '' || s === '-' || s === '--') return null;
  if (s.toUpperCase() === 'E') return 0;
  const match = s.match(/^([+-]?)(\d+)$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * parseInt(match[2], 10);
}

function scoreClass(scoreRaw) {
  const n = parseScoreToNumber(scoreRaw);
  if (n === null) return 'even';
  if (n < 0) return 'under';
  if (n > 0) return 'over';
  return 'even';
}

// -------------------------------------------------------------
// ESPN live fetch (in-browser - not subject to the Apps Script
// server-to-server blocking we hit earlier)
// -------------------------------------------------------------
async function fetchLiveLeaderboard() {
  let lastError = '';
  for (const url of ESPN_CANDIDATES) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) { lastError = `HTTP ${res.status} from ${url}`; continue; }
      const data = await res.json();
      const event = data.events && data.events[0];
      const comp = event && event.competitions && event.competitions[0];
      if (comp && comp.competitors && comp.competitors.length > 0) {
        return { event, competition: comp, competitors: comp.competitors };
      }
      lastError = `No competitors from ${url}`;
    } catch (e) {
      lastError = `${url}: ${e.message}`;
    }
  }
  throw new Error('Could not reach ESPN for live scores (' + lastError + '). Showing the Google Sheet\'s last saved data instead.');
}

function computeLeaderboardRows(competitors, currentRoundNumber) {
  let rows = competitors.map(c => {
    const golfer = (c.athlete && (c.athlete.displayName || c.athlete.shortName)) || '';
    const scoreRaw = c.score !== undefined ? (c.score.displayValue !== undefined ? c.score.displayValue : c.score) : '';

    // Real ESPN shape (confirmed against live tournament data): each
    // entry in c.linescores is one ROUND, keyed by "period" (1, 2, 3...).
    // Round entries have their own nested linescores array - THAT
    // nested array is the hole-by-hole breakdown for that round. A
    // round that hasn't started yet is just {"period": N} with no
    // score data at all.
    let today = '';
    let thru = '';
    if (Array.isArray(c.linescores) && currentRoundNumber) {
      const roundEntry = c.linescores.find(ls => ls.period === currentRoundNumber);
      if (roundEntry) {
        // Today's round score, e.g. "-6". A round with no holes played
        // yet shows displayValue "-" - treat that the same as absent.
        if (roundEntry.displayValue && roundEntry.displayValue !== '-') {
          today = roundEntry.displayValue;
        }
        // Thru = how many holes have a recorded score in this round's
        // own nested linescores array.
        if (Array.isArray(roundEntry.linescores)) {
          thru = String(roundEntry.linescores.length);
        }
      }
    }

    return { golfer, scoreRaw, today, thru, scoreNum: parseScoreToNumber(scoreRaw) };
  }).filter(r => r.golfer);

  rows.sort((a, b) => {
    if (a.scoreNum === null && b.scoreNum === null) return 0;
    if (a.scoreNum === null) return 1;
    if (b.scoreNum === null) return -1;
    return a.scoreNum - b.scoreNum;
  });

  const scoreGroups = [];
  rows.forEach((r, idx) => {
    const lastGroup = scoreGroups[scoreGroups.length - 1];
    if (lastGroup && r.scoreNum !== null && lastGroup.scoreNum === r.scoreNum) {
      lastGroup.indices.push(idx);
    } else {
      scoreGroups.push({ scoreNum: r.scoreNum, indices: [idx] });
    }
  });

  let rankCursor = 1;
  const pointsByIdx = {};
  const posByIdx = {};
  scoreGroups.forEach(group => {
    const isTie = group.indices.length > 1 && group.scoreNum !== null;
    const points = group.scoreNum === null ? 0 : pointsForRank(rankCursor);
    const label = group.scoreNum === null ? '--' : (isTie ? 'T' + rankCursor : String(rankCursor));
    group.indices.forEach(idx => { pointsByIdx[idx] = points; posByIdx[idx] = label; });
    rankCursor += group.indices.length;
  });

  return rows.map((r, idx) => ({
    position: posByIdx[idx],
    golfer: r.golfer,
    scoreRaw: r.scoreRaw,
    today: r.today,
    thru: r.thru,
    points: pointsByIdx[idx]
  }));
}

// -------------------------------------------------------------
// Formats the raw "thru" value from ESPN into something readable.
// Handles the realistic range of values this field can hold: a plain
// hole number ("14"), a finished round ("18" once all holes are
// played, sometimes reported as "F" instead), or blank/unknown before
// a round starts.
function formatThru(thru) {
  const t = String(thru || '').trim().toUpperCase();
  if (t === '' || t === '0') return '—';
  if (t === 'F' || t === '18') return 'F';
  return t;
}

// Best-effort extraction of the current round number from whatever
// ESPN actually provides. Different levels of the response sometimes
// carry this (event-level status, competition-level status, or a
// per-competitor status/period field) - this checks the plausible
// spots in order and falls back to null (shown as blank, never a
// guessed/wrong number) if none are present.
function extractRoundNumber(event, competition, sampleCompetitor) {
  const candidates = [
    event && event.status && event.status.period,
    competition && competition.status && competition.status.period,
    sampleCompetitor && sampleCompetitor.status && sampleCompetitor.status.period
  ];
  for (const c of candidates) {
    const n = parseInt(c, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

// Rendering
// -------------------------------------------------------------
function renderLeaderboard(rows, draftedByGolfer, roundNumber, personColorMap) {
  const container = document.getElementById('leaderboardTable');
  if (!rows || rows.length === 0) {
    container.innerHTML = '<div class="empty-state">No leaderboard data available.</div>';
    return;
  }
  const roundLabel = roundNumber ? ('R' + roundNumber) : 'Today';
  container.innerHTML = `
    <div class="lb-row lb-header-row">
      <div class="lb-pos"></div>
      <div class="lb-name"></div>
      <div class="lb-score">Total</div>
      <div class="lb-today">${escapeHtml(roundLabel)}</div>
      <div class="lb-thru">Thru</div>
      <div class="lb-pts">Pts</div>
    </div>
  ` + rows.map(r => {
    const owners = draftedByGolfer[normalizeGolferName(r.golfer)] || [];
    const isMine = owners.length > 0;
    // Usually one team name; joined with "+" in the rare case a golfer
    // was drafted by more than one person, so nothing is silently hidden.
    const ownerLabel = owners.join(' + ');
    // Color comes from whoever's listed first when there's more than
    // one owner - a genuinely rare case for an 8-per-team draft, so a
    // single color is a reasonable simplification rather than building
    // out a split/gradient badge for it.
    const tagColor = owners.length > 0 ? (personColorMap[owners[0]] || '#C9A24B') : '';
    return `
      <div class="lb-row ${isMine ? 'mine' : ''}">
        <div class="lb-pos">${escapeHtml(r.position)}</div>
        <div class="lb-name">${escapeHtml(r.golfer)}${isMine ? `<span class="mine-tag" style="background:${tagColor}">${escapeHtml(ownerLabel)}</span>` : ''}</div>
        <div class="lb-score ${scoreClass(r.scoreRaw)}">${escapeHtml(r.scoreRaw)}</div>
        <div class="lb-today ${scoreClass(r.today)}">${escapeHtml(r.today || '—')}</div>
        <div class="lb-thru">${escapeHtml(formatThru(r.thru))}</div>
        <div class="lb-pts">${r.points}</div>
      </div>
    `;
  }).join('');
}

function renderStandings(standings) {
  const container = document.getElementById('standingsList');
  if (!standings || standings.length === 0) {
    container.innerHTML = '<div class="empty-state">No standings data available.</div>';
    return;
  }

  const sorted = [...standings].sort((a, b) => b.total - a.total);

  container.innerHTML = sorted.map((s, idx) => {
    const rank = idx + 1;
    const prevRank = previousRankByName[s.name];
    let movementHtml = '<span class="movement"></span>';
    if (prevRank !== undefined && prevRank !== rank) {
      if (rank < prevRank) {
        movementHtml = `<span class="movement up"><svg viewBox="0 0 10 10"><polygon points="5,0 10,10 0,10"/></svg></span>`;
      } else {
        movementHtml = `<span class="movement down"><svg viewBox="0 0 10 10"><polygon points="0,0 10,0 5,10"/></svg></span>`;
      }
    }

    const golfers = currentTeams[s.name] || [];
    const chips = golfers.map(g => {
      const pts = s.golferPoints && s.golferPoints[g] !== undefined ? s.golferPoints[g] : 0;
      return `<span class="golfer-chip">${escapeHtml(g)} <span class="pts">${pts}</span></span>`;
    }).join('');

    return `
      <div class="standing-card ${rank === 1 ? 'leader' : ''}" data-name="${escapeHtml(s.name)}">
        <div class="standing-rank display">${rank}</div>
        <div>
          <div class="standing-name">${movementHtml} ${escapeHtml(s.name)}</div>
          <div class="standing-sub">${s.seasonScore || 0} season + ${s.tourChampPoints} Tour Champ.</div>
        </div>
        <div class="standing-total">${s.total}<span class="unit">pts</span></div>
        <div class="team-golfers">
          <div class="golfer-chip-row">${chips}</div>
        </div>
      </div>
    `;
  }).join('');

  // Re-attach tap-to-expand behavior
  container.querySelectorAll('.standing-card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('expanded'));
  });

  // Save this render's ranks for next comparison
  const newPrevRank = {};
  sorted.forEach((s, idx) => { newPrevRank[s.name] = idx + 1; });
  previousRankByName = newPrevRank;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showStatus(message, isError) {
  const banner = document.getElementById('statusBanner');
  if (!message) {
    banner.classList.remove('show');
    return;
  }
  banner.textContent = message;
  banner.classList.add('show');
}

// -------------------------------------------------------------
// Main refresh flow
// -------------------------------------------------------------
async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  showStatus('');

  try {
    // 1. Load Teams tab (who picked whom) - source of truth from the Sheet
    const teamsRows = await fetchSheetTab(CONFIG.TEAMS_GID);
    const headerRow = teamsRows[0] || [];
    const teams = {};
    headerRow.forEach((name, colIdx) => {
      if (!name) return;
      const picks = [];
      for (let r = 1; r < teamsRows.length && picks.length < CONFIG.GOLFERS_PER_TEAM; r++) {
        const val = teamsRows[r][colIdx];
        if (val && val.trim() !== '') picks.push(val.trim());
      }
      teams[name] = picks;
    });
    currentTeams = teams;

    // 2. Load Standings tab for Season Score (manual entries live only
    //    in the Sheet, so this is the source of truth for that column)
    let seasonScoreByName = {};
    try {
      const standingsRows = await fetchSheetTab(CONFIG.STANDINGS_GID);
      // Expect header: Person, Season Score, Tour Champ. Points, Total Score
      for (let r = 1; r < standingsRows.length; r++) {
        const [name, seasonScore] = standingsRows[r];
        if (name && name.trim() !== '' && name !== 'Ranked (auto-sorted):') {
          const n = parseFloat(seasonScore);
          if (!isNaN(n)) seasonScoreByName[name.trim()] = n;
        }
      }
    } catch (e) {
      // Non-fatal - fall back to 0 season score for everyone if this tab
      // can't be read for some reason; Tour Champ points still work.
      console.warn('Could not read Standings tab for season scores:', e);
    }
    currentSeasonScore = seasonScoreByName;

    // 3. Fetch LIVE leaderboard directly from ESPN (in-browser fetch,
    //    not routed through Apps Script - avoids the earlier blocking
    //    issue entirely). Falls back to the Sheet's last-saved
    //    Leaderboard tab if ESPN can't be reached.
    let leaderboardRows;
    let tournamentName = '';
    let roundNumber = null;
    try {
      const live = await fetchLiveLeaderboard();
      tournamentName = live.event.name || '';
      roundNumber = extractRoundNumber(live.event, live.competition, live.competitors[0]);
      leaderboardRows = computeLeaderboardRows(live.competitors, roundNumber);
    } catch (liveErr) {
      showStatus(liveErr.message, true);
      const sheetLb = await fetchSheetTab(CONFIG.LEADERBOARD_GID);
      leaderboardRows = sheetLb.slice(1)
        .filter(r => r[1]) // has a golfer name
        .map(r => ({
          position: r[0], golfer: r[1], scoreRaw: r[2], today: r[3], thru: r[4],
          points: parseFloat(r[5]) || 0
        }));
      tournamentName = (sheetLb[0] && sheetLb[0][7]) || 'Tour Championship';
    }

    document.getElementById('tournamentName').textContent = tournamentName;

    // Build a lookup: golfer name -> current points. Keyed by a
    // normalized (accent/case-insensitive) form of the name, since the
    // Teams tab and the live ESPN/Leaderboard data don't always agree
    // on exact spelling (e.g. "Ludvig Aberg" vs "Ludvig Åberg") - a
    // strict match would silently score that golfer as 0 with no error.
    const pointsByGolfer = {};
    leaderboardRows.forEach(r => { pointsByGolfer[normalizeGolferName(r.golfer)] = r.points; });
    const unmatchedPicks = [];

    // 4. Compute each team's total
    const standings = Object.keys(teams).map(name => {
      const golferPoints = {};
      let tourChampPoints = 0;
      teams[name].forEach(g => {
        const key = normalizeGolferName(g);
        const pts = pointsByGolfer[key];
        if (pts === undefined) unmatchedPicks.push(g);
        golferPoints[g] = pts !== undefined ? pts : 0;
        tourChampPoints += (pts !== undefined ? pts : 0);
      });
      const seasonScore = seasonScoreByName[name] || 0;
      return {
        name,
        seasonScore,
        tourChampPoints,
        total: seasonScore + tourChampPoints,
        golferPoints
      };
    });

    // Map of normalized golfer name -> list of person names who drafted
    // them (a golfer could be picked by more than one person in this
    // pool's format, so this keeps all of them rather than just one).
    // Normalized the same way as elsewhere so spelling differences
    // between the Teams tab and live data don't break the match.
    const draftedByGolfer = {};
    Object.entries(teams).forEach(([personName, golferList]) => {
      golferList.forEach(g => {
        const key = normalizeGolferName(g);
        if (!draftedByGolfer[key]) draftedByGolfer[key] = [];
        draftedByGolfer[key].push(personName);
      });
    });

    // Colors assigned in the same left-to-right order people's columns
    // appear on the Teams tab, so each person's color stays stable
    // across refreshes as long as the sheet's column order doesn't change.
    const personColorMap = buildPersonColorMap(Object.keys(teams));

    renderStandings(standings);
    renderLeaderboard(leaderboardRows, draftedByGolfer, roundNumber, personColorMap);

    // Surface any picks that genuinely couldn't be matched (real typos,
    // withdrawn/replaced players, etc.) - shown, not hidden, so a wrong
    // 0-point score has a visible explanation instead of just looking
    // like a bad round.
    if (unmatchedPicks.length > 0) {
      const uniqueUnmatched = [...new Set(unmatchedPicks)];
      showStatus(
        `Heads up: couldn't match ${uniqueUnmatched.length === 1 ? 'this pick' : 'these picks'} to the tournament field (scoring as 0 for now): ${uniqueUnmatched.join(', ')}. Check spelling on the Teams tab.`,
        true
      );
    }

    document.getElementById('lastUpdated').textContent =
      'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  } catch (err) {
    console.error(err);
    showStatus(err.message || 'Something went wrong loading data.', true);
    document.getElementById('lastUpdated').textContent = 'Update failed';
  } finally {
    btn.classList.remove('spinning');
    isRefreshing = false;
  }
}

// -------------------------------------------------------------
// Wiring
// -------------------------------------------------------------
document.getElementById('refreshBtn').addEventListener('click', refreshAll);

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// Initial load
refreshAll();

// Background auto-refresh (does not require the tab to be open/tapped -
// just the page to remain loaded)
if (CONFIG.AUTO_REFRESH_MS && CONFIG.AUTO_REFRESH_MS > 0) {
  setInterval(refreshAll, CONFIG.AUTO_REFRESH_MS);
}
