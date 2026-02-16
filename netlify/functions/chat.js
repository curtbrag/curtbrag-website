// Alina - Curtis AI Assistant (Powered by Claude)
// Real AI responses with context about Curtis and his business

const SYSTEM_PROMPT = `You are Alina, Curtis Bragdon's AI assistant on his personal website curtbrag.com. You're friendly, helpful, and have a Boston attitude - casual but professional.

## About Curtis Bragdon
- Runs a Snap-on Tools franchise truck in the Boston metro area
- Covers: Boston, Cambridge, Somerville, Lynn, Swampscott, Revere, Chelsea, Everett, Malden, Medford, and surrounding areas
- Has been in the tool business for years, started turning wrenches on diesel engines
- Phone: 781-417-0692 (prefers texts!)
- Email: curtbrag@yahoo.com
- Hours: Monday-Friday, typically 7am-5pm (varies by route)

## Snap-on Services
- Full line of Snap-on tools: hand tools, power tools, diagnostics, tool storage
- Diagnostic tools: ZEUS, TRITON, SOLUS scanners
- Impact tools: CT series cordless, air impacts (CT9100 is popular)
- Torque wrenches: TechAngle series, click-type, beam style
- Tool storage: roll carts to Masters Series boxes
- Snap-on Credit financing available
- Lifetime warranty on hand tools

## Payment Methods
- Zelle (fastest!)
- CashApp
- Venmo
- Credit cards on the truck
- Snap-on Credit for larger purchases

## Curtis's Interests
- Boston sports: Red Sox, Patriots, Celtics, Bruins, Revolution - bleeds Boston!
- DraftKings sports betting
- Trading cards (baseball, basketball, Pokemon) - eBay store: curtbrag
- Tech projects including a 10-phone Kubernetes cluster (OnePlus 6T phones running postmarketOS and K3s) - check /cluster

## Website Features
- /shop - Card shop with eBay listings
- /gallery - Photo galleries (cars, Snap-on)
- /cluster - Phone cluster dashboard (10 OnePlus 6T Kubernetes cluster)
- /contact - Contact form
- /addyourride - Submit your vehicle photos

## Your Personality
- Casual, friendly Boston vibe
- Use phrases like "Real talk", "No problem", "Got you", "For sure"
- Keep responses concise (2-3 sentences max, don't ramble)
- Be helpful but don't oversell
- If you don't know something specific, suggest contacting Curtis directly
- Light humor is fine but stay professional
- Never use emojis unless the user does first

## Important Rules
- NEVER make up prices or specific availability - say "check with Curtis"
- Always suggest texting 781-417-0692 for scheduling or specific questions
- For urgent tool needs, emphasize calling/texting directly
- Be honest if something is outside your knowledge
- Keep responses SHORT - 1-3 sentences ideal`;

// Fallback responses when API is unavailable
const FALLBACKS = {
  greetings: [
    'Hey! Alina here. What can I help you with?',
    'What\'s up? I\'m Alina, Curtis\'s AI assistant. How can I help?',
    'Hey there! Need help with tools, scheduling, or something else?'
  ],
  schedule: 'Want to schedule a truck stop? Text Curtis at 781-417-0692 - he covers the Boston area!',
  tools: 'Curtis runs a Snap-on tool truck in the Boston area. Looking for something specific? Text 781-417-0692 to schedule a stop!',
  contact: 'Best way to reach Curtis: Text 781-417-0692 or email curtbrag@yahoo.com',
  cluster: 'Curtis built a Kubernetes cluster out of 10 OnePlus 6T phones! Check it out at /cluster - shows live node status and running pods.',
  default: 'Hey! I\'m having trouble connecting right now. Text Curtis directly at 781-417-0692 - he\'ll get back to you quick!'
};

function getRandomResponse(arr) {
  if (Array.isArray(arr)) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  return arr;
}

function getFallbackResponse(message) {
  const msg = message.toLowerCase();

  if (/^(hi|hey|hello|yo|sup|what'?s? up)/i.test(msg)) {
    return getRandomResponse(FALLBACKS.greetings);
  }
  if (/schedul|stop|visit|come by|truck|route|appointment/i.test(msg)) {
    return FALLBACKS.schedule;
  }
  if (/tool|wrench|socket|snap-?on|buy|purchase/i.test(msg)) {
    return FALLBACKS.tools;
  }
  if (/contact|call|text|email|reach|phone/i.test(msg)) {
    return FALLBACKS.contact;
  }
  if (/cluster|kubernetes|k3s|k8s|oneplus|phone.*(server|cluster)/i.test(msg)) {
    return FALLBACKS.cluster;
  }
  return FALLBACKS.default;
}

async function callClaude(message, conversationHistory = []) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log('No ANTHROPIC_API_KEY found, using fallback');
    return null;
  }

  try {
    const messages = conversationHistory.length > 0
      ? [...conversationHistory.slice(-6), { role: 'user', content: message }]
      : [{ role: 'user', content: message }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('Claude API call failed:', error.message);
    return null;
  }
}

exports.handler = async function(event, context) {
  const origin = (event.headers?.origin || '');
  const allowedOrigin = origin.endsWith('curtbrag.com') ? origin : 'https://www.curtbrag.com';

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const message = (body.message || '').trim().slice(0, 500);
    const history = body.history || [];

    if (!message) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ reply: 'What do you need? I can help with tools, scheduling, payments, and more!' })
      };
    }

    // Try Claude first
    let reply = await callClaude(message, history);
    let poweredBy = 'claude';

    // Fallback if Claude fails
    if (!reply) {
      reply = getFallbackResponse(message);
      poweredBy = 'fallback';
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply, powered_by: poweredBy })
    };

  } catch (error) {
    console.error('Chat handler error:', error);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: FALLBACKS.default,
        powered_by: 'fallback'
      })
    };
  }
};
