const fetch = require("node-fetch");

exports.handler = async (event, context) => {
  try {
    const { message } = JSON.parse(event.body || '{}');

    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "OpenAI API key not configured." })
      };
    }

    const requestBody = {
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are Alana, a playful, sharp, smartass AI girl with a Russian accent. You’re a little flirt but professional." },
        { role: "user", content: message }
      ],
      max_tokens: 200,
      temperature: 0.85
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        statusCode: response.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: 'Error ' + response.status + ': ' + errorText })
      };
    }

    const data = await response.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "No reply." })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
     
    };
  }
}; body: JSON.stringify({ reply: 'Error: ' + error.message })
    };
  }
};
