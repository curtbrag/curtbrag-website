// Alina - Curtis AI Assistant
// Smart rule-based responses for common questions

const RESPONSES = {
  // Greetings
  greetings: [
    'Hey! Alina here. What can I help you with?',
    'What\'s up? I\'m Alina, Curtis\'s AI assistant. How can I help?',
    'Hey there! Need help with tools, scheduling, or something else?',
    'Yo! Alina at your service. What do you need?',
    'Hey! Curtis is probably on the route right now, but I got you. What\'s up?'
  ],

  // Schedule/Stop
  schedule: 'Want to schedule a truck stop? Click the "Schedule Stop" button above or text Curtis directly at 781-417-0692. He covers the Boston area!',

  // Tools/Products
  tools: 'Curtis runs a Snap-on tool truck in the Boston area. Looking for something specific? Use the "Request a Tool" button or ask me what you need!',

  // Specific tool categories
  diagnostics: 'Looking for diagnostic tools? Curtis has Snap-on scanners, code readers, and the latest diagnostic equipment. ZEUS, TRITON, SOLUS - he can hook you up. Schedule a stop to check them out!',

  torque: 'Need a torque wrench? Snap-on has digital, click-type, and beam style. The TechAngle series is popular. Curtis can show you the options on the truck!',

  impacts: 'Impact guns are a specialty! From the CT series cordless to air impacts, Curtis has them. The CT9100 is a beast. Schedule a stop to feel the power!',

  toolbox: 'Looking for a toolbox or storage? Snap-on has everything from roll carts to full Masters Series boxes. Curtis can help you spec one out and set up financing if needed.',

  // Warranty
  warranty: 'Need warranty help or an RA? Click "Warranty/RA Help" above or contact Curtis directly. Snap-on has great lifetime warranties on hand tools!',

  // Payment options
  payment: 'Curtis accepts multiple payment methods:\n• Zelle (fastest!)\n• CashApp\n• Venmo\n• Credit cards on the truck\n• Snap-on Credit (for bigger purchases)\nClick the payment buttons above to send money directly!',

  // Financing
  financing: 'Need financing? Snap-on Credit offers flexible payment plans for tools and boxes. Curtis can run an app right on the truck - quick approval process. Schedule a stop to discuss options!',

  // Promos/Deals
  promos: 'For current promos and deals, check with Curtis directly! New flyers come out regularly with hot deals. Schedule a stop to see what\'s on special this week.',

  // DraftKings
  draftkings: 'Curtis is into DraftKings! Want to talk sports betting or need a referral? Hit him up on the socials or click the DraftKings button above.',

  // Boston Sports
  sports: 'Boston sports fan? Curtis bleeds Boston - Red Sox, Patriots, Celtics, Bruins, even the Revolution! Check out the Sports Tracker on the main page for live scores. Go Boston!',

  // Cards/Trading
  cards: 'Check out the Card Shop for Curtis\'s eBay listings, or browse the Photo Gallery to see the collection! Baseball, basketball, Pokemon and more. eBay username is "curtbrag".',

  // Contact
  contact: 'Best ways to reach Curtis:\n• Call: 781-417-0692\n• Text: Same number (he prefers texts!)\n• Email: curtbrag@yahoo.com\nOr use the social links above!',

  // Location/Area
  location: 'Curtis covers the Boston metro area with his Snap-on truck. Cities include Boston, Cambridge, Somerville, Lynn, Swampscott, Revere, Chelsea, Everett, Malden, Medford, and surrounding areas. Schedule a stop!',

  // Hours
  hours: 'The truck runs Monday-Friday, typical business hours (usually 7am-5pm depending on the route). Exact schedule varies by route. Best bet is to schedule a stop or text Curtis to confirm!',

  // About Curtis
  about: 'Curtis has been running Snap-on tools in the Boston area for years. Started turning wrenches on diesel engines, now he\'s helping Boston\'s best techs get the tools they need. He\'s also into sports betting, trading cards, and building custom automations. Real one!',

  // Phone Cluster
  cluster: 'Curtis built a Kubernetes cluster out of 10 OnePlus 6T phones! They run postmarketOS (real Linux) with K3s. Check it out at /cluster - it shows live node status, running pods, and more. Sustainable tech reuse meets edge computing!',

  // Social media
  social: 'Follow Curtis everywhere!\n• Instagram: @curtbrag\n• TikTok: @curtbrag\n• YouTube: Curtis Bragdon\n• Facebook, Snapchat, Threads, and more!\nAll links are on the main page.',

  // Help / what can you do
  help: 'I can help you with:\n• Scheduling truck stops\n• Tool requests & questions\n• Warranty/RA help\n• Payment options\n• Current promos\n• Contact info\n• Boston sports scores\nJust ask!',

  // Jokes
  jokes: [
    'Why did the mechanic break up with their socket set? Too many loose connections! 😄',
    'What do you call a tool that tells jokes? A pun-ch! Get it? ...Curtis tells better ones.',
    'I\'d tell you a UDP joke, but you might not get it. ...That\'s an IT joke. Moving on!',
    'Why do Snap-on tools never get lost? Because they cost too much to misplace! 💸'
  ],

  // Competitors mention
  competitors: 'Snap-on quality speaks for itself! Curtis can show you the difference on the truck. Lifetime warranty on hand tools, best ergonomics in the game, and Curtis actually services what he sells. Schedule a stop and see for yourself!',

  // Truck info
  truck: 'The Snap-on truck is a mobile tool store! Curtis brings the showroom to you - tools, diagnostics, storage, and more. It\'s climate controlled and stocked with the good stuff. Schedule a stop to check it out!',

  // Gallery
  gallery: 'Check out the galleries! Cars Gallery has customer rides from around Boston, and the Snap-on Gallery has tool truck photos and memories. Click "Photo Gallery" above to browse!',

  // Default
  default: 'I\'m not sure about that one. For specific questions, text Curtis at 781-417-0692 or use the contact buttons above. I can help with:\n• Scheduling stops\n• Tool requests\n• Warranty help\n• Payment options\n• Promos & deals\n• Boston sports'
};

function getRandomResponse(arr) {
  if (Array.isArray(arr)) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  return arr;
}

function findResponse(message) {
  const msg = message.toLowerCase();

  // Greetings
  if (/^(hi|hey|hello|yo|sup|what'?s? up|howdy|hola|wassup)/i.test(msg)) {
    return getRandomResponse(RESPONSES.greetings);
  }

  // Help / what can you do
  if (/^(help|what can you|what do you|commands|options|\?$)/i.test(msg)) {
    return RESPONSES.help;
  }

  // About Curtis
  if (/who.*(curtis|curt|you)|about.*(curtis|curt)|tell me about/i.test(msg)) {
    return RESPONSES.about;
  }

  // Phone Cluster
  if (/cluster|kubernetes|k3s|k8s|oneplus|phone.*(server|cluster)|server.*(phone|arm)|postmarket/i.test(msg)) {
    return RESPONSES.cluster;
  }

  // Jokes
  if (/joke|funny|laugh|humor|make me laugh/i.test(msg)) {
    return getRandomResponse(RESPONSES.jokes);
  }

  // Schedule/Stop
  if (/schedul|stop|visit|come by|truck stop|route|appointment/i.test(msg)) {
    return RESPONSES.schedule;
  }

  // Diagnostics
  if (/diagnos|scanner|code reader|zeus|triton|solus|obd|scan tool/i.test(msg)) {
    return RESPONSES.diagnostics;
  }

  // Torque wrenches
  if (/torque|tech ?angle|click.*(wrench|type)/i.test(msg)) {
    return RESPONSES.torque;
  }

  // Impact tools
  if (/impact|ct ?9|ct ?8|air gun|cordless.*(gun|impact)/i.test(msg)) {
    return RESPONSES.impacts;
  }

  // Toolbox/Storage
  if (/toolbox|tool ?box|storage|roll ?cart|cabinet|chest|master.?series/i.test(msg)) {
    return RESPONSES.toolbox;
  }

  // General Tools
  if (/tool|wrench|socket|ratchet|screw|snap-?on|product|buy|purchase|order|plier|hammer/i.test(msg)) {
    return RESPONSES.tools;
  }

  // Warranty
  if (/warrant|ra |return|broke|broken|replace|repair|fix|lifetime/i.test(msg)) {
    return RESPONSES.warranty;
  }

  // Financing
  if (/financ|credit|payment ?plan|monthly|loan|app(lication|ly)/i.test(msg)) {
    return RESPONSES.financing;
  }

  // Payment
  if (/pay|zelle|cash ?app|venmo|money|how.*(pay|send)/i.test(msg)) {
    return RESPONSES.payment;
  }

  // Promos
  if (/promo|deal|sale|discount|special|flyer|hot buy|coupon/i.test(msg)) {
    return RESPONSES.promos;
  }

  // DraftKings/Sports betting
  if (/draft ?king|bet|gambl|odds|sport.*(bet|pick)|parlay|line/i.test(msg)) {
    return RESPONSES.draftkings;
  }

  // Boston Sports teams
  if (/red ?sox|patriot|celtic|bruin|revolution|boston.*(sports?|team)/i.test(msg)) {
    return RESPONSES.sports;
  }

  // Cards
  if (/card|trading|pokemon|baseball|basketball|ebay|collect/i.test(msg)) {
    return RESPONSES.cards;
  }

  // Gallery
  if (/gallery|photo|picture|image|car.*(pic|photo)/i.test(msg)) {
    return RESPONSES.gallery;
  }

  // Social media
  if (/follow|social|instagram|insta|tiktok|youtube|facebook|twitter/i.test(msg)) {
    return RESPONSES.social;
  }

  // Contact
  if (/contact|reach|phone|email|number|call(?! me)|text/i.test(msg)) {
    return RESPONSES.contact;
  }

  // Truck info
  if (/truck|van|vehicle|what.*(drive|bring)/i.test(msg)) {
    return RESPONSES.truck;
  }

  // Location
  if (/where|location|area|city|town|cover|boston|cambridge|somerville|lynn/i.test(msg)) {
    return RESPONSES.location;
  }

  // Hours
  if (/hour|when|time|open|close|available/i.test(msg)) {
    return RESPONSES.hours;
  }

  // Competitors
  if (/mac ?tool|matco|cornwell|harbor ?freight|cheap|other.*(brand|truck)/i.test(msg)) {
    return RESPONSES.competitors;
  }

  // Thanks
  if (/thank|thanks|thx|appreciate|perfect|awesome|great/i.test(msg)) {
    return getRandomResponse([
      'You got it! Anything else I can help with?',
      'No problem! Let me know if you need anything else.',
      'Anytime! Hit me up if you have more questions.'
    ]);
  }

  // Bye
  if (/bye|later|peace|out|gotta go|see ya|cya/i.test(msg)) {
    return getRandomResponse([
      'Later! Hit me up anytime you need help.',
      'Peace! Come back anytime.',
      'Take it easy! Curtis will catch you on the route.'
    ]);
  }

  // Positive affirmations
  if (/^(yes|yeah|yep|yup|ok|okay|sure|cool|nice|dope|fire|lit)$/i.test(msg)) {
    return 'Nice! What else can I help you with?';
  }

  // Negative
  if (/^(no|nope|nah|nothing|nevermind|nm)$/i.test(msg)) {
    return 'All good! I\'m here if you need anything.';
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
