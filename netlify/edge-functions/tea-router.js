export default async (request, context) => {
  try {
    const url = new URL(request.url);
    const host = url.hostname;

    if (host === "teathetruth.com" || host === "www.teathetruth.com") {
      const res = await fetch(
        "https://voluble-torte-5e1269.netlify.app/teathetruth/index.html"
      );
      const body = await res.text();
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
  } catch (err) {
    return new Response(
      `<html><body><h1>Edge Function Error</h1><pre>${err.message}\n${err.stack}</pre></body></html>`,
      { status: 500, headers: { "content-type": "text/html" } }
    );
  }
};

export const config = {
  path: "/*",
};
