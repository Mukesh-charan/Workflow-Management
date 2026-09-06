const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load environment variables from .env.local or .env if present
const envPath = fs.existsSync(path.join(__dirname, '.env.local')) 
  ? path.join(__dirname, '.env.local') 
  : (fs.existsSync(path.join(__dirname, '.env')) ? path.join(__dirname, '.env') : null);

if (envPath) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  });
}

const PORT = process.env.PORT || 3000;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Helper response utilities for serverless handlers
  res.status = function(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function(data) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
    return res;
  };

  // Route API requests (/api/*)
  if (pathname.startsWith('/api/')) {
    const routeName = pathname.replace('/api/', '').split('?')[0];
    const handlerPath = path.join(__dirname, 'api', `${routeName}.js`);

    if (fs.existsSync(handlerPath)) {
      try {
        req.query = parsedUrl.query;
        
        // Parse body for POST, PUT, PATCH, DELETE
        let bodyStr = '';
        req.on('data', chunk => { bodyStr += chunk; });
        req.on('end', async () => {
          try {
            req.body = bodyStr ? JSON.parse(bodyStr) : {};
          } catch (e) {
            req.body = {};
          }
          try {
            delete require.cache[require.resolve(handlerPath)];
            const handler = require(handlerPath);
            await handler(req, res);
          } catch (err) {
            console.error(`Error executing handler ${routeName}:`, err);
            if (!res.headersSent) {
              res.status(500).json({ success: false, message: err.message });
            }
          }
        });
        return;
      } catch (err) {
        console.error(`Error handling ${pathname}:`, err);
        if (!res.headersSent) {
          return res.status(500).json({ success: false, message: err.message });
        }
      }
    } else {
      return res.status(404).json({ success: false, message: 'API endpoint not found.' });
    }
  }

  // Serve static files
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath).toLowerCase();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('404 Not Found');
      return;
    }

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const nextPort = (server.address() ? server.address().port : PORT) + 1;
    console.log(`Port in use, trying next port...`);
    server.listen(0); // Let OS assign a free port if default is busy
  } else {
    console.error(err);
  }
});

server.listen(PORT, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`==================================================`);
  console.log(` CA Office Workflow System running locally`);
  console.log(` Access Dashboard: http://localhost:${actualPort}`);
  console.log(`==================================================`);
});
