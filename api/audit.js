const { connectToDatabase } = require('./db');
const { verifyToken, checkRole } = require('./auth');

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    if (!checkRole(decoded, ['partner'])) {
      return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
    }

    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { db } = await connectToDatabase();
    const { search, page, limit } = req.query;

    let query = {};
    if (search) {
      const searchRegex = { $regex: search.trim(), $options: 'i' };
      query.$or = [
        { actor: searchRegex },
        { action: searchRegex },
        { 'details.clientName': searchRegex },
        { 'details.natureOfWork': searchRegex },
        { 'details.taskId': searchRegex }
      ];
    }

    const totalCount = await db.collection('audit_logs').countDocuments(query);
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const skip = (pageNum - 1) * limitNum;

    const auditLogs = await db.collection('audit_logs')
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    return res.status(200).json({
      success: true, logs: auditLogs, totalCount,
      page: pageNum, totalPages: Math.ceil(totalCount / limitNum)
    });
  } catch (error) {
    console.error('Audit API error:', error);
    res.status(500).json({ success: false, error: error.message || 'Database error.' });
  }
};
