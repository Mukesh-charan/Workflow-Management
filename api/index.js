const path = require('path');
const fs = require('fs');
const url = require('url');

module.exports = async (req, res) => {
  // Ensure helper response methods exist
  if (!res.status) {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
  }
  if (!res.json) {
    res.json = (data) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
      return res;
    };
  }

  // Parse route from query or URL pathname
  let route = req.query && req.query.route;

  if (!route && req.url) {
    const parsed = url.parse(req.url, true);
    route = (parsed.query && parsed.query.route) || parsed.pathname.replace(/^\/api\/?/, '');
  }

  if (typeof route === 'string') {
    route = route.replace(/^\/+|\/+$/g, '').replace(/\.js$/, '');
  }

  // Clean route query param so downstream handlers see only their params
  if (req.query && req.query.route) {
    delete req.query.route;
  }

  // Validate route name
  if (!route || !/^[a-zA-Z0-9_-]+$/.test(route)) {
    return res.status(404).json({ success: false, message: 'API endpoint not found.' });
  }

  const handlerPath = path.join(__dirname, '_routes', `${route}.js`);

  if (!fs.existsSync(handlerPath)) {
    return res.status(404).json({ success: false, message: 'API endpoint not found.' });
  }

  try {
    const handler = require(handlerPath);
    if (typeof handler !== 'function') {
      return res.status(404).json({ success: false, message: 'API endpoint not found.' });
    }

    // Parse JSON string body if not already parsed
    if (typeof req.body === 'string' && req.body.length > 0) {
      try {
        req.body = JSON.parse(req.body);
      } catch (_) {}
    }

    return await handler(req, res);
  } catch (err) {
    console.error(`Error executing handler for ${route}:`, err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: err.message || 'Internal Server Error' });
    }
  }
};
