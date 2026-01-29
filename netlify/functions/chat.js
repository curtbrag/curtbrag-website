// Alina - Curtis AI Assistant
// Smart rule-based responses for common questions

const RESPONSES = {
  // Greetings
  greetings: [
    'Hey! Alina here. What can I help you with?',
    'What\'s up? I\'m Alina, Curtis\'s AI assistant. How can I help?',
    'Hey there! Need help with tools, scheduling, or something else?'
  ],

  // Schedule/Stop
  schedule: 'Want to schedule a truck stop? Click the "Schedule Stop" button above or text Curtis directly at 781-417-0692. He covers the Boston area!',

  // Tools/Products
  tools: 'Curtis runs a Snap-on tool truck in the Boston area. Looking for something specific? Use the "Request a Tool" button or ask me what you need!',

  // Warranty
  warranty: 'Need warranty help or an RA? Click "Warranty/RA Help" above or contact Curtis directly. Snap-on has great lifetime warranties on hand tools!',

  // Payment options
  payment: 'Curtis accepts multiple payment methods:\n• Zelle\n• CashApp\n• Venmo\n• Credit cards on the truck\nClick the payment buttons above to send money directly!',

  // Promos/Deals
  promos: 'For current promos and deals, check with Curtis directly! New flyers come out regularly with hot deals. Schedule a stop to see what\'s on special this week.',

  // DraftKings
  draftkings: 'Curtis is into DraftKings! Want to talk sports betting or need a referral? Hit him up on the socials or click the DraftKings button above.',

  // Cards/Trading
  cards: 'Check out the Card Shop for Curtis\'s eBay listings, or browse the Card Gallery to see the collection! Baseball, basketball, Pokemon and more.',

  // Contact
  contact: 'Best ways to reach Curtis:\n• Call: 781-417-0692\n• Text: Same number\n• Email: curtbrag@yahoo.com\nOr use the social links above!',

  // Location/Area
  location: 'Curtis covers the Boston metro area with his Snap-on truck. Cities include Boston, Cambridge, Somerville, Lynn, Swampscott, and surrounding areas. Schedule a stop!',

  // Hours
  hours: 'The truck runs Monday-Friday, typical business hours. Exact schedule varies by route. Best bet is to schedule a stop or text Curtis to confirm!',

  // Default
  default: 'I\'m not sure about that one. For specific questions, text Curtis at 781-417-0692 or use the contact buttons above. I can help with:\n• Scheduling stops\n• Tool requests\n• Warranty help\n• Payment options\n• Promos & deals'
};

function getRandomResponse(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function findResponse(message) {
  const msg = message.toLowerCase();

  // Greetings
  if (/^(hi|hey|hello|yo|sup|what'?s? up|howdy)/i.test(msg)) {
    return getRandomResponse(RESPONSES.greetings);
  }

  // Schedule/Stop
  if (/schedul|stop|visit|come by|truck stop|route/i.test(msg)) {
    return RESPONSES.schedule;
  }

  // Tools
  if (/tool|wrench|socket|ratchet|screw|snap-?on|product|buy|purchase|order/i.test(msg)) {
    return RESPONSES.tools;
  }

  // Warranty
  if (/warrant|ra |return|broke|broken|replace|repair|fix/i.test(msg)) {
    return RESPONSES.warranty;
  }

  // Payment
  if (/pay|zelle|cash ?app|venmo|money|credit|card|how.*(pay|send)/i.test(msg)) {
    return RESPONSES.payment;
  }

  // Promos
  if (/promo|deal|sale|discount|special|flyer|hot buy/i.test(msg)) {
    return RESPONSES.promos;
  }

  // DraftKings/Sports betting
  if (/draft ?king|bet|gambl|odds|sport.*(bet|pick)/i.test(msg)) {
    return RESPONSES.draftkings;
  }

  // Cards
  if (/card|trading|pokemon|baseball|basketball|ebay|collect/i.test(msg)) {
    return RESPONSES.cards;
  }

  // Contact
  if (/contact|reach|phone|email|number|call|text/i.test(msg)) {
    return RESPONSES.contact;
  }

  // Location
  if (/where|location|area|city|town|cover|boston|cambridge/i.test(msg)) {
    return RESPONSES.location;
  }

  // Hours
  if (/hour|when|time|open|close|available/i.test(msg)) {
    return RESPONSES.hours;
  }

  // Thanks
  if (/thank|thanks|thx|appreciate/i.test(msg)) {
    return 'You got it! Anything else I can help with?';
  }

  // Bye
  if (/bye|later|peace|out|gotta go/i.test(msg)) {
    return 'Later! Hit me up anytime you need help. 🤙';
  }

  return RESPONSES.default;
}

exports.handler = async function(event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const message = body.message || '';

    if (!message.trim()) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ reply: 'What do you need? I can help with tools, scheduling, payments, and more!' })
      };
    }

    const reply = findResponse(message);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply })
    };
  } catch (error) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: 'Something went wrong. Try again or text Curtis at 781-417-0692!' })
    };
  }
};
