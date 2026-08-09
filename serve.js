// ============================================================
// 前端本地静态服务器（零依赖，仅用于本地测试/预览）
// 路由规则与 CF Pages 的 _redirects 保持一致
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// URL 路径 → 实际文件（与 _redirects 对应）
function routeToFile(urlPath) {
  if (urlPath === '/' || urlPath === '/hub') return 'hub.html';
  if (urlPath === '/admin') return 'admin.html';
  if (urlPath === '/dfw' || urlPath.startsWith('/dfw/')) return 'index.html';
  if (urlPath === '/uno' || urlPath.startsWith('/uno/')) return 'uno.html';
  return null;
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  const mapped = routeToFile(urlPath);
  if (mapped) urlPath = '/' + mapped;

  if (urlPath === '/') urlPath = '/hub.html';

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('🌐 前端静态服务器已启动: http://localhost:' + PORT);
});
server.on('error', (err) => {
  console.error('[前端服务器错误]', err.message);
  if (err.code === 'EADDRINUSE') console.error('端口 ' + PORT + ' 已被占用！');
  process.exit(1);
});
