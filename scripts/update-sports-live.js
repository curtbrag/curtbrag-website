const fs = require('fs/promises');

const fetchJson = async (url) => {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
};

async function getCeltics() {
  try {
    const data = await fetchJson('https://www.balldontlie.io/api/v1/games?team_ids[]=2&per_page=1');
    const game = data.data[0];
    const home = game.home_team.full_name;
    const away = game.visitor_team.full_name;
    const record = `${home} ${game.home_team_score} - ${away} ${game.visitor_team_score}`;
    const date = game.date.split('T')[0];
    return { name: 'Boston Celtics', record, nextGame: `Last game on ${date}` };
  } catch (err) {
    console.error('Celtics fetch error', err);
    return { name: 'Boston Celtics', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getBruins() {
  try {
    const data = await fetchJson('https://statsapi.web.nhl.com/api/v1/teams/6?expand=team.schedule.previous&expand=team.schedule.next');
    const team = data.teams[0];
    const prevGame = team.previousGameSchedule.dates[0].games[0];
    const nextGame = team.nextGameSchedule?.dates?.[0]?.games?.[0];
    const record = `${prevGame.teams.away.team.name} ${prevGame.teams.away.score} - ${prevGame.teams.home.team.name} ${prevGame.teams.home.score}`;
    const nextGameStr = nextGame ? `${nextGame.teams.away.team.name} at ${nextGame.teams.home.team.name} on ${nextGame.gameDate}` : 'TBA';
    return { name: 'Boston Bruins', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Bruins fetch error', err);
    return { name: 'Boston Bruins', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getRedSox() {
  try {
    const data = await fetchJson('https://statsapi.mlb.com/api/v1/teams/111?expand=team.schedule.previous,team.schedule.next');
    const team = data.teams[0];
    const prevGame = team.previousGameSchedule.dates[0].games[0];
    const nextGame = team.nextGameSchedule?.dates?.[0]?.games?.[0];
    const record = `${prevGame.teams.away.team.name} ${prevGame.teams.away.score} - ${prevGame.teams.home.team.name} ${prevGame.teams.home.score}`;
    const nextGameStr = nextGame ? `${nextGame.teams.away.team.name} at ${nextGame.teams.home.team.name} on ${nextGame.gameDate}` : 'TBA';
    return { name: 'Boston Red Sox', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Red Sox fetch error', err);
    return { name: 'Boston Red Sox', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getPatriots() {
  try {
    const data = await fetchJson('https://site.api.espn.com/apis/v2/sports/football/nfl/teams/17?add=schedule');
    const schedule = data.team.schedule.items;
    const pastGames = schedule.filter(g => (g.status === 'STATUS_FINAL') || (g.status.type?.state === 'post'));
    const lastGame = pastGames[pastGames.length - 1];
    const upcoming = schedule.find(g => (g.status.type?.state === 'pre') || (g.status === 'STATUS_SCHEDULED'));
    const record = lastGame ? `${lastGame.competitions[0].competitors[0].team.displayName} ${lastGame.competitions[0].competitors[0].score} - ${lastGame.competitions[0].competitors[1].team.displayName} ${lastGame.competitions[0].competitors[1].score}` : 'N/A';
    const nextGameStr = upcoming ? `${upcoming.competitions[0].competitors[0].team.displayName} at ${upcoming.competitions[0].competitors[1].team.displayName} on ${upcoming.date}` : 'TBA';
    return { name: 'New England Patriots', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Patriots fetch error', err);
    return { name: 'New England Patriots', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getRevolution() {
  try {
    const data = await fetchJson('https://site.api.espn.com/apis/v2/sports/soccer/usa.1/teams/184?add=schedule');
    const schedule = data.team.schedule.items;
    const pastGames = schedule.filter(g => (g.status === 'STATUS_FINAL') || (g.status.type?.state === 'post'));
    const lastGame = pastGames[pastGames.length - 1];
const fs = require('fs/promises');

const fetchJson = async (url) => {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
};

async function getCeltics() {
  try {
    const data = await fetchJson('https://www.balldontlie.io/api/v1/games?team_ids[]=2&per_page=1');
    const game = data.data[0];
    const home = game.home_team.full_name;
    const away = game.visitor_team.full_name;
    const record = `${home} ${game.home_team_score} - ${away} ${game.visitor_team_score}`;
    const date = game.date.split('T')[0];
    return { name: 'Boston Celtics', record, nextGame: `Last game on ${date}` };
  } catch (err) {
    console.error('Celtics fetch error', err);
    return { name: 'Boston Celtics', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getBruins() {
  try {
    const data = await fetchJson('https://statsapi.web.nhl.com/api/v1/teams/6?expand=team.schedule.previous&expand=team.schedule.next');
    const team = data.teams[0];
    const prevGame = team.previousGameSchedule.dates[0].games[0];
    const nextGame = team.nextGameSchedule?.dates?.[0]?.games?.[0];
    const record = `${prevGame.teams.away.team.name} ${prevGame.teams.away.score} - ${prevGame.teams.home.team.name} ${prevGame.teams.home.score}`;
    const nextGameStr = nextGame ? `${nextGame.teams.away.team.name} at ${nextGame.teams.home.team.name} on ${nextGame.gameDate}` : 'TBA';
    return { name: 'Boston Bruins', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Bruins fetch error', err);
    return { name: 'Boston Bruins', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getRedSox() {
  try {
    const data = await fetchJson('https://statsapi.mlb.com/api/v1/teams/111?expand=team.schedule.previous,team.schedule.next');
    const team = data.teams[0];
    const prevGame = team.previousGameSchedule.dates[0].games[0];
    const nextGame = team.nextGameSchedule?.dates?.[0]?.games?.[0];
    const record = `${prevGame.teams.away.team.name} ${prevGame.teams.away.score} - ${prevGame.teams.home.team.name} ${prevGame.teams.home.score}`;
    const nextGameStr = nextGame ? `${nextGame.teams.away.team.name} at ${nextGame.teams.home.team.name} on ${nextGame.gameDate}` : 'TBA';
    return { name: 'Boston Red Sox', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Red Sox fetch error', err);
    return { name: 'Boston Red Sox', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getPatriots() {
  try {
    const data = await fetchJson('https://site.api.espn.com/apis/v2/sports/football/nfl/teams/17?add=schedule');
    const schedule = data.team.schedule.items;
    const pastGames = schedule.filter(g => (g.status === 'STATUS_FINAL') || (g.status.type?.state === 'post'));
    const lastGame = pastGames[pastGames.length - 1];
    const upcoming = schedule.find(g => (g.status.type?.state === 'pre') || (g.status === 'STATUS_SCHEDULED'));
    const record = lastGame ? `${lastGame.competitions[0].competitors[0].team.displayName} ${lastGame.competitions[0].competitors[0].score} - ${lastGame.competitions[0].competitors[1].team.displayName} ${lastGame.competitions[0].competitors[1].score}` : 'N/A';
    const nextGameStr = upcoming ? `${upcoming.competitions[0].competitors[0].team.displayName} at ${upcoming.competitions[0].competitors[1].team.displayName} on ${upcoming.date}` : 'TBA';
    return { name: 'New England Patriots', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Patriots fetch error', err);
    return { name: 'New England Patriots', record: 'N/A', nextGame: 'N/A' };
  }
}

async function getRevolution() {
  try {
    const data = await fetchJson('https://site.api.espn.com/apis/v2/sports/soccer/usa.1/teams/184?add=schedule');
    const schedule = data.team.schedule.items;
    const pastGames = schedule.filter(g => (g.status === 'STATUS_FINAL') || (g.status.type?.state === 'post'));
    const lastGame = pastGames[pastGames.length - 1];
    const upcoming = schedule.find(g => (g.status.type?.state === 'pre') || (g.status === 'STATUS_SCHEDULED'));
    const record = lastGame ? `${lastGame.competitions[0].competitors[0].team.displayName} ${lastGame.competitions[0].competitors[0].score} - ${lastGame.competitions[0].competitors[1].team.displayName} ${lastGame.competitions[0].competitors[1].score}` : 'N/A';
    const nextGameStr = upcoming ? `${upcoming.competitions[0].competitors[0].team.displayName} at ${upcoming.competitions[0].competitors[1].team.displayName} on ${upcoming.date}` : 'TBA';
    return { name: 'New England Revolution', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Revolution fetch error', err);
    return { name: 'New England Revolution', record: 'N/A', nextGame: 'N/A' };
  }
}

async function main() {
  const teams = await Promise.all([
    getCeltics(),
    getBruins(),
    getPatriots(),
    getRedSox(),
    getRevolution()
  ]);
  const json = {
    updatedAt: new Date().toISOString(),
    teams
  };
  await fs.writeFile('./assets/sports.json', JSON.stringify(json, null, 2));
  console.log('Updated sports.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});    const upcoming = schedule.find(g => (g.status.type?.state === 'pre') || (g.status === 'STATUS_SCHEDULED'));
    const record = lastGame ? `${lastGame.competitions[0].competitors[0].team.displayName} ${lastGame.competitions[0].competitors[0].score} - ${lastGame.competitions[0].competitors[1].team.displayName} ${lastGame.competitions[0].competitors[1].score}` : 'N/A';
    const nextGameStr = upcoming ? `${upcoming.competitions[0].competitors[0].team.displayName} at ${upcoming.competitions[0].competitors[1].team.displayName} on ${upcoming.date}` : 'TBA';
    return { name: 'New England Revolution', record, nextGame: nextGameStr };
  } catch (err) {
    console.error('Revolution fetch error', err);
    return { name: 'New England Revolution', record: 'N/A', nextGame: 'N/A' };
  }
}

async function main() {
  const teams = await Promise.all([
    getCeltics(),
    getBruins(),
    getPatriots(),
    getRedSox(),
    getRevolution()
  ]);
  const json = {
    updatedAt: new Date().toISOString(),
    teams
  };
  await fs.writeFile('./assets/sports.json', JSON.stringify(json, null, 2));
  console.log('Updated sports.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
