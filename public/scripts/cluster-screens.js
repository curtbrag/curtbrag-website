const PHONE_UNITS = ['phone173', 'phone174', 'phone176', 'phone177', 'phone191', 'phone195', 'phone253', 'phone254'];

export function connectedPhoneScreens(bridge, now = Date.now()) {
  const seen = Date.parse(bridge?.last_seen_at);
  const snapshot = bridge?.phone_controller;
  const checked = Date.parse(snapshot?.checked_at);
  if (bridge?.alive !== true || !Number.isFinite(seen) || now - seen < -30000 || now - seen > 60000 ||
      snapshot?.schema !== 1 || snapshot.server_state !== 'available' || !Number.isFinite(checked) ||
      now - checked < -30000 || now - checked > 90000 || !Array.isArray(snapshot.devices) || snapshot.devices.length !== PHONE_UNITS.length) return null;
  const unique = new Set();
  for (const device of snapshot.devices) {
    if (!PHONE_UNITS.includes(device?.unit) || unique.has(device.unit) || !['connected', 'unauthorized', 'disconnected', 'unknown'].includes(device.state)) return null;
    unique.add(device.unit);
  }
  return { units: snapshot.devices.filter(device => device.state === 'connected').map(device => device.unit),
    expiresAt: Math.min(seen + 60000, checked + 90000), checkedAt: checked };
}

if (typeof document !== 'undefined') {
  const status = document.getElementById('screen-launch-status');
  const checkStatus = document.getElementById('phone-screen-status');
  const checkButton = document.getElementById('check-phone-screens');
  let snapshot = null;
  let expiryTimer;

  function renderPhones() {
    const fresh = snapshot && Date.now() < snapshot.expiresAt;
    document.querySelectorAll('[data-phone-viewer]').forEach(button => {
      const available = fresh && snapshot.units.includes(button.dataset.phoneViewer);
      button.disabled = !available;
      button.textContent = available ? 'Open viewer ↗' : 'Screen connection needed';
    });
  }

  document.querySelectorAll('[data-viewer-name]').forEach(control => {
    control.addEventListener('click', event => {
      if (control.dataset.phoneViewer) {
        if (!snapshot || Date.now() >= snapshot.expiresAt || !snapshot.units.includes(control.dataset.phoneViewer)) {
          event.preventDefault(); renderPhones(); return;
        }
        window.location.assign('curtcluster-screen://open/' + control.dataset.phoneViewer);
      }
      if (status) status.textContent = `Requested the ${control.dataset.viewerName} viewer. Check its window on this PC for the live picture or connection result.`;
    });
  });

  async function checkPhones() {
    snapshot = null; clearTimeout(expiryTimer); renderPhones();
    checkButton.disabled = true;
    checkStatus.textContent = 'Checking the PC’s phone screen connections…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const password = sessionStorage.getItem('cp_password');
      if (!password) throw Error('Sign in through the cluster dashboard to check phone connections.');
      const response = await fetch('/.netlify/functions/cluster-api?action=bridge-status', {
        headers: { Authorization: 'Bearer ' + password }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw Error('Phone screen status is unavailable. Refresh your dashboard session and try again.');
      snapshot = connectedPhoneScreens(await response.json());
      if (!snapshot) throw Error('Fresh phone screen status is unavailable. Check the PC bridge in the dashboard.');
      renderPhones();
      checkStatus.textContent = `${snapshot.units.length}/8 phone screen connections detected. The viewer checks each connection again before opening.`;
      expiryTimer = setTimeout(() => { snapshot = null; renderPhones(); checkStatus.textContent = 'Phone screen status expired. Check connections again.'; }, Math.max(1, snapshot.expiresAt - Date.now()));
    } catch (error) {
      checkStatus.textContent = controller.signal.aborted ? 'Phone screen check timed out. Try again.' : error.message;
    } finally { clearTimeout(timer); checkButton.disabled = false; }
  }
  checkButton?.addEventListener('click', checkPhones);
  if (checkButton) checkPhones();
}
