const jwt = require('jsonwebtoken');
require('dotenv').config();

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Accept token from Authorization: Bearer <token> or X-Auth-Token: <token>
  const token = (authHeader && authHeader.split(' ')[1]) || req.headers['x-auth-token'];

  if (!token) {
    return res.status(401).json({ message: 'Access token is required' });
  }

  if (!process.env.DEMO_JWT_SECRET) {
    return res.status(500).json({
      message: 'DEMO_JWT_SECRET is not configured for this deployment',
      code: 'ECONFIG'
    });
  }

  jwt.verify(token, process.env.DEMO_JWT_SECRET, (err, user) => {
    if (err || !user || user.demo_mode !== true) {
      // An expired/invalid token is an authentication failure (401), not a
      // permission problem (403). The frontend interceptor listens for 401
      // to clear localStorage and redirect to /login.
      return res.status(401).json({ message: 'Invalid or expired token', code: 'TOKEN_EXPIRED' });
    }
    req.user = user;
    next();
  });
}

function blockDemoAdminWrites(req, res, next) {
  if (req.user && req.user.demo_mode === true) {
    return res.status(403).json({
      message: 'This administrative action is disabled in the public demo.'
    });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authMiddleware, blockDemoAdminWrites, requireRole };
