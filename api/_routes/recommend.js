const { connectToDatabase } = require('./db');
const { verifyToken, checkRole } = require('./auth');

async function computeRecommendations(db, { clientCode = '', natureOfWork = '', limit = null }) {
  const usersCollection = db.collection('users');
  const tasksCollection = db.collection('tasks');
  const attendanceCollection = db.collection('attendance');

  const cleanClient = String(clientCode || '').trim();
  const cleanNature = String(natureOfWork || '').trim();

  // Eligible operators (non-partner staff & articles)
  const operators = await usersCollection.find({ role: { $in: ['staff', 'article'] } }).toArray();
  if (operators.length === 0) return [];

  const opUsernames = operators.map(o => o.username.toLowerCase());

  // 1. Client specific experience
  let clientTaskCounts = {};
  if (cleanClient) {
    const clientStats = await tasksCollection.aggregate([
      { $match: { clientCode: cleanClient, currentStatus: 'Filed', workTakenBy: { $in: opUsernames } } },
      { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
    ]).toArray();
    clientStats.forEach(s => { clientTaskCounts[s._id] = s.count; });
  }

  // 2. Tax / Nature of Work expertise
  let taxTaskCounts = {};
  if (cleanNature) {
    const taxStats = await tasksCollection.aggregate([
      { $match: { natureOfWork: cleanNature, currentStatus: 'Filed', workTakenBy: { $in: opUsernames } } },
      { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
    ]).toArray();
    taxStats.forEach(s => { taxTaskCounts[s._id] = s.count; });
  }

  // 3. Active workload
  let activeTaskCounts = {};
  const loadStats = await tasksCollection.aggregate([
    { $match: { currentStatus: { $nin: ['Filed', 'Unassigned'] }, workTakenBy: { $in: opUsernames } } },
    { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
  ]).toArray();
  loadStats.forEach(s => { activeTaskCounts[s._id] = s.count; });

  // 4. Quality / reworks
  let qualityStats = {};
  const qualityAgg = await tasksCollection.aggregate([
    { $match: { workTakenBy: { $in: opUsernames } } },
    { $group: {
        _id: '$workTakenBy',
        totalFiled: { $sum: { $cond: [{ $eq: ['$currentStatus', 'Filed'] }, 1, 0] } },
        totalReworks: { $sum: { $ifNull: ['$sendBackCount', 0] } }
      }
    }
  ]).toArray();
  qualityAgg.forEach(q => { qualityStats[q._id] = q; });

  // 5. Today's attendance
  const todayIST = (() => {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ist = new Date(utc + (3600000 * 5.5));
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
  })();
  const attendanceToday = await attendanceCollection.find({ date: todayIST, username: { $in: opUsernames } }).toArray();
  const attMap = {};
  attendanceToday.forEach(a => { attMap[a.username.toLowerCase()] = a.status; });

  const maxClientCount = Math.max(...Object.values(clientTaskCounts), 1);
  const maxTaxCount = Math.max(...Object.values(taxTaskCounts), 1);

  const scoredList = operators.map(op => {
    const u = op.username.toLowerCase();
    const clientCnt = clientTaskCounts[u] || 0;
    const taxCnt = taxTaskCounts[u] || 0;
    const activeCnt = activeTaskCounts[u] || 0;
    const qInfo = qualityStats[u] || { totalFiled: 0, totalReworks: 0 };
    const attStatus = attMap[u] || 'Unknown';

    // Component scores
    const clientScore = cleanClient ? (clientCnt / maxClientCount) * 35 : 0;
    const taxScore = cleanNature ? (taxCnt / maxTaxCount) * 30 : 0;

    const reworkRatio = qInfo.totalFiled > 0 ? (qInfo.totalReworks / qInfo.totalFiled) : 0;
    const qualityScore = Math.max(0, 1 - Math.min(reworkRatio, 1)) * 15;

    const loadPenalty = Math.min(activeCnt * 2, 10);
    const loadScore = Math.max(0, 10 - loadPenalty);

    const synergyBonus = (clientCnt > 0 && taxCnt > 0) ? 10 : 0;
    const attendancePenalty = attStatus === 'Absent' ? 15 : 0;

    let totalScore = Math.round(clientScore + taxScore + qualityScore + loadScore + synergyBonus - attendancePenalty);
    if (!cleanClient && !cleanNature) {
      totalScore = Math.round(qualityScore + loadScore - attendancePenalty);
    }
    totalScore = Math.min(Math.max(totalScore, 10), 99);

    const reasons = [];
    if (attStatus === 'Present') reasons.push('Present in office today');
    if (attStatus === 'Absent') reasons.push('Absent today');
    if (clientCnt > 0) reasons.push(`Filed ${clientCnt} time${clientCnt > 1 ? 's' : ''} for this client`);
    if (taxCnt > 0) reasons.push(`${taxCnt} completed ${cleanNature} filings`);
    if (clientCnt > 0 && taxCnt > 0) reasons.push('Top match: familiar with client & work domain');
    if (activeCnt === 0) reasons.push('Available (0 active tasks in queue)');
    else reasons.push(`${activeCnt} active task${activeCnt > 1 ? 's' : ''} in queue`);
    if (qInfo.totalReworks === 0 && qInfo.totalFiled > 0) reasons.push('Zero send-backs recorded');

    return {
      username: op.username,
      name: op.name,
      role: op.role,
      score: totalScore,
      attendanceStatus: attStatus,
      clientCount: clientCnt,
      taxCount: taxCnt,
      activeTasks: activeCnt,
      reworks: qInfo.totalReworks,
      reasons: reasons
    };
  });

  scoredList.sort((a, b) => b.score - a.score);
  return (limit && limit > 0) ? scoredList.slice(0, limit) : scoredList;
}

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    if (!checkRole(decoded, ['partner', 'staff', 'article'])) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges.' });
    }

    const { db } = await connectToDatabase();
    const clientCode = (req.query.clientCode || (req.body && req.body.clientCode) || '').trim();
    const natureOfWork = (req.query.natureOfWork || (req.body && req.body.natureOfWork) || '').trim();
    const limit = parseInt(req.query.limit || (req.body && req.body.limit) || '0') || null;

    const recommendations = await computeRecommendations(db, { clientCode, natureOfWork, limit });

    return res.status(200).json({
      success: true,
      recommendations
    });
  } catch (error) {
    console.error('Recommendation API error:', error);
    return res.status(500).json({ success: false, message: 'Recommendation engine error: ' + error.message });
  }
};

module.exports.computeRecommendations = computeRecommendations;
