/*
 * Enhanced Boston Sports Tracker script with fallback support.
 *
 * This client-side helper fetches sports data from a Netlify function
 * (`/.netlify/functions/sports`) and, if that request fails or
 * returns non-OK, falls back to a static JSON file (`/assets/sports.json`).
 * The data is then rendered into a collapsible card.
 */

async function fetchSportsData() {
  const urls = ['/.netlify/functions/sports', '/assets/sports.json'];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      console.error(err);
    }
  }
  return null;
}

function renderSportsCard(data) {
  const container = document.getElementById('sports-tracker');
  if (!container || !data || !Array.isArray(data.teams)) return;

  // Build list of teams. We support both old and new data shapes.
  const list = document.createElement('ul');
  list.classList.add('sports-list');
  data.teams.forEach((team) => {
    const li = document.createElement('li');
    li.classList.add('sports-item');
    const name = team.team || team.name || '';
    const record = team.record || team.teamRecord || '';
    const next = team.next || team.nextGame || '';
    li.innerHTML = `
      <span class="team-name">${name}</span>
      <span class="team-record">${record}</span>
      <span class="team-next">${next}</span>
    `;
    list.appendChild(li);
  });

  // Insert list into content area.
  const content = container.querySelector('.sports-content');
  if (content) {
    content.innerHTML = '';
    content.appendChild(list);
  }

  // Update the timestamp, if present.
  const updatedElem = container.querySelector('.sports-updated');
  if (updatedElem && data.updatedAt) {
    const date = new Date(data.updatedAt);
    updatedElem.textContent = `Updated ${date.toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
  }
}

function initSportsTracker() {
  const container = document.getElementById('sports-tracker');
  if (!container) return;

  // Set up collapsible toggle.
  const toggle = container.querySelector('.sports-toggle');
  const content = container.querySelector('.sports-content');
  if (toggle && content) {
    toggle.addEventListener('click', () => {
      content.classList.toggle('collapsed');
    });
  }

  // Fetch and render data.
  fetchSportsData().then((data) => {
    if (data) renderSportsCard(data);
  });
}

// Initialize on DOM ready.
if (document.readyState !== 'loading') {
  initSportsTracker();
} else {
  document.addEventListener('DOMContentLoaded', initSportsTracker);
}
