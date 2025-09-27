const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const bodyParser = require('body-parser');

const TARGET = process.env.TARGET || 'http://localhost:4000';
const app = express();
app.use(bodyParser.json());

const injectPresence = responseInterceptor(async (buf, proxyRes, req) => {
  const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return buf;
  if (!req.url.toLowerCase().includes('heartbeat')) return buf;

  try {
    const data = JSON.parse(buf.toString('utf8'));
    if (!data.presencePrompt && !data.prompt) {
      data.presencePrompt = {
        id: 'force-test-001',
        message: 'Quick presence check — are you there?',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      };
    }
    return Buffer.from(JSON.stringify(data));
  } catch {
    return buf;
  }
});

app.use('/', createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  selfHandleResponse: true,
  on: { proxyRes: injectPresence },
}));

const port = process.env.PORT || 5005;
app.listen(port, () => {
  console.log(`[presence-proxy] forwarding to ${TARGET} and injecting on *heartbeat* paths @ http://localhost:${port}`);
});
