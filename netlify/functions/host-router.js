const https = require('https');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const host = (event.headers.host || '').toLowerCase();

  if (host === 'teathetruth.com' || host === 'www.teathetruth.com') {
    try {
      const body = await fetchPage('https://curtbrag.com/teathetruth/index.html');
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' },
        body,
      };
    } catch {
      return { statusCode: 302, headers: { Location: 'https://curtbrag.com/teathetruth' } };
    }
  }

  // For curtbrag.com, serve the normal homepage
  try {
    const body = await fetchPage('https://curtbrag.com/index.html');
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' },
      body,
    };
  } catch {
    return { statusCode: 302, headers: { Location: 'https://curtbrag.com/index.html' } };
  }
};
