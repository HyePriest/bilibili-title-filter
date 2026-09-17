// Run: node tests/serve-rendering-tests.cjs [directory-containing-content.js-and-content.css]
// Open the printed address. No extension installation or real browser storage is used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = process.argv[2] ? path.resolve(process.argv[2]) : root;
const routes = new Map([
  ['/', [path.join(__dirname, 'rendering.test.html'), 'text/html']],
  ['/index.html', [path.join(__dirname, 'feed-loading.test.html'), 'text/html']],
  ['/content.js', [path.join(source, 'content.js'), 'text/javascript']],
  ['/content.css', [path.join(source, 'content.css'), 'text/css']],
  ['/special-types.js', [path.join(root, 'special-types.js'), 'text/javascript']],
  ['/quality.js', [path.join(root, 'quality.js'), 'text/javascript']],
  ['/feed-loader.js', [path.join(source, 'feed-loader.js'), 'text/javascript']]
]);
for (const file of ['popup.js', 'popup.css', 'shared-state.js', 'record-groups.js']) {
  routes.set(`/${file}`, [path.join(source, file), file.endsWith('.css') ? 'text/css' : 'text/javascript']);
}
routes.set('/popup-mock.js', [path.join(__dirname, 'popup-mock.js'), 'text/javascript']);
http.createServer((request, response) => {
  if (new URL(request.url, 'http://localhost').pathname === '/popup-test.html') {
    const html = fs.readFileSync(path.join(source, 'popup.html'), 'utf8')
      .replace('<script src="special-types.js">', '<script src="popup-mock.js"></script><script src="special-types.js">');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
    return;
  }
  const route = routes.get(new URL(request.url, 'http://localhost').pathname);
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': `${route[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
  fs.createReadStream(route[0]).pipe(response);
}).listen(0, '127.0.0.1', function () {
  console.log(`Rendering tests: http://127.0.0.1:${this.address().port}/`);
});
