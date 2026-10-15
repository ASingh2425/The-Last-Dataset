(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let currentTeam = null;
  let activeSession = null;
  let rawCsvContent = '';
  let selectedFileName = '';
  let preflightValid = false;
  let toastTimer = null;

  // 120 Ground Truth Test Survivor IDs
  const TEST_SURVIVOR_IDS = new Set([
    'SANC-0091','SANC-0092','SANC-0093','SANC-0094','SANC-0095','SANC-0096','SANC-0097','SANC-0098','SANC-0099','SANC-0100',
    'SANC-0101','SANC-0102','SANC-0103','SANC-0104','SANC-0105','SANC-0106','SANC-0107','SANC-0108','SANC-0109','SANC-0110',
    'SANC-0111','SANC-0112','SANC-0113','SANC-0114','SANC-0115','SANC-0116','SANC-0117','SANC-0118','SANC-0119','SANC-0120',
    'SANC-0001','SANC-0002','SANC-0003','SANC-0004','SANC-0005','SANC-0006','SANC-0007','SANC-0008','SANC-0009','SANC-0010',
    'SANC-0011','SANC-0012','SANC-0013','SANC-0014','SANC-0015','SANC-0016','SANC-0017','SANC-0018','SANC-0019','SANC-0020',
    'SANC-0021','SANC-0022','SANC-0023','SANC-0024','SANC-0025','SANC-0026','SANC-0027','SANC-0028','SANC-0029','SANC-0030',
    'SANC-0031','SANC-0032','SANC-0033','SANC-0034','SANC-0035','SANC-0036','SANC-0037','SANC-0038','SANC-0039','SANC-0040',
    'SANC-0041','SANC-0042','SANC-0043','SANC-0044','SANC-0045','SANC-0046','SANC-0047','SANC-0048','SANC-0049','SANC-0050',
    'SANC-0051','SANC-0052','SANC-0053','SANC-0054','SANC-0055','SANC-0056','SANC-0057','SANC-0058','SANC-0059','SANC-0060',
    'SANC-0061','SANC-0062','SANC-0063','SANC-0064','SANC-0065','SANC-0066','SANC-0067','SANC-0068','SANC-0069','SANC-0070',
    'SANC-0071','SANC-0072','SANC-0073','SANC-0074','SANC-0075','SANC-0076','SANC-0077','SANC-0078','SANC-0079','SANC-0080',
    'SANC-0081','SANC-0082','SANC-0083','SANC-0084','SANC-0085','SANC-0086','SANC-0087','SANC-0088','SANC-0089','SANC-0090'
  ]);

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  function toast(message, type = 'info') {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 4000);
  }

  // ------------------------------------------------------------------------
  // AUTH & LAUNCH TOKEN CONTEXT
  // ------------------------------------------------------------------------
  try {
    const p = new URLSearchParams(window.location.search);
    const lt = (p.get('launchToken') || '').trim();
    const tid = (p.get('team') || p.get('teamId') || '').trim().toUpperCase();

    let storedTeam = (sessionStorage.getItem('manu_team_id') || localStorage.getItem('manu_team_id') || '').trim().toUpperCase();
    let storedToken = (sessionStorage.getItem('tld_launch_token') || localStorage.getItem('tld_launch_token') || '').trim();

    // Check if stored token belonged to TECHTEAM10328
    if (storedToken) {
      try {
        const payload = JSON.parse(atob(storedToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload && (payload.teamId === 'TECHTEAM10328' || payload.team === 'TECHTEAM10328') && tid !== 'TECHTEAM10328') {
          sessionStorage.removeItem('tld_launch_token');
          localStorage.removeItem('tld_launch_token');
          storedToken = '';
        }
      } catch (_) {}
    }

    if (storedTeam === 'TECHTEAM10328' && tid !== 'TECHTEAM10328') {
      sessionStorage.removeItem('manu_team_id');
      localStorage.removeItem('manu_team_id');
      sessionStorage.removeItem('tld_launch_token');
      localStorage.removeItem('tld_launch_token');
      storedTeam = '';
      storedToken = '';
    }

    const effectiveTeam = tid || (storedTeam !== 'TECHTEAM10328' ? storedTeam : '');
    const effectiveToken = lt || storedToken;

    if (effectiveTeam && effectiveTeam !== 'TECHTEAM10328') {
      sessionStorage.setItem('manu_team_id', effectiveTeam);
      localStorage.setItem('manu_team_id', effectiveTeam);
    }
    if (effectiveToken) {
      sessionStorage.setItem('tld_launch_token', effectiveToken);
      localStorage.setItem('tld_launch_token', effectiveToken);
    }
  } catch (_) {}

  function getStoredLaunchToken() {
    try {
      const p = new URLSearchParams(window.location.search);
      const urlToken = (p.get('launchToken') || '').trim();
      const currentTeam = getStoredTeamId();
      let token = urlToken || (sessionStorage.getItem('tld_launch_token') || localStorage.getItem('tld_launch_token') || '').trim();
      if (token && currentTeam && currentTeam !== 'TECHTEAM10328') {
        try {
          const payload = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload && (payload.teamId === 'TECHTEAM10328' || payload.team === 'TECHTEAM10328')) {
            sessionStorage.removeItem('tld_launch_token');
            localStorage.removeItem('tld_launch_token');
            token = '';
          }
        } catch (_) {}
      }
      return token;
    } catch (_) { return ''; }
  }

  function getStoredTeamId() {
    try {
      const p = new URLSearchParams(window.location.search);
      const urlTeam = (p.get('team') || p.get('teamId') || '').trim().toUpperCase();
      let stored = (sessionStorage.getItem('manu_team_id') || localStorage.getItem('manu_team_id') || '').trim().toUpperCase();
      if (stored === 'TECHTEAM10328' && urlTeam !== 'TECHTEAM10328') {
        sessionStorage.removeItem('manu_team_id');
        localStorage.removeItem('manu_team_id');
        stored = '';
      }
      return urlTeam || (stored !== 'TECHTEAM10328' ? stored : '');
    } catch (_) { return ''; }
  }

  function updateDatasetLinks() {
    const lt = getStoredLaunchToken();
    const tid = getStoredTeamId() || currentTeam?.id;
    if (!lt && !tid) return;
    const params = new URLSearchParams();
    if (lt) params.set('launchToken', lt);
    if (tid) params.set('team', tid);
    const qs = params.toString();
    $$('a[href^="/api/dataset/"]').forEach((a) => {
      const base = a.getAttribute('href').split('?')[0];
      a.href = `${base}?${qs}`;
    });
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/api/dataset/"]');
    if (!a) return;
    const lt = getStoredLaunchToken();
    const tid = getStoredTeamId() || currentTeam?.id;
    if (!lt && !tid) return;
    try {
      const url = new URL(a.href, window.location.origin);
      if (lt && !url.searchParams.has('launchToken')) url.searchParams.set('launchToken', lt);
      if (tid && !url.searchParams.has('team')) url.searchParams.set('team', tid);
      a.href = url.pathname + '?' + url.searchParams.toString();
    } catch (_) {}
  }, { capture: true });


  async function api(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (!headers['Accept']) {
      headers['Accept'] = 'application/json';
    }
    const lt = getStoredLaunchToken();
    if (lt && !headers['x-launch-token']) {
      headers['x-launch-token'] = lt;
    }
    const tid = getStoredTeamId();
    if (tid && !headers['x-team-id']) {
      headers['x-team-id'] = tid;
    }

    const res = await fetch(url, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  // ------------------------------------------------------------------------
  // TAB NAVIGATION
  // ------------------------------------------------------------------------
  function switchTab(tabId) {
    $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabId));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tabId}`));

    if (tabId === 'submissions') loadSubmissions();
    if (tabId === 'leaderboard') loadLeaderboard();
  }

  function setupTabs() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  // ------------------------------------------------------------------------
  // BOOTSTRAP & SESSION STATUS
  // ------------------------------------------------------------------------
  async function initBootstrap() {
    try {
      const data = await api('/api/bootstrap');
      activeSession = data;
      updateDatasetLinks();
      if (!data.authenticated) {
        $('#team-display').textContent = 'UNAUTHENTICATED SURVIVOR';
        $('#team-score').textContent = '0 PTS';
        updateGatePill(false);
        toast('PLEASE LOG IN AT THE SANCTUARY GATE TO ACCESS LIVE EVALUATION.', 'error');
        return;
      }

      currentTeam = data.team;
      if (data.team?.id) {
        try {
          sessionStorage.setItem('manu_team_id', data.team.id);
          localStorage.setItem('manu_team_id', data.team.id);
        } catch (_) {}
      }
      updateDatasetLinks();
      const leader = data.player?.delegateId ? ` · OP ${data.player.delegateId}` : '';
      $('#team-display').innerHTML = `<strong>${escapeHtml(data.team.name)}</strong> (${escapeHtml(data.team.id)}${leader})`;
      $('#team-score').textContent = `${data.score?.total || 0} PTS`;

      const escapeUnlocked = !!(data.ml?.escapeUnlocked);
      updateGatePill(escapeUnlocked);

      await loadSubmissions();

      if (escapeUnlocked) {
        showQualifiedState({
          r2Score: data.ml?.bestR2 || 1.0,
          mseScore: 0.0,
          qualifiesForEscape: true,
          message: 'CORE ESCAPE GATE AUTHORIZED! SURVIVOR COMPLETE!'
        });
      }
    } catch (err) {
      console.warn('Bootstrap fetch failed:', err);
      $('#team-display').textContent = 'OFFLINE PROTOCOL';
      updateGatePill(false);
    }
  }

  function updateGatePill(unlocked) {
    const pill = $('#gate-status-pill');
    if (!pill) return;
    if (unlocked) {
      pill.classList.add('unlocked');
      pill.innerHTML = '<span class="dot-indicator"></span> TRANSIT GATE: UNLOCKED';
    } else {
      pill.classList.remove('unlocked');
      pill.innerHTML = '<span class="dot-indicator"></span> TRANSIT GATE: LOCKED (TARGET: ≥80.00%)';
    }
  }

  // ------------------------------------------------------------------------
  // CLIENT-SIDE PRE-FLIGHT CSV VALIDATION (Instant Format Check)
  // ------------------------------------------------------------------------
  function validateCsv(content) {
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const result = {
      headerPass: false,
      countPass: false,
      idsPass: false,
      rangePass: false,
      rowCount: 0,
      preview: [],
      error: null
    };

    if (lines.length < 2) {
      result.error = 'File is empty or missing headers.';
      return result;
    }

    // 1. Check Header
    const headerCols = lines[0].split(',').map((c) => c.trim().toLowerCase());
    const idIdx = headerCols.findIndex((c) => c === 'sanctuary_id');
    const predIdx = headerCols.findIndex((c) => c === 'survival_probability');

    if (idIdx !== -1 && predIdx !== -1) {
      result.headerPass = true;
    } else {
      result.error = 'Header must contain "Sanctuary_ID" and "Survival_Probability".';
      return result;
    }

    // 2. Parse & Validate Rows
    const foundIds = new Set();
    let allRangesValid = true;

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map((p) => p.trim());
      if (parts.length < 2) continue;
      const id = parts[idIdx];
      const val = parseFloat(parts[predIdx]);

      if (!id || foundIds.has(id) || !TEST_SURVIVOR_IDS.has(id)) {
        result.idsPass = false;
        result.error = `Invalid or duplicate Sanctuary_ID: "${id}" at row ${i + 1}`;
        return result;
      }
      foundIds.add(id);

      if (isNaN(val) || val < 0.0 || val > 1.0) {
        allRangesValid = false;
        result.error = `Probability out of range [0.0, 1.0]: "${parts[predIdx]}" for ${id}`;
        return result;
      }

      if (result.preview.length < 5) {
        result.preview.push({ id, val });
      }
    }

    result.rowCount = foundIds.size;
    result.countPass = (result.rowCount === 120);
    result.idsPass = true;
    result.rangePass = allRangesValid;

    if (!result.countPass) {
      result.error = `Expected exactly 120 prediction rows, found ${result.rowCount}`;
    }

    return result;
  }

  function handleFileSelect(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast('Invalid file format: must be a .csv file', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast(`File size (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds 5MB limit`, 'error');
      return;
    }
    selectedFileName = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      rawCsvContent = e.target.result;
      runPreflightCheck();
    };
    reader.onerror = () => {
      toast('Failed to read file from local device', 'error');
    };
    reader.readAsText(file);
  }

  function runPreflightCheck() {
    if (!rawCsvContent) return;
    const check = validateCsv(rawCsvContent);

    $('#check-filename').textContent = selectedFileName || 'submission.csv';
    $('#check-header').textContent = check.headerPass ? 'PASS ✓' : 'FAIL ✗';
    $('#check-header').className = `check-status ${check.headerPass ? 'pass' : 'fail'}`;

    $('#check-count').textContent = `${check.rowCount}/120 ${check.countPass ? 'PASS ✓' : 'FAIL ✗'}`;
    $('#check-count').className = `check-status ${check.countPass ? 'pass' : 'fail'}`;

    $('#check-ids').textContent = check.idsPass ? '120 VALID IDS ✓' : 'UNRECOGNIZED IDS ✗';
    $('#check-ids').className = `check-status ${check.idsPass ? 'pass' : 'fail'}`;

    $('#check-range').textContent = check.rangePass ? 'VALID [0.0 - 1.0] ✓' : 'OUT OF BOUNDS ✗';
    $('#check-range').className = `check-status ${check.rangePass ? 'pass' : 'fail'}`;

    $('#preflight-card').hidden = false;

    preflightValid = check.headerPass && check.countPass && check.idsPass && check.rangePass;
    $('#btn-submit-eval').disabled = !preflightValid;

    if (preflightValid) {
      toast('PRE-FLIGHT VALIDATION PASSED · READY TO TRANSMIT', 'success');
    } else if (check.error) {
      toast(check.error, 'error');
    }
  }

  // ------------------------------------------------------------------------
  // TRANSMIT SUBMISSION & EVALUATE
  // ------------------------------------------------------------------------
  async function submitEvaluation() {
    if (!rawCsvContent || !preflightValid) return;
    const btn = $('#btn-submit-eval');
    btn.disabled = true;
    btn.innerHTML = 'TRANSMITTING TO CORE EVALUATOR… <span class="dot-indicator"></span>';

    try {
      const res = await api('/api/ml/evaluate', {
        method: 'POST',
        body: {
          csvContent: rawCsvContent,
          rawFilename: selectedFileName || 'submission.csv'
        }
      });

      renderScoreResult(res);

      if (res.qualifiesForEscape) {
        updateGatePill(true);
        showHelicopterActiveBanner(true);
        // Signal the parent Map Hub window so the world map unlocks finale
        const targetOrigin = window.location.origin;
        if (window.opener) {
          window.opener.postMessage({ type: 'PURPLE_ESCAPE_QUALIFIED' }, targetOrigin);
        }
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'PURPLE_ESCAPE_QUALIFIED' }, targetOrigin);
        }
        toast('QUALIFIED FOR ESCAPE! EXTRACTION TRANSPORTER INBOUND!', 'success');
        // Trigger the cinematic helicopter arrival sequence
        triggerHelicopterExtraction(res);
      } else {
        toast(`Evaluation Complete: R² = ${(res.r2Score * 100).toFixed(2)}%`, 'info');
      }

      // Refresh submissions count badge & reload list
      await loadSubmissions();
    } catch (err) {
      toast(err.message || 'Evaluation rejected by server.', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'TRANSMIT TO PRALAYA CORE EVALUATOR →';
      // Re-check quota state to ensure disabled if 10 reached
      checkQuotaState();
    }
  }

  function showHelicopterActiveBanner(show = true) {
    const banner = $('#helicopter-active-banner');
    if (banner) {
      banner.hidden = !show;
      banner.style.display = show ? 'flex' : 'none';
    }
  }

  function triggerHelicopterExtraction(result) {
    const modal = $('#extraction-modal');
    if (!modal) return;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');

    const rig = $('#helicopter-rig');
    const ring = $('#helipad-deck-ring');
    const tag = $('#extraction-readout-tag');
    const sub = $('#extraction-readout-sub');
    const boardBtn = $('#btn-board-transporter');

    if (rig) rig.className = 'helicopter-rig approach';
    if (ring) ring.classList.add('active');
    if (tag) tag.textContent = 'EXTRACTION TRANSPORTER EX-09 INBOUND // AZIMUTH 042°';
    if (sub) sub.textContent = 'Descent initiated. Stand clear of Tactical Helipad Pad 01.';
    if (boardBtn) {
      boardBtn.disabled = true;
      boardBtn.innerHTML = 'TRANSPORTER INBOUND… <span class="dot-indicator"></span>';
    }

    // Touchdown after 3.8s approach animation
    setTimeout(() => {
      if (rig) rig.className = 'helicopter-rig landed';
      if (tag) tag.textContent = 'AIRCRAFT TOUCHDOWN CONFIRMED // PAD 01 HOT';
      if (sub) sub.textContent = 'Crew boarding permit authorized. All 120 survivor records secured.';
      if (boardBtn) {
        boardBtn.disabled = false;
        boardBtn.textContent = 'BOARD EXTRACTION TRANSPORTER EX-09 →';
      }
    }, 3800);
  }

  function openExtractionModal(state = 'landed') {
    const modal = $('#extraction-modal');
    if (!modal) return;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');

    const rig = $('#helicopter-rig');
    const tag = $('#extraction-readout-tag');
    const sub = $('#extraction-readout-sub');
    const boardBtn = $('#btn-board-transporter');

    if (rig) rig.className = `helicopter-rig ${state}`;
    if (tag) tag.textContent = 'AIRCRAFT TOUCHDOWN CONFIRMED // PAD 01 HOT';
    if (sub) sub.textContent = 'Crew boarding permit authorized. Board to evacuate the Core.';
    if (boardBtn) {
      boardBtn.disabled = false;
      boardBtn.textContent = 'BOARD EXTRACTION TRANSPORTER EX-09 →';
    }
  }

  function closeExtractionModal() {
    const modal = $('#extraction-modal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }

  function handleBoardTransporter() {
    const rig = $('#helicopter-rig');
    const tag = $('#extraction-readout-tag');
    const sub = $('#extraction-readout-sub');
    const boardBtn = $('#btn-board-transporter');

    if (boardBtn) {
      boardBtn.disabled = true;
      boardBtn.innerHTML = 'ASCENDING FROM PAD 01… <span class="dot-indicator"></span>';
    }
    if (rig) rig.className = 'helicopter-rig depart';
    if (tag) tag.textContent = 'EXTRACTION IN PROGRESS // AIRSPACE CLEARANCE GRANTED';
    if (sub) sub.textContent = 'Ascending to 1,500m. Transmitting telemetry to Sanctuary World Map.';

    toast('EXTRACTION CONFIRMED // ASCENDING FROM PAD 01', 'success');

    // Wait for departure flight animation (4.2s)
    setTimeout(() => {
      closeExtractionModal();
      if (window.opener) {
        window.opener.postMessage({ type: 'PURPLE_ESCAPE_QUALIFIED' }, '*');
        window.opener.focus();
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'PURPLE_ESCAPE_QUALIFIED' }, '*');
      }
      window.location.href = '/#map';
    }, 4200);
  }

  function renderScoreResult(result) {
    const card = $('#scorecard');
    card.hidden = false;
    card.classList.toggle('qualified', result.qualifiesForEscape);

    const r2Pct = (result.r2Score * 100).toFixed(2);
    $('#res-r2').textContent = `${r2Pct}%`;
    $('#res-mse').textContent = result.mseScore.toFixed(6);

    const diff = (0.80 - result.r2Score) * 100;
    const banner = $('#qualify-banner');

    if (result.qualifiesForEscape) {
      banner.className = 'qualify-banner success';
      banner.innerHTML = `
        <div style="width: 100%;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
            <strong style="font-size:16px; color:#4ade80; font-family:var(--font-tech); letter-spacing:0.08em;">
              ★ EVALUATION SUCCESS // R² ≥ 0.80 BENCHMARK CRUSHED ★
            </strong>
            <span class="badge badge-green">ESCAPE GATE UNSEALED · +1,000 PTS</span>
          </div>
          <p style="font-size:13px; color:#dcfce7; line-height:1.5; margin:0 0 14px 0;">
            Your model converged with R² = <strong>${r2Pct}%</strong> (MSE: ${result.mseScore.toFixed(6)}), breaking the Core Quarantine!
            Quarantine seals are disengaged and <strong>Extraction Transporter EX-09</strong> is awaiting crew on Tactical Helipad Pad 01.
          </p>
          <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
            <button id="btn-open-helipad-stage" class="escape-btn" style="background:#22c55e; color:#000; font-weight:800;">
              🚁 VIEW EXTRACTION HELIPAD (BOARD EX-09) →
            </button>
            <button id="btn-escape-action" class="copy-btn" style="background:rgba(255,255,255,0.08); padding:10px 16px;">
              PROCEED TO WORLD MAP ↗
            </button>
          </div>
        </div>
      `;

      $('#btn-open-helipad-stage')?.addEventListener('click', () => {
        openExtractionModal('landed');
      });

      $('#btn-escape-action')?.addEventListener('click', () => {
        if (window.opener) {
          window.opener.postMessage({ type: 'PURPLE_ESCAPE_QUALIFIED' }, '*');
          window.opener.focus();
        } else {
          window.location.href = '/#map';
        }
      });
    } else {
      banner.className = 'qualify-banner pending';
      banner.innerHTML = `
        <div>
          <strong style="font-size:14px;color:#fbbf24;">⌁ INSUFFICIENT SIGNAL CORRELATION (NEED +${diff.toFixed(2)}%)</strong>
          <p style="font-size:12px;color:#fef3c7;margin-top:2px;">Threshold is 80.00%. Consider feature ensembling (CatBoost + ElasticNet), timestamp extraction, and medical predictor scaling.</p>
        </div>
      `;
    }
  }

  let isTeamQualified = false;

  function showQualifiedState(info) {
    isTeamQualified = true;
    renderScoreResult(info);
    showHelicopterActiveBanner(true);
    checkQuotaState();
  }

  let cachedSubmissionsCount = 0;

  function checkQuotaState() {
    const btn = $('#btn-submit-eval');
    const exhaustedBanner = $('#quota-exhausted-banner');
    const quotaDisplay = $('#quota-display');
    const usedText = $('#quota-used-text');
    const remText = $('#quota-remaining-text');
    const fileInput = $('#csv-file-input');

    if (usedText) usedText.textContent = cachedSubmissionsCount;
    if (remText) remText.textContent = `${Math.max(0, 10 - cachedSubmissionsCount)} ATTEMPTS REMAINING`;

    if (isTeamQualified || (activeSession && activeSession.ml && activeSession.ml.escapeUnlocked)) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'QUALIFIED FOR EVACUATION — SUBMISSIONS PERMANENTLY LOCKED';
      }
      if (fileInput) fileInput.disabled = true;
      if (exhaustedBanner) {
        exhaustedBanner.hidden = false;
        exhaustedBanner.style.display = 'flex';
        exhaustedBanner.innerHTML = '<strong>MISSION ACCOMPLISHED // PURPLE ZONE CLEARED (+1,000 PTS)</strong><p style="margin:4px 0 0;font-size:12px;">Your model satisfied the survival threshold. Transporter EX-09 is authorized. Per competition protocol, further submissions from your team are permanently locked.</p>';
      }
      if (quotaDisplay) quotaDisplay.classList.add('exhausted');
      return;
    }

    if (cachedSubmissionsCount >= 10) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'SUBMISSION QUOTA REACHED (10/10 ATTEMPTS USED)';
      }
      if (exhaustedBanner) {
        exhaustedBanner.hidden = false;
        exhaustedBanner.style.display = 'flex';
        exhaustedBanner.innerHTML = '<strong>SUBMISSION LIMIT REACHED (10/10 ATTEMPTS)</strong><p style="margin:4px 0 0;font-size:12px;">All 10 allowed model submissions have been used. No further submissions are permitted.</p>';
      }
      if (quotaDisplay) quotaDisplay.classList.add('exhausted');
    } else {
      if (exhaustedBanner) {
        exhaustedBanner.hidden = true;
        exhaustedBanner.style.display = 'none';
      }
      if (quotaDisplay) quotaDisplay.classList.remove('exhausted');
    }
  }

  // ------------------------------------------------------------------------
  // SUBMISSION HISTORY
  // ------------------------------------------------------------------------
  async function loadSubmissions() {
    const tbody = $('#submissions-table-body');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666;">SCANNING ARCHIVE LOGS…</td></tr>';

    try {
      const data = await api('/api/ml/submissions');
      const list = data.submissions || [];
      cachedSubmissionsCount = data.submissionsUsed !== undefined ? data.submissionsUsed : list.length;
      $('#sub-count-badge').textContent = `${list.length}/10`;

      checkQuotaState();

      // Check if team has already qualified in any past submission
      const bestQual = list.find((s) => s.qualifies_for_escape);
      if (bestQual || data.alreadyCompleted) {
        isTeamQualified = true;
        updateGatePill(true);
        showHelicopterActiveBanner(true);
      }
      checkQuotaState();

      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666;">NO SUBMISSIONS RECORDED YET.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map((s, idx) => {
        const dateStr = s.submitted_at ? new Date(s.submitted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--';
        const r2Str = s.r2_score !== null && s.r2_score !== undefined ? `${(s.r2_score * 100).toFixed(2)}%` : 'FAILED';
        const mseStr = s.mse_score !== null && s.mse_score !== undefined ? s.mse_score.toFixed(6) : '—';
        const statusBadge = s.status === 'valid'
          ? '<span class="badge badge-green">VALID</span>'
          : '<span class="badge badge-red">REJECTED</span>';
        const escapeBadge = s.qualifies_for_escape
          ? '<span class="badge badge-green">QUALIFIED 🚀</span>'
          : '<span class="badge badge-purple">PENDING</span>';

        return `
          <tr>
            <td>${list.length - idx}</td>
            <td>${escapeHtml(dateStr)}</td>
            <td>${escapeHtml(s.raw_filename || 'submission.csv')}</td>
            <td style="font-weight:bold;color:${s.qualifies_for_escape ? '#4ade80' : '#bc8cff'}">${escapeHtml(r2Str)}</td>
            <td>${escapeHtml(mseStr)}</td>
            <td>${statusBadge} ${escapeBadge}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#f87171;">ERROR LOADING ARCHIVE: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // ------------------------------------------------------------------------
  // LIVE LEADERBOARD
  // ------------------------------------------------------------------------
  async function loadLeaderboard() {
    const tbody = $('#leaderboard-table-body');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666;">ACQUIRING GLOBAL LEADERBOARD…</td></tr>';

    try {
      const data = await api('/api/leaderboard');
      const board = data.leaderboard || [];

      if (!board.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666;">NO TEAMS RECORDED YET.</td></tr>';
        return;
      }

      const currentTeamId = currentTeam?.id;

      tbody.innerHTML = board.map((team, idx) => {
        const isCurrent = currentTeamId && team.team_id === currentTeamId;
        const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
        const r2Str = team.best_r2_score !== null && team.best_r2_score !== undefined
          ? `${(team.best_r2_score * 100).toFixed(2)}%`
          : '—';
        const escapeBadge = team.escape_unlocked
          ? '<span class="badge badge-green">UNLOCKED ✓</span>'
          : '<span class="badge" style="opacity:0.4;">LOCKED</span>';

        return `
          <tr class="${rankClass} ${isCurrent ? 'current-team' : ''}">
            <td><span class="rank-badge">${idx + 1}</span></td>
            <td>
              <strong>${escapeHtml(team.team_name)}</strong>
              ${isCurrent ? '<small style="color:#bc8cff;margin-left:6px;">(YOUR TEAM)</small>' : ''}
              <div style="font-size:10px;color:#777;">${escapeHtml(team.team_id)}</div>
            </td>
            <td style="font-weight:bold;color:${team.escape_unlocked ? '#4ade80' : '#bc8cff'}">${escapeHtml(r2Str)}</td>
            <td>${escapeBadge}</td>
            <td style="color:#4ade80;font-weight:bold;">${team.total_score || 0} PTS</td>
            <td>${team.total_challenges_solved || 0} SOLVED</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#f87171;">ERROR LOADING LEADERBOARD: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // ------------------------------------------------------------------------
  // DRAG & DROP AND FILE SELECTION SETUP
  // ------------------------------------------------------------------------
  function setupUpload() {
    const dropzone = $('#upload-dropzone');
    const fileInput = $('#file-input');

    if (dropzone && fileInput) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleFileSelect(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          handleFileSelect(e.target.files[0]);
        }
        e.target.value = '';
      });
    }

    // Paste Modal
    $('#btn-paste-csv')?.addEventListener('click', () => {
      const pasteArea = $('#paste-textarea');
      const text = prompt('Paste the complete CSV contents here (must contain header Sanctuary_ID,Survival_Probability and 120 rows):');
      if (text && text.trim()) {
        rawCsvContent = text.trim();
        selectedFileName = 'pasted_submission.csv';
        runPreflightCheck();
      }
    });

    $('#btn-submit-eval')?.addEventListener('click', submitEvaluation);
  }

  // ------------------------------------------------------------------------
  // COPY STARTER CODE
  // ------------------------------------------------------------------------
  function setupCopyBtn() {
    $('#btn-copy-code')?.addEventListener('click', () => {
      const code = $('#python-starter-code')?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        toast('PYTHON STARTER CODE COPIED TO CLIPBOARD', 'success');
      });
    });
  }

  // ------------------------------------------------------------------------
  // HELICOPTER & HELIPAD MODAL CONTROLS
  // ------------------------------------------------------------------------
  function setupHelicopterModal() {
    $('#btn-close-stage')?.addEventListener('click', closeExtractionModal);
    $('#btn-board-transporter')?.addEventListener('click', handleBoardTransporter);
    $('#btn-view-helipad')?.addEventListener('click', () => openExtractionModal('landed'));
  }

  // ------------------------------------------------------------------------
  // INITIALIZE
  // ------------------------------------------------------------------------
  function init() {
    setupTabs();
    setupUpload();
    setupHelicopterModal();
    setupCopyBtn();
    checkQuotaState();
    initBootstrap();

    // Auto-refresh leaderboard periodically
    setInterval(() => {
      if ($('#tab-leaderboard')?.classList.contains('active')) {
        loadLeaderboard();
      }
    }, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
