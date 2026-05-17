const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]; // ignora query string
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext  = path.extname(filePath);
    const type = MIME[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`\n✅ Lumin rodando em: http://localhost:${PORT}\n`);
});
