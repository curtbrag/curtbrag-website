/* scoreboard.js ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â wires Celtics + SNA panels using Netlify functions */

const CELTICS_URL = "/.netlify/functions/celtics";
const SNA_URL = "/.netlify/functions/sna";


function cbTime(d=new Date()){
  try{ return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
  catch(_){ return d.toTimeString().slice(0,5); }
}
function $(q, root=document){ return root.querySelector(q); }
function $all(q, root=document){ return [...root.querySelectorAll(q)]; }

function upsertContainer(headingText, id, label) {
  let heading = $all("h1,h2,h3,h4,h5,h6,div,section,p,span").find(
    el => (el.textContent || "").trim().toLowerCase() === headingText.toLowerCase()
  );
  let host;
  if (heading) {
    host = heading.nextElementSibling;
    if (!host || !/error loading/i.test(host.textContent || "")) {
      host = document.createElement("div");
      heading.insertAdjacentElement("afterend", host);
    } else {
      host.innerHTML = "";
    }
  } else {
    host = document.createElement("div");
    document.body.appendChild(host);
  }
  host.id = id;
  host.className = "cb-widget";
  host.innerHTML = `
    <div class="cb-card">
      <div class="cb-label">${label}</div>
      <div class="cb-value" id="${id}-value">LoadingÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦</div>
      <div class="cb-meta"  id="${id}-meta"></div>
    </div>
  `;
  return host;
}

function styleOnce(){ /* moved to site.css */ }
    .cb-card { background: rgba(0,0,0,.55); border:1px solid rgba(255,255,255,.06);
               border-radius:12px; padding:12px 14px; color:#eee; font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
    .cb-label { font-weight:600; font-size:14px; opacity:.9; letter-spacing:.3px; }
    .cb-value { font-size:20px; font-weight:700; margin-top:4px; }
    .cb-meta  { font-size:12px; opacity:.8; margin-top:2px; }
    .cb-up { color:#63ffa3; } .cb-down { color:#ff6b6b; }
  `;
  document.head.appendChild(css);
}

async function fetchJSON(url, timeoutMs=8000) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function renderCeltics() {
  const box = upsertContainer("Boston Sports Tracker", "cb-celtics", "Boston Sports Tracker");
  const val = document.getElementById("cb-celtics-value");
  const meta = document.getElementById("cb-celtics-meta");
  try {
    const j = await fetchJSON(CELTICS_URL);
    if (j?.game) {
      const g = j.game;
      val.textContent = `${g.visitorTeam} ${g.visitorScore}  @  ${g.homeTeam} ${g.homeScore}`;
      meta.textContent = (g.status || "") + (g.status ? " ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ " : "") + `Updated ${cbTime()}`;
    } else if (j?.result) {
      val.textContent = j.result; meta.textContent = `Updated ${cbTime()}`;
    } else {
      throw new Error("No game data");
    }
  } catch (e) {
    val.textContent = "Unable to load score";
    meta.textContent = String(e.message || e);
  }
}

async function renderSna() {
  const box = upsertContainer("Snap-on Stock Price", "cb-sna", "Snap-on (SNA)");
  const val = document.getElementById("cb-sna-value");
  const meta = document.getElementById("cb-sna-meta");
  try {
    const j = await fetchJSON(SNA_URL);
    const q  = Number(j?.quote);
    const ch = (Number.isFinite(j?.change) ? j.change : null);
    const pct= (Number.isFinite(j?.percent) ? j.percent : null);
    if (!Number.isFinite(q)) throw new Error(j?.error || "Invalid quote");
    const arrow = (ch==null ? "" : (ch >= 0 ? "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“Ãƒâ€šÃ‚Â²" : "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“Ãƒâ€šÃ‚Â¼"));
    const cls   = (ch==null ? "" : (ch >= 0 ? "cb-up" : "cb-down"));
    val.innerHTML = `$${q.toFixed(2)} <span class="cb-change ${cls}">${arrow} ${ch!=null?ch.toFixed(2):"ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â"}${pct!=null?` (${pct.toFixed(2)}%)`:""}</span>`;
    meta.textContent = `Updated ${cbTime()}`;
  } catch (e) {
    val.textContent = "Unable to load price";
    meta.textContent = String(e.message || e);
  }
}

(function init(){
  styleOnce();
  renderCeltics();
  renderSna();
  setInterval(renderSna, 60_000);
})();

