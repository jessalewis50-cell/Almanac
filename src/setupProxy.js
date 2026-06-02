const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib');

module.exports = function (app) {
  const apiKey = process.env.REACT_APP_ANTHROPIC_API_KEY || '';

  // Mount at root with an explicit filter so Express does NOT strip the
  // /api/anthropic prefix before the proxy sees it — that lets pathRewrite work.
  app.use(
    createProxyMiddleware({
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      decompress: true,
      pathFilter: '/api/anthropic',
      pathRewrite: { '^/api/anthropic': '' },
      on: {
        proxyReq: (proxyReq) => {
          const destination = 'https://api.anthropic.com' + proxyReq.path;
          console.log('[proxy] Forwarding to:', destination);
          console.log('[proxy] key length:', apiKey.length, '| starts with:', apiKey.slice(0, 10) || '(missing)');
          proxyReq.setHeader('x-api-key', apiKey);
          proxyReq.setHeader('anthropic-version', '2023-06-01');
          proxyReq.setHeader('anthropic-dangerous-direct-browser-access', 'true');
          proxyReq.setHeader('Content-Type', 'application/json');
        },
        proxyRes: (proxyRes) => {
          if (proxyRes.statusCode !== 200) {
            const chunks = [];
            const encoding = proxyRes.headers['content-encoding'];
            proxyRes.on('data', (chunk) => chunks.push(chunk));
            proxyRes.on('end', () => {
              const raw = Buffer.concat(chunks);
              const decode = (buf) => {
                try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8'); }
              };
              if (encoding === 'gzip') {
                zlib.gunzip(raw, (err, result) => {
                  console.error(`[proxy] ${proxyRes.statusCode} from Anthropic:`, err ? raw.toString('utf8') : decode(result));
                });
              } else if (encoding === 'br') {
                zlib.brotliDecompress(raw, (err, result) => {
                  console.error(`[proxy] ${proxyRes.statusCode} from Anthropic:`, err ? raw.toString('utf8') : decode(result));
                });
              } else {
                console.error(`[proxy] ${proxyRes.statusCode} from Anthropic:`, decode(raw));
              }
            });
          }
        },
      },
    })
  );
};
