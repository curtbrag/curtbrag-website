/*
 * Live services server for Curt Brag's website.
 *
 * Provides two endpoints:
 *   GET /nba/celtics  – returns today's Celtics game (if any).
 *   GET /stock/:symbol – returns current stock price for the given symbol.
 */
import express from 'express';
import axios from 'axios';

const app = express();

async function fetchCelticsGame() {
  const today = new Date().toISOString().slice(0, 10);
  const url = `https://www.balldontlie.io/v1/games?team_ids[]=2&dates[]=${today}&per_page=1`;
  const { data } = await axios.get(url);
  if (data && data.data && data.data.length) {
    const game = data.data[0];
    return {
      date: game.date,
      homeTeam: game.home_team.full_name,
      homeScore: game.home_team_score,
      visitorTeam: game.visitor_team.full_name,
      visitorScore: game.visitor_team_score,
      status: game.status,
    };
  }
  return null;
}

app.get('/nba/celtics', async (req, res) => {
  try {
    const game = await fetchCelticsGame();
    if (game) {
      res.json({ success: true, game });
    } else {
      res.json({ success: false, message: 'No Celtics game today.' });
    }
  } catch (err) {
    console.error('Error fetching Celtics game:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch Celtics score' });
  }
});

async function fetchStockQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const { data } = await axios.get(url);
  const quote = data.quoteResponse.result[0];
  return {
    symbol: quote.symbol,
    name: quote.shortName || quote.longName || symbol,
    price: quote.regularMarketPrice,
    change: quote.regularMarketChange,
    percentChange: quote.regularMarketChangePercent,
    currency: quote.currency,
    time: quote.regularMarketTime ? new Date(quote.regularMarketTime * 1000).toISOString() : null,
  };
}

app.get('/stock/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const quote = await fetchStockQuote(symbol);
    res.json({ success: true, quote });
  } catch (err) {
    console.error('Error fetching stock quote:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch stock price' });
  }
});

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Live services server listening on port ' + PORT);
});
