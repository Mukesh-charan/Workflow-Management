const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-local-secret-key-12345';

function verifyToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split(' ')[1];
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function checkRole(decoded, allowedRoles) {
  if (!decoded) return false;
  return allowedRoles.includes(decoded.role);
}

async function logAuditAction(db, actor, action, details) {
  try {
    const auditCollection = db.collection('audit_logs');
    await auditCollection.insertOne({
      timestamp: new Date(),
      actor: actor || 'system',
      action: action,
      details: details || {}
    });
  } catch (error) {
    console.error('Audit logging failed:', error);
  }
}

module.exports = { verifyToken, checkRole, logAuditAction };
