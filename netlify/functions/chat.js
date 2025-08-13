const fetch = require("node-fetch");

exports.handler = async (event, context) => {
  // CORS preflight response
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST',
      },
      body: '',
    };
  }

  const allowCors = (statusCode, body) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'OPTIONS,POST',
    },
    body,
  });

  try {
    const { message } = JSON.parse(event.body || '{}');

    // Read API key from environment variables
    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (!apiKey) {
      return allowCors(500, JSON.stringify({ reply: 'OpenAI API key not configured.' }));
    }

    // Build the request payload
    const requestBody = {
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content:
            'You are Alana, a playful, sharp, smartass AI girl with a Russian accent. You’re a little flirt but professional.',
        },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
      temperature: 0.85,
    };

    // Send the request to OpenAI
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    // Handle non-successful responses
    if (!response.ok) {
      const errorText = await response.text();
      return allowCors(response.status, JSON.stringify({ reply: `Error ${response.status}: ${errorText}` }));
    }

    const data = await response.json();
    const reply =
      data.choices?.[0]?.message?.content || 'No reply.';
    return allowCors(200, JSON.stringify({ reply }));
  } catch (error) {
    return allowCors(500, JSON.stringify({ reply: 'Error: ' + error.message }));
  }
};
