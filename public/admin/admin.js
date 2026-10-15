/**
 * =========================================================================
 * THE LAST DATASET — ORGANIZER COMMAND DECK (ADMIN CONTROLLER)
 * TechTatva 2026 | MAHE Manipal
 * Authoritative production progression and evaluation dashboard.
 * =========================================================================
 */

(() => {
  'use strict';

  // --- STATE ---
  const state = {
    authenticated: false,
    teams: [],
    metrics: null,
    totalPointsPossible: 3100,
    selectedTeam: null,
    filters: {
      search: '',
      stage: 'all',
      studentType: 'all',
      roster: 'all'
    },
    sort: {
      field: 'score',
      direction: 'desc'
    },
    autoRefreshSec: 15,
    autoRefreshTimer: null,
    isRefreshing: false,
    adminKey: (() => { try { return sessionStorage.getItem('tld_admin_key'); } catch (_) { return null; } })()
  };

  const CANONICAL_ZONES = [
    { id: 'sanctuary', name: 'Sanctuary', pts: 100, color: '#e5b96e', ctf: 'Gate Pass' },
    { id: 'yellow', name: 'Yellow Zone', pts: 200, color: '#f5c518', ctf: 'Industrial Quarantine (1 Flag)' },
    { id: 'blue', name: 'Blue Zone', pts: 400, color: '#56c8ff', ctf: 'blue-zone-ctf-01..04 (4 Flags)' },
    { id: 'orange', name: 'Orange Zone', pts: 600, color: '#ff8b3d', ctf: 'Burning Refinery' },
    { id: 'red', name: 'Red Zone', pts: 800, color: '#ff4058', ctf: 'Infection Telemetry & Bioarchive' },
    { id: 'purple', name: 'Purple Zone', pts: 1000, color: '#bc8cff', ctf: 'ML Survival Evaluator' }
  ];

  // --- DOM ELEMENTS ---
  const els = {
    authGate: document.getElementById('auth-gate'),
    authForm: document.getElementById('admin-login-form'),
    adminKeyInput: document.getElementById('admin-key-input'),
    toggleKeyVisibility: document.getElementById('toggle-key-visibility'),
    authErrorBanner: document.getElementById('auth-error-banner'),
    authErrorText: document.getElementById('auth-error-text'),
    authSubmitBtn: document.getElementById('auth-submit-btn'),

    adminApp: document.getElementById('admin-app'),
    clockUtc: document.getElementById('clock-utc'),
    clockLocal: document.getElementById('clock-local'),
    lastRefreshedLabel: document.getElementById('last-refreshed-label'),
    manualRefreshBtn: document.getElementById('manual-refresh-btn'),
    autoRefreshSelect: document.getElementById('auto-refresh-select'),
    exportCsvBtn: document.getElementById('export-csv-btn'),
    adminLogoutBtn: document.getElementById('admin-logout-btn'),

    deckErrorBanner: document.getElementById('deck-error-banner'),
    deckErrorTitle: document.getElementById('deck-error-title'),
    deckErrorMsg: document.getElementById('deck-error-msg'),
    deckErrorRetry: document.getElementById('deck-error-retry'),

    metricRegisteredTeams: document.getElementById('metric-registered-teams'),
    metricRegisteredSub: document.getElementById('metric-registered-sub'),
    metricActiveTeams: document.getElementById('metric-active-teams'),
    metricActiveSub: document.getElementById('metric-active-sub'),
    metricCompletedTeams: document.getElementById('metric-completed-teams'),
    metricCompletedSub: document.getElementById('metric-completed-sub'),
    metricPointsAwarded: document.getElementById('metric-points-awarded'),
    metricPointsSub: document.getElementById('metric-points-sub'),
    metricMlSubmissions: document.getElementById('metric-ml-submissions'),

    teamSearchInput: document.getElementById('team-search-input'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    filterStage: document.getElementById('filter-stage'),
    filterStudentType: document.getElementById('filter-student-type'),
    filterRoster: document.getElementById('filter-roster'),
    resetFiltersBtn: document.getElementById('reset-filters-btn'),
    teamsCountPill: document.getElementById('teams-count-pill'),

    teamsTable: document.getElementById('teams-table'),
    teamsTbody: document.getElementById('teams-tbody'),
    tableEmptyState: document.getElementById('table-empty-state'),
    emptyClearBtn: document.getElementById('empty-clear-btn'),

    modalBackdrop: document.getElementById('team-modal-backdrop'),
    modalTeamTitle: document.getElementById('modal-team-title'),
    modalTeamCreated: document.getElementById('modal-team-created'),
    modalTeamIdBadge: document.getElementById('modal-team-id-badge'),
    modalStudentTypeBadge: document.getElementById('modal-student-type-badge'),
    modalStageBadge: document.getElementById('modal-stage-badge'),
    modalIntegrityBadge: document.getElementById('modal-integrity-badge'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    modalCloseFooterBtn: document.getElementById('modal-close-footer-btn'),

    modalInconsistenciesBanner: document.getElementById('modal-inconsistencies-banner'),
    modalInconsistenciesList: document.getElementById('modal-inconsistencies-list'),
    modalRosterCapPill: document.getElementById('modal-roster-cap-pill'),
    modalRosterList: document.getElementById('modal-roster-list'),
    modalTeamPasscode: document.getElementById('modal-team-passcode'),
    modalCopyPasscodeBtn: document.getElementById('modal-copy-passcode-btn'),
    modalTeamCollege: document.getElementById('modal-team-college'),
    modalLeaderPhone: document.getElementById('modal-leader-phone'),
    modalLeaderEmail: document.getElementById('modal-leader-email'),
    modalScoreTotalPill: document.getElementById('modal-score-total-pill'),
    modalScoreProgressFill: document.getElementById('modal-score-progress-fill'),
    modalScorePct: document.getElementById('modal-score-pct'),
    modalCompletedZonesPill: document.getElementById('modal-completed-zones-pill'),
    modalZonesGrid: document.getElementById('modal-zones-grid'),
    modalMlQuotaPill: document.getElementById('modal-ml-quota-pill'),
    modalMlBestR2Pill: document.getElementById('modal-ml-best-r2-pill'),
    modalMlEscapePill: document.getElementById('modal-ml-escape-pill'),
    modalMlSubsTbody: document.getElementById('modal-ml-subs-tbody'),
    modalLedgerCountPill: document.getElementById('modal-ledger-count-pill'),
    modalScoreLedgerTbody: document.getElementById('modal-score-ledger-tbody')
  };

  // --- UTILITIES ---
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatTimeAgo(isoString) {
    if (!isoString) return 'No activity';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return 'No activity';

    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 10) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function isTeamStalled(team) {
    if (team.currentStage === 'completed' || team.score >= state.totalPointsPossible) return false;
    if (!team.lastActivityAt) return false;
    const diffHours = (Date.now() - new Date(team.lastActivityAt).getTime()) / (1000 * 60 * 60);
    return diffHours >= 2 && team.score > 0;
  }

  function updateClocks() {
    const now = new Date();
    if (els.clockUtc) els.clockUtc.textContent = now.toUTCString().slice(17, 25) + ' UTC';
    if (els.clockLocal) els.clockLocal.textContent = now.toTimeString().slice(0, 8);
  }

  function getAuthHeaders() {
    const headers = { 'Cache-Control': 'no-cache' };
    const key = state.adminKey || (() => { try { return sessionStorage.getItem('tld_admin_key'); } catch (_) { return null; } })();
    if (key) {
      headers['x-admin-key'] = key;
    }
    return headers;
  }

  // --- AUTHENTICATION ---
  async function checkAuthSession() {
    hideAuthError();
    try {
      const res = await fetch('/api/admin/session', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          showAdminApp();
          return;
        }
      }
    } catch (_) {}
    showAuthGate();
  }

  function showAuthGate() {
    state.authenticated = false;
    stopAutoRefresh();
    hideAuthError();
    document.body.dataset.adminState = 'unauthenticated';
    els.authGate.hidden = false;
    els.adminApp.hidden = true;
    if (els.adminKeyInput) els.adminKeyInput.focus();
  }

  function showAdminApp() {
    state.authenticated = true;
    hideAuthError();
    document.body.dataset.adminState = 'authenticated';
    els.authGate.hidden = true;
    els.adminApp.hidden = false;
    fetchOverview();
    startAutoRefresh();
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const key = (els.adminKeyInput.value || '').trim();
    if (!key) {
      showAuthError('Please enter the Admin Master Key.');
      return;
    }

    els.authSubmitBtn.disabled = true;
    els.authSubmitBtn.querySelector('.btn-text').textContent = 'VERIFYING CREDENTIALS…';
    hideAuthError();

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey: key })
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        state.adminKey = key;
        try { sessionStorage.setItem('tld_admin_key', key); } catch (_) {}
        els.adminKeyInput.value = '';
        hideAuthError();
        showAdminApp();
      } else {
        showAuthError(data.message || 'Invalid admin master key.');
      }
    } catch (err) {
      showAuthError(`Connection error: ${err.message}`);
    } finally {
      els.authSubmitBtn.disabled = false;
      els.authSubmitBtn.querySelector('.btn-text').textContent = 'UNLOCK COMMAND DECK →';
    }
  }

  async function handleLogout() {
    state.adminKey = null;
    try { sessionStorage.removeItem('tld_admin_key'); } catch (_) {}
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
    showAuthGate();
  }

  function showAuthError(msg) {
    if (els.authErrorBanner && els.authErrorText) {
      els.authErrorText.textContent = msg;
      els.authErrorBanner.hidden = false;
    }
  }

  function hideAuthError() {
    if (els.authErrorBanner) els.authErrorBanner.hidden = true;
  }

  // --- DATA FETCHING & REFRESH ---
  async function fetchOverview() {
    if (state.isRefreshing) return;
    state.isRefreshing = true;

    const refreshIcon = els.manualRefreshBtn?.querySelector('.refresh-icon');
    if (refreshIcon) refreshIcon.classList.add('spinning');
    if (els.deckErrorBanner) els.deckErrorBanner.hidden = true;

    try {
      const res = await fetch('/api/admin/overview', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: getAuthHeaders()
      });

      if (res.status === 401) {
        state.adminKey = null;
        try { sessionStorage.removeItem('tld_admin_key'); } catch (_) {}
        showAuthGate();
        return;
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      state.teams = data.teams || [];
      state.metrics = {
        totalTeams: data.totalTeams || state.teams.length,
        activeTeams: data.activeTeams !== undefined ? data.activeTeams : 0,
        completedTeams: data.completedTeams !== undefined ? data.completedTeams : 0,
        pointsAwarded: data.pointsAwarded !== undefined ? data.pointsAwarded : 0,
        totalMlSubmissions: data.totalMlSubmissions !== undefined ? data.totalMlSubmissions : 0
      };
      state.totalPointsPossible = data.totalPointsPossible || 3100;

      const now = new Date();
      if (els.lastRefreshedLabel) {
        els.lastRefreshedLabel.textContent = `Updated ${now.toTimeString().slice(0, 8)}`;
      }

      renderMetrics();
      renderTable();

      // If a team is currently opened in modal, refresh its view
      if (state.selectedTeam) {
        const updated = state.teams.find((t) => t.id === state.selectedTeam.id);
        if (updated) {
          state.selectedTeam = updated;
          renderTeamDetailModal(updated);
        }
      }
    } catch (err) {
      console.error('[Admin] Overview fetch error:', err);
      if (els.deckErrorBanner && els.deckErrorMsg) {
        els.deckErrorMsg.textContent = err.message || 'Network error fetching team data.';
        els.deckErrorBanner.hidden = false;
      }
    } finally {
      state.isRefreshing = false;
      if (refreshIcon) refreshIcon.classList.remove('spinning');
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    if (state.autoRefreshSec > 0) {
      state.autoRefreshTimer = setInterval(() => {
        if (state.authenticated && !state.isRefreshing) {
          fetchOverview();
        }
      }, state.autoRefreshSec * 1000);
    }
  }

  function stopAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
  }

  // --- RENDER LIVE METRICS ---
  function renderMetrics() {
    if (!state.metrics) return;
    const m = state.metrics;

    if (els.metricRegisteredTeams) els.metricRegisteredTeams.textContent = m.totalTeams;
    if (els.metricActiveTeams) els.metricActiveTeams.textContent = m.activeTeams;
    if (els.metricCompletedTeams) els.metricCompletedTeams.textContent = m.completedTeams;
    if (els.metricPointsAwarded) els.metricPointsAwarded.textContent = m.pointsAwarded.toLocaleString() + ' PTS';
    if (els.metricMlSubmissions) els.metricMlSubmissions.textContent = m.totalMlSubmissions;
  }

  // --- FILTERING & SORTING ---
  function getFilteredTeams() {
    let result = [...state.teams];
    const q = state.filters.search.toLowerCase().trim();

    // 1. Text Search
    if (q) {
      result = result.filter((t) => {
        const idMatch = (t.id || '').toLowerCase().includes(q);
        const nameMatch = (t.name || '').toLowerCase().includes(q);
        const leaderMatch = (t.leaderName || '').toLowerCase().includes(q);
        const collegeMatch = (t.college || '').toLowerCase().includes(q);
        const memberMatch = (t.members || []).some(
          (m) => (m.name || '').toLowerCase().includes(q) ||
                 (m.delegateId || '').toLowerCase().includes(q) ||
                 (m.college || '').toLowerCase().includes(q) ||
                 (m.regNo || '').toLowerCase().includes(q)
        );
        return idMatch || nameMatch || leaderMatch || collegeMatch || memberMatch;
      });
    }

    // 2. Stage Filter
    if (state.filters.stage !== 'all') {
      result = result.filter((t) => (t.currentStage || '').toLowerCase() === state.filters.stage.toLowerCase());
    }

    // 3. Student Type Filter
    if (state.filters.studentType !== 'all') {
      result = result.filter((t) => (t.studentType || '').toUpperCase() === state.filters.studentType.toUpperCase());
    }

    // 4. Roster Filter
    if (state.filters.roster !== 'all') {
      const expectedCount = Number(state.filters.roster);
      result = result.filter((t) => (t.members || []).length === expectedCount);
    }

    // 5. Sorting
    result.sort((a, b) => {
      let valA, valB;
      const field = state.sort.field;

      if (field === 'id') {
        valA = a.id || '';
        valB = b.id || '';
        return state.sort.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      } else if (field === 'score') {
        valA = a.score || 0;
        valB = b.score || 0;
        return state.sort.direction === 'asc' ? valA - valB : valB - valA;
      } else if (field === 'members') {
        valA = (a.members || []).length;
        valB = (b.members || []).length;
        return state.sort.direction === 'asc' ? valA - valB : valB - valA;
      } else if (field === 'stage') {
        valA = a.completedStagesCount || 0;
        valB = b.completedStagesCount || 0;
        return state.sort.direction === 'asc' ? valA - valB : valB - valA;
      } else if (field === 'activity') {
        valA = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        valB = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return state.sort.direction === 'asc' ? valA - valB : valB - valA;
      }
      return 0;
    });

    return result;
  }

  // --- RENDER TABLE ---
  function renderTable() {
    const filtered = getFilteredTeams();

    // Update count pill
    if (els.teamsCountPill) {
      els.teamsCountPill.textContent = `Showing ${filtered.length} of ${state.teams.length} teams`;
    }

    if (filtered.length === 0) {
      els.teamsTbody.innerHTML = '';
      els.tableEmptyState.hidden = false;
      return;
    }

    els.tableEmptyState.hidden = true;

    const html = filtered.map((t) => {
      // 1. Members
      const memberCount = (t.members || []).length;
      let memberBadgeClass = 'badge-subtle';
      if (memberCount === 2) memberBadgeClass = 'badge-green';
      else if (memberCount === 1) memberBadgeClass = 'badge-amber';

      const memberDetailsFormatted = (t.members || [])
        .map((m) => `${escapeHtml(m.name || 'Unnamed')} <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);">[${escapeHtml(m.delegateId || '—')}]</span>${m.isLeader ? ' <span class="member-leader-tag">(L)</span>' : ''}`)
        .join('<br>') || '<span class="text-muted">No registered players</span>';

      // 2. Stage badge class
      let stageBadgeClass = 'badge-subtle';
      if (t.currentStage === 'completed') stageBadgeClass = 'badge-green';
      else if (t.currentStage === 'purple') stageBadgeClass = 'badge-purple';
      else if (t.currentStage === 'red') stageBadgeClass = 'badge-red';
      else if (t.currentStage === 'orange') stageBadgeClass = 'badge-orange';
      else if (t.currentStage === 'blue') stageBadgeClass = 'badge-blue';
      else if (t.currentStage === 'yellow') stageBadgeClass = 'badge-yellow';
      else if (t.currentStage === 'sanctuary') stageBadgeClass = 'badge-gold';

      // 3. Last activity & stalled status
      const stalled = isTeamStalled(t);
      const activityRel = formatTimeAgo(t.lastActivityAt);
      const activityExact = t.lastActivityAt && !Number.isNaN(new Date(t.lastActivityAt).getTime())
        ? new Date(t.lastActivityAt).toUTCString().slice(5, 22)
        : '—';

      // 4. Score progress bar
      const scorePct = Math.min(100, Math.round(((t.score || 0) / state.totalPointsPossible) * 100));

      return `
        <tr data-team-id="${escapeHtml(t.id)}">
          <td>
            <div class="team-id-cell">
              <div class="team-id-row">
                <span class="team-id-text">${escapeHtml(t.id)}</span>
                <button class="copy-id-btn" data-copy="${escapeHtml(t.id)}" title="Copy Team ID">📋</button>
                <span class="badge ${t.studentType === 'NONMAHE' ? 'badge-blue' : 'badge-subtle'}">${escapeHtml(t.studentType || 'MAHE')}</span>
              </div>
              <span class="team-name-text">${escapeHtml(t.name)}</span>
              ${t.college ? `<span style="font-size:10px;color:var(--text-muted);">${escapeHtml(t.college)}</span>` : ''}
            </div>
          </td>
          <td>
            <div class="members-cell">
              <div><span class="badge ${memberBadgeClass}">${memberCount} ${memberCount === 1 ? 'Player (Solo)' : 'Players'}</span></div>
              <div class="member-names-list" style="margin-top: 3px; line-height: 1.4;">${memberDetailsFormatted}</div>
            </div>
          </td>
          <td>
            <div style="display:flex;flex-direction:column;gap:4px;">
              <div><span class="badge ${stageBadgeClass}">${escapeHtml(t.currentStage)}</span></div>
              <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);">${t.completedStagesCount || 0} / 6 Cleared</span>
            </div>
          </td>
          <td>
            <div class="score-cell">
              <span class="score-num">${(t.score || 0).toLocaleString()} <small style="color:var(--text-muted);font-weight:400;">/ ${state.totalPointsPossible}</small></span>
              <div class="score-mini-bar">
                <div class="score-mini-fill" style="width: ${scorePct}%;"></div>
              </div>
            </div>
          </td>
          <td>
            <div class="activity-cell">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="activity-rel">${activityRel}</span>
                ${stalled ? '<span class="badge badge-stalled">STALLED</span>' : ''}
              </div>
              <span class="activity-exact">${activityExact}</span>
            </div>
          </td>
          <td>
            <button class="btn btn-secondary btn-xs inspect-btn" data-team-id="${escapeHtml(t.id)}">Inspect →</button>
          </td>
        </tr>
      `;
    }).join('');

    els.teamsTbody.innerHTML = html;
  }

  // --- INDIVIDUAL TEAM DETAIL INSPECTION MODAL ---
  function openTeamDetail(teamId) {
    const team = state.teams.find((t) => t.id === teamId);
    if (!team) return;

    state.selectedTeam = team;
    renderTeamDetailModal(team);
    els.modalBackdrop.hidden = false;
  }

  function closeTeamDetail() {
    state.selectedTeam = null;
    els.modalBackdrop.hidden = true;
  }

  function renderTeamDetailModal(team) {
    // Header
    els.modalTeamTitle.textContent = team.name || team.id;
    els.modalTeamCreated.textContent = `Team ID: ${team.id}${team.college ? ` · ${team.college}` : ''}`;
    els.modalTeamIdBadge.textContent = team.id;
    els.modalStudentTypeBadge.textContent = team.studentType || 'MAHE';
    els.modalStageBadge.textContent = `CURRENT: ${(team.currentStage || 'SANCTUARY').toUpperCase()}`;

    // Integrity banner (only show if real anomalies exist)
    if (team.hasInconsistencies && team.inconsistencies.length > 0) {
      if (els.modalIntegrityBadge) {
        els.modalIntegrityBadge.hidden = false;
        els.modalIntegrityBadge.className = 'badge badge-red';
        els.modalIntegrityBadge.textContent = `⚠ ${team.inconsistencies.length} PROGRESSION ANOMALIES`;
      }
      if (els.modalInconsistenciesList) {
        els.modalInconsistenciesList.innerHTML = team.inconsistencies
          .map((i) => `<li><strong>[${escapeHtml(i.type)}]</strong> ${escapeHtml(i.message)}</li>`)
          .join('');
      }
      if (els.modalInconsistenciesBanner) els.modalInconsistenciesBanner.hidden = false;
    } else {
      if (els.modalIntegrityBadge) els.modalIntegrityBadge.hidden = true;
      if (els.modalInconsistenciesBanner) els.modalInconsistenciesBanner.hidden = true;
    }

    // Roster
    const members = team.members || [];
    els.modalRosterCapPill.textContent = `${members.length} / 2 Players (${members.length === 1 ? 'Solo' : 'Full Roster'})`;
    els.modalRosterCapPill.className = members.length === 2 ? 'badge badge-green' : 'badge badge-amber';

    if (members.length > 0) {
      els.modalRosterList.innerHTML = members.map((m, idx) => `
        <div class="player-card">
          <div class="player-card-role">${m.isLeader ? '⭐ TEAM LEADER (P1)' : `PLAYER ${idx + 1}`}</div>
          <div class="player-card-name">${escapeHtml(m.name || 'Unnamed')}</div>
          <div class="player-card-id">DELEGATE ID: <b>${escapeHtml(m.delegateId || 'NONE')}</b></div>
          ${m.regNo ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-top:2px;">REG NO: <b>${escapeHtml(m.regNo)}</b></div>` : ''}
          ${m.college ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${escapeHtml(m.college)}</div>` : ''}
        </div>
      `).join('');
    } else {
      els.modalRosterList.innerHTML = '<div class="text-muted" style="grid-column: 1 / -1; padding: 10px;">No registered players recorded for this team.</div>';
    }

    // Credentials block
    if (els.modalTeamPasscode) els.modalTeamPasscode.textContent = team.passcode || '—';
    if (els.modalTeamCollege) els.modalTeamCollege.textContent = team.college || '—';
    if (els.modalLeaderPhone) els.modalLeaderPhone.textContent = team.leaderMobile || 'Not provided';
    if (els.modalLeaderEmail) els.modalLeaderEmail.textContent = team.leaderEmail || 'Not provided';

    if (els.modalCopyPasscodeBtn) {
      els.modalCopyPasscodeBtn.onclick = () => {
        if (!team.passcode) return;
        navigator.clipboard?.writeText(team.passcode).then(() => {
          els.modalCopyPasscodeBtn.textContent = '✓ Copied';
          setTimeout(() => { els.modalCopyPasscodeBtn.textContent = '📋 Copy'; }, 1500);
        });
      };
    }

    // Score breakdown
    const scorePct = Math.min(100, Math.round(((team.score || 0) / state.totalPointsPossible) * 100));
    els.modalScoreTotalPill.textContent = `${(team.score || 0).toLocaleString()} / ${state.totalPointsPossible} PTS`;
    els.modalScoreProgressFill.style.width = `${scorePct}%`;
    els.modalScorePct.textContent = `${scorePct}% Completed`;

    // 6-stage chips
    const completedSet = new Set(team.completedStages || []);
    CANONICAL_ZONES.forEach((z) => {
      const isCleared = completedSet.has(z.id);
      const chip = document.querySelector(`.stage-point-chip[data-zone="${z.id}"]`);
      if (chip) {
        if (isCleared) {
          chip.classList.add('chip-cleared');
          chip.querySelector('.chip-status').textContent = 'AWARDED';
        } else {
          chip.classList.remove('chip-cleared');
          chip.querySelector('.chip-status').textContent = 'LOCKED';
        }
      }
    });

    // 6-Zone Progression Cards Grid
    els.modalCompletedZonesPill.textContent = `${team.completedStagesCount || 0} / 6 Stages Completed`;
    els.modalZonesGrid.innerHTML = CANONICAL_ZONES.map((z) => {
      const zoneData = team.zones?.[z.id] || { status: 'locked', solvedChallenges: [], completedAt: null };
      const isCleared = zoneData.status === 'completed';
      let statusBadge = '<span class="badge badge-locked">LOCKED</span>';
      if (isCleared) statusBadge = '<span class="badge badge-green">COMPLETED</span>';
      else if (zoneData.status === 'available') statusBadge = '<span class="badge badge-blue">IN PROGRESS</span>';

      const solvedList = zoneData.solvedChallenges || [];
      const ctfSolved = solvedList.includes(z.ctf);

      return `
        <div class="zone-card" style="border-left: 3px solid ${z.color};">
          <div class="zone-card-top">
            <span class="zone-card-name">${escapeHtml(z.name)}</span>
            <span class="zone-card-pts">+${z.pts} PTS</span>
          </div>
          <div>${statusBadge}</div>
          <div style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted);">
            Cleared: ${zoneData.completedAt ? new Date(zoneData.completedAt).toUTCString().slice(5, 22) : '—'}
          </div>
          <div class="zone-card-challenges">
            <div class="challenge-item ${ctfSolved ? 'challenge-solved' : ''}">
              <span>CTF: ${escapeHtml(z.ctf)}</span>
              <span>${ctfSolved ? '✓ SOLVED' : '○ PENDING'}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Purple ML Submissions History
    const mlSubs = team.ml?.submissions || [];
    els.modalMlQuotaPill.textContent = `${mlSubs.length} / 10 Used`;
    els.modalMlBestR2Pill.textContent = team.ml?.bestR2 !== null && team.ml?.bestR2 !== undefined
      ? `Best R²: ${team.ml.bestR2.toFixed(4)}`
      : 'Best R²: None';
    els.modalMlEscapePill.textContent = team.ml?.escapeUnlocked
      ? 'Escape: QUALIFIED (≥0.80)'
      : 'Escape: LOCKED';
    els.modalMlEscapePill.className = team.ml?.escapeUnlocked ? 'badge badge-green' : 'badge badge-red';

    if (mlSubs.length > 0) {
      els.modalMlSubsTbody.innerHTML = mlSubs.map((s, idx) => {
        const r2Str = typeof s.r2Score === 'number' ? s.r2Score.toFixed(4) : '—';
        const mseStr = typeof s.mseScore === 'number' ? s.mseScore.toFixed(6) : '—';
        const qualifies = Boolean(s.qualifiesForEscape);
        let r2Color = 'color: #ff6e80;';
        if (s.r2Score >= 0.80) r2Color = 'color: #4ade80; font-weight: 700;';
        else if (s.r2Score > 0) r2Color = 'color: #f5c518;';

        return `
          <tr>
            <td>#${mlSubs.length - idx}</td>
            <td>${s.submittedAt ? new Date(s.submittedAt).toUTCString().slice(5, 25) : '—'}</td>
            <td>${escapeHtml(s.delegateId)}</td>
            <td>${escapeHtml(s.rawFilename || 'submission.csv')}</td>
            <td style="${r2Color}">${r2Str}</td>
            <td>${mseStr}</td>
            <td>${qualifies ? '<span class="badge badge-green">✓ QUALIFIED</span>' : '<span class="badge badge-subtle">✕ NO</span>'}</td>
            <td>${escapeHtml(s.errorMessage || s.status || 'valid')}</td>
          </tr>
        `;
      }).join('');
    } else {
      els.modalMlSubsTbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No ML submissions recorded for this team.</td></tr>';
    }

    // Score Ledger Audit Trail
    const ledger = team.scoreLedger || [];
    els.modalLedgerCountPill.textContent = `${ledger.length} Entries`;

    if (ledger.length > 0) {
      els.modalScoreLedgerTbody.innerHTML = ledger.map((sc) => `
        <tr>
          <td>${sc.createdAt ? new Date(sc.createdAt).toUTCString().slice(5, 25) : '—'}</td>
          <td style="color:#4ade80;font-weight:700;">+${sc.points} PTS</td>
          <td>${escapeHtml(sc.sourceType || 'zone_clear')}</td>
          <td>${escapeHtml(sc.sourceId || '—')}</td>
          <td>${escapeHtml(sc.delegateId || 'LEADER')}</td>
          <td><code>${escapeHtml(sc.idempotencyKey || '—')}</code></td>
        </tr>
      `).join('');
    } else {
      els.modalScoreLedgerTbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No score ledger records found.</td></tr>';
    }
  }

  // --- CSV EXPORT ---
  function exportProgressCsv() {
    if (!state.teams || state.teams.length === 0) {
      alert('No team data available to export.');
      return;
    }

    const headers = [
      'Team ID',
      'Team Name',
      'Student Type',
      'College',
      'Access Passcode',
      'Leader Name',
      'Leader Mobile',
      'Leader Email',
      'Member 1 Name',
      'Member 1 ID',
      'Member 2 Name',
      'Member 2 ID',
      'Member Count',
      'Current Stage',
      'Completed Stages Count',
      'Total Score (Max 3100)',
      'ML Submissions Used',
      'Best R2 Score',
      'Escape Unlocked',
      'Last Activity UTC'
    ];

    const rows = state.teams.map((t) => {
      const m1 = t.members?.[0] || {};
      const m2 = t.members?.[1] || {};

      return [
        t.id,
        t.name || t.id,
        t.studentType || 'MAHE',
        t.college || m1.college || '',
        t.passcode || '',
        t.leaderName || m1.name || '',
        t.leaderMobile || m1.phone || '',
        t.leaderEmail || m1.email || '',
        m1.name || '',
        m1.delegateId || '',
        m2.name || '',
        m2.delegateId || '',
        (t.members || []).length,
        t.currentStage,
        t.completedStagesCount || 0,
        t.score || 0,
        t.ml?.submissionsUsed || 0,
        t.ml?.bestR2 !== null && t.ml?.bestR2 !== undefined ? t.ml.bestR2 : '',
        t.ml?.escapeUnlocked ? 'TRUE' : 'FALSE',
        t.lastActivityAt || ''
      ];
    });

    const csvContent = [
      headers.map(escapeCsvField).join(','),
      ...rows.map((row) => row.map(escapeCsvField).join(','))
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', `the-last-dataset-teams-${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function escapeCsvField(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return `"${str}"`;
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    // Auth Form
    els.authForm?.addEventListener('submit', handleLoginSubmit);

    // Toggle Password Visibility
    els.toggleKeyVisibility?.addEventListener('click', () => {
      const type = els.adminKeyInput.type === 'password' ? 'text' : 'password';
      els.adminKeyInput.type = type;
      els.toggleKeyVisibility.textContent = type === 'password' ? '👁' : '🔒';
    });

    // Logout
    els.adminLogoutBtn?.addEventListener('click', handleLogout);

    // Manual Refresh
    els.manualRefreshBtn?.addEventListener('click', () => {
      fetchOverview();
    });

    // Auto Refresh Select
    els.autoRefreshSelect?.addEventListener('change', (e) => {
      state.autoRefreshSec = Number(e.target.value);
      startAutoRefresh();
    });

    // Export CSV
    els.exportCsvBtn?.addEventListener('click', exportProgressCsv);

    // Error Retry
    els.deckErrorRetry?.addEventListener('click', () => {
      fetchOverview();
    });

    // Search input
    els.teamSearchInput?.addEventListener('input', (e) => {
      state.filters.search = e.target.value;
      if (els.clearSearchBtn) els.clearSearchBtn.hidden = !e.target.value;
      renderTable();
    });

    els.clearSearchBtn?.addEventListener('click', () => {
      state.filters.search = '';
      els.teamSearchInput.value = '';
      els.clearSearchBtn.hidden = true;
      renderTable();
      els.teamSearchInput.focus();
    });

    // Filters
    els.filterStage?.addEventListener('change', (e) => {
      state.filters.stage = e.target.value;
      renderTable();
    });

    els.filterStudentType?.addEventListener('change', (e) => {
      state.filters.studentType = e.target.value;
      renderTable();
    });

    els.filterRoster?.addEventListener('change', (e) => {
      state.filters.roster = e.target.value;
      renderTable();
    });

    // Reset Filters
    const resetAllFilters = () => {
      state.filters = { search: '', stage: 'all', studentType: 'all', roster: 'all' };
      if (els.teamSearchInput) els.teamSearchInput.value = '';
      if (els.clearSearchBtn) els.clearSearchBtn.hidden = true;
      if (els.filterStage) els.filterStage.value = 'all';
      if (els.filterStudentType) els.filterStudentType.value = 'all';
      if (els.filterRoster) els.filterRoster.value = 'all';
      renderTable();
    };

    els.resetFiltersBtn?.addEventListener('click', resetAllFilters);
    els.emptyClearBtn?.addEventListener('click', resetAllFilters);

    // Table sorting
    els.teamsTable?.addEventListener('click', (e) => {
      const th = e.target.closest('th.th-sortable');
      if (th) {
        const field = th.dataset.sort;
        if (state.sort.field === field) {
          state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort.field = field;
          state.sort.direction = 'desc';
        }
        renderTable();
        return;
      }

      // Copy button
      const copyBtn = e.target.closest('.copy-id-btn');
      if (copyBtn) {
        const text = copyBtn.dataset.copy;
        navigator.clipboard?.writeText(text).then(() => {
          copyBtn.textContent = '✓';
          setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
        });
        return;
      }

      // Inspect button or row click
      const inspectBtn = e.target.closest('.inspect-btn');
      if (inspectBtn) {
        openTeamDetail(inspectBtn.dataset.teamId);
        return;
      }

      const row = e.target.closest('tbody tr');
      if (row && row.dataset.teamId) {
        openTeamDetail(row.dataset.teamId);
      }
    });

    // Modal close
    els.modalCloseBtn?.addEventListener('click', closeTeamDetail);
    els.modalCloseFooterBtn?.addEventListener('click', closeTeamDetail);
    els.modalBackdrop?.addEventListener('click', (e) => {
      if (e.target === els.modalBackdrop) closeTeamDetail();
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.modalBackdrop.hidden) {
        closeTeamDetail();
      } else if (e.key === 'r' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        fetchOverview();
      } else if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        els.teamSearchInput?.focus();
      }
    });

    // Clocks
    setInterval(updateClocks, 1000);
    updateClocks();
  }

  // --- INITIALIZE ---
  function init() {
    setupEventListeners();
    checkAuthSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
