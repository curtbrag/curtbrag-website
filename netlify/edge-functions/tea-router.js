export default async (request, context) => {
  const url = new URL(request.url);
  const host = url.hostname;

  if (host === "teathetruth.com" || host === "www.teathetruth.com") {
    // Fetch directly from the Netlify app URL to avoid any domain routing issues
    const res = await fetch(
      "https://voluble-torte-5e1269.netlify.app/teathetruth/index.html"
    );
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  }
};

export const config = {
  path: "/*",
};
