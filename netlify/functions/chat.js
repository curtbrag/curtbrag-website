// netlify/functions/chat.js
import fetch from "node-fetch";

export async function handler(event) {
  const { question } = JSON.parse(event.body || "{}");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: question }]
    })
  });
  const data = await res.json();
  return {
    statusCode: 200,
    body: JSON.stringify({ reply: data.choices[0].message.content })
  };
}
