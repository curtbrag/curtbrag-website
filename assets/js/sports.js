// Boston Sports Tracker logic with Netlify function + JSON fallback
async function fetchSportsData() {
 const urls = ['/assets/sports.json', '/.netlify/functions/sports'];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (res.ok) return await res.json();
    } catch (err) {
      console.error('Fetch failed for', url, err);
    }
  }
  return null;
}

function renderSportsCard(data) {
  const root = document.getElementById('sports-tracker');
  if (!root || !data || !Array.isArray(data.teams)) return;
  const content = root.querySelector('.sports-content');
  if (!content) return;

  const ul = document.createElement('ul');
  ul.className = 'sports-list';

  data.teams.forEach(t => {
    const name = t.name || t.team || '';
    const record = t.record || t.teamRecord || '';
    const next = t.nextGame || t.next || '';
    const li = document.createElement('li');
    li.className = 'sports-item';
    li.innerHTML = `
      <span class="team-name">${name}</span>
      <span class="team-record">${record}</span>
      <span class="team-next">${next}</span>
    `;
    ul.appendChild(li);
  });

  content.innerHTML = '';
  content.appendChild(ul);

  const updated = root.querySelector('.sports-updated');
  if (updated && data.updatedAt) {
    const d = new Date(data.updatedAt);
    updated.textContent = `Updated ${d.toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
  }
}

function initSportsTracker() {
  const root = document.getElementById('sports-tracker');
  if (!root) return;

  const toggle = root.querySelector('.sports-toggle');
  const content = root.querySelector('.sports-content');
  if (toggle && content) {
    toggle.addEventListener('click', () => content.classList.toggle('collapsed'));
  }

  fetchSportsData().then(data => { if (data) renderSportsCard(data); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSportsTracker);
} else {
  initSportsTracker();
}
