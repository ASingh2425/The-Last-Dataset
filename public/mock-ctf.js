(() => {
  'use strict';
  const body = document.body;
  const ctfId = body.dataset.ctfId;
  const devEnabled = body.dataset.devEnabled === 'true';
  const status = document.getElementById('mock-status');
  document.getElementById('mock-back')?.addEventListener('click', () => {
    parent.postMessage({ type: 'TLD_CTF_RETURN_TO_MAP' }, location.origin);
  });
  document.getElementById('mock-solve')?.addEventListener('click', async (event) => {
    if (!devEnabled) return;
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'VERIFYING WITH HUB…';
    try {
      const response = await fetch('/api/dev/solve', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ ctfId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || 'Simulation denied.');
      status.textContent = result.newlySolved ? 'DATA RECOVERED · SERVER PROGRESS UPDATED.' : 'THIS DATASET WAS ALREADY RECOVERED.';
      status.style.color = '#afd6ac';
      button.textContent = 'DATA RECOVERED';
      parent.postMessage({ type: 'TLD_CTF_SOLVED' }, location.origin);
    } catch (error) {
      status.textContent = error.message; status.style.color = '#d99a90';
      button.disabled = false; button.textContent = 'RETRY SIMULATION';
    }
  });
})();
