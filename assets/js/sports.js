/*
 * Client-side helper to display sports standings in a collapsible card.
 *
 * This script fetches a JSON payload from the Netlify function at
 * `/.netlify/functions/sports` and renders a list of teams with their
 * records and next games. The card is collapsible on small screens: the
 * header doubles as a toggle to show or hide the content on mobile.
 */

async function fetchSportsData() {
  try {
    const res = await fetch('/.netlify/functions/sports');
    if (!res.ok) throw new Error('Failed to fetch sports data');
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

function renderSportsCard(data) {
  const container = document.getElementById('sports-tracker');
  if (!container || !data || !Array.isArray(data.teams)) return;

  const list = document.createElement('ul');
  list.classList.add('sports-list');
  data.teams.forEach((team) => {
    const li = document.createElement('li');
    li.classList.add('sports-item');
    li.innerHTML = `
      <span class="team-name">${team.name}</span>
      <span class="team-record">${team.record}</span>
      <span class="team-next">${team.nextGame}</span>
    `;
    list.appendChild(li);
  });
  const content = container.querySelector('.sports-content');
  if (content) {
    content.innerHTML = '';
    content.appendChild(list);
  }
  // update timestamp, if present
  const updatedElem = container.querySelector('.sports-updated');
  if (updatedElem && data.updatedAt) {
    const date = new Date(data.updatedAt);
    updatedElem.textContent = `Updated ${date.toLocaleString()}`;
  }
}

function initSportsTracker() {
  const container = document.getElementById('sports-tracker');
  if (!container) return;
  const toggle = container.querySelector('.sports-toggle');
  const content = container.querySelector('.sports-content');
  if (toggle) {
    toggle.addEventListener('click', () => {
      content.classList.toggle('collapsed');
    });
  }
  fetchSportsData().then((data) => {
    if (data) renderSportsCard(data);
  });
}

// Automatically initialize once the DOM is loaded.
if (document.readyState !== 'loading') {
  initSportsTracker();
} else {
  document.addEventListener('DOMContentLoaded', initSportsTracker);
}
