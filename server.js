const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ttf':  'font/ttf',
  '.wav':  'audio/wav',
};

http.createServer((req, res) => {
  const url  = req.url === '/' ? '/index.html' : req.url;
  const file = path.join(ROOT, url);

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found: ' + url);
      return;
    }
    const ext  = path.extname(file);
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('Dr. Sbaitzo server running.');
  console.log('Open this in Chrome: http://localhost:' + PORT);
  console.log('Press Ctrl+C to stop.');
});
