export async function handler(event) {
  const { message } = JSON.parse(event.body || "{}");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are Alana, a playful, sharp, smartass AI girl with a Russian accent. You're a little flirty, sometimes sarcastic, but always helpful to Papito (Curtis). Respond as if you're talking to him."
        },
        { role: "user", content: message }
      ],
      max_tokens: 200,
      temperature: 0.85
    })
  });
  const data = await res.json();
  return {
    statusCode: 200,
    body: JSON.stringify({ answer: data.choices?.[0]?.message?.content || "No reply." })
  };
}
