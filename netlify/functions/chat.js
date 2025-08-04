// netlify/functions/chat.js
import fetch from "node-fetch";

export async function handler(event) {
  const { message } = JSON.parse(event.body || "{}");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o", // Use 'gpt-4o' for speed/price, or 'gpt-4' if needed
      messages: [
        {
          role: "system",
          content: "You are Alana, a playful, young, smartass AI girl with a Russian accent. Answer with wit and attitude, but helpfully. Papito (Curtis) is the boss."
        },
        { role: "user", content: message }
      ],
      max_tokens: 200,
      temperature: 0.8
    })
  });
  const data = await res.json();
  return {
    statusCode: 200,
    body: JSON.stringify({ answer: data.choices[0].message.content })
  };
}
