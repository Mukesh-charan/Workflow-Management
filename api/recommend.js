const { connectToDatabase } = require('./db');
const { verifyToken, checkRole } = require('./auth');

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
    const usersCollection = db.collection('users');
    const tasksCollection = db.collection('tasks');

    const clientCode = (req.query.clientCode || (req.body && req.body.clientCode) || '').trim();
    const natureOfWork = (req.query.natureOfWork || (req.body && req.body.natureOfWork) || '').trim();

    // Fetch all eligible operators (non-partner staff & articles)
    const operators = await usersCollection.find({ role: { $in: ['staff', 'article'] } }).toArray();
    if (operators.length === 0) {
      return res.status(200).json({ success: true, recommendations: [] });
    }

    const opUsernames = operators.map(o => o.username.toLowerCase());

    // Aggregate statistics across tasks
    // 1. Client specific experience
    let clientTaskCounts = {};
    if (clientCode) {
      const clientStats = await tasksCollection.aggregate([
        { $match: { clientCode: String(clientCode), currentStatus: 'Filed', workTakenBy: { $in: opUsernames } } },
        { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
      ]).toArray();
      clientStats.forEach(s => { clientTaskCounts[s._id] = s.count; });
    }

    // 2. Tax / Nature of Work expertise
    let taxTaskCounts = {};
    if (natureOfWork) {
      const taxStats = await tasksCollection.aggregate([
        { $match: { natureOfWork: natureOfWork, currentStatus: 'Filed', workTakenBy: { $in: opUsernames } } },
        { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
      ]).toArray();
      taxStats.forEach(s => { taxTaskCounts[s._id] = s.count; });
    }

    // 3. Active workload (tasks currently in-progress, not filed)
    let activeTaskCounts = {};
    const loadStats = await tasksCollection.aggregate([
      { $match: { currentStatus: { $nin: ['Filed', 'Unassigned'] }, workTakenBy: { $in: opUsernames } } },
      { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
    ]).toArray();
    loadStats.forEach(s => { activeTaskCounts[s._id] = s.count; });

    // 4. Overall quality / reworks
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

    // Find maximums for normalization
    const maxClientCount = Math.max(...Object.values(clientTaskCounts), 1);
    const maxTaxCount = Math.max(...Object.values(taxTaskCounts), 1);

    // Compute composite score for each operator
    const scoredList = operators.map(op => {
      const u = op.username.toLowerCase();
      const clientCnt = clientTaskCounts[u] || 0;
      const taxCnt = taxTaskCounts[u] || 0;
      const activeCnt = activeTaskCounts[u] || 0;
      const qInfo = qualityStats[u] || { totalFiled: 0, totalReworks: 0 };

      // Component scores
      const clientScore = clientCode ? (clientCnt / maxClientCount) * 40 : 0;
      const taxScore = natureOfWork ? (taxCnt / maxTaxCount) * 35 : 0;
      
      const reworkRatio = qInfo.totalFiled > 0 ? (qInfo.totalReworks / qInfo.totalFiled) : 0;
      const qualityScore = Math.max(0, 1 - Math.min(reworkRatio, 1)) * 15;

      const loadPenalty = Math.min(activeCnt * 2, 10);
      const loadScore = Math.max(0, 10 - loadPenalty);

      // Synergy bonus: if handled both this client before AND this tax type before
      const synergyBonus = (clientCnt > 0 && taxCnt > 0) ? 10 : 0;

      let totalScore = Math.round(clientScore + taxScore + qualityScore + loadScore + synergyBonus);
      if (!clientCode && !natureOfWork) {
        // Fallback baseline when no criteria specified yet
        totalScore = Math.round(qualityScore + loadScore);
      }
      totalScore = Math.min(Math.max(totalScore, 10), 99);

      // Human-readable badges & explanations
      const reasons = [];
      if (clientCnt > 0) {
        reasons.push(`Handled this client ${clientCnt} time${clientCnt > 1 ? 's' : ''}`);
      }
      if (taxCnt > 0) {
        reasons.push(`${taxCnt} completed ${natureOfWork} filings`);
      }
      if (clientCnt > 0 && taxCnt > 0) {
        reasons.push(`Top match: Familiar with client & tax domain`);
      }
      if (activeCnt === 0) {
        reasons.push(`Currently available (0 active tasks)`);
      } else {
        reasons.push(`${activeCnt} active task${activeCnt > 1 ? 's' : ''} in queue`);
      }
      if (qInfo.totalReworks === 0 && qInfo.totalFiled > 0) {
        reasons.push(`Zero send-backs recorded`);
      }

      return {
        username: op.username,
        name: op.name,
        role: op.role,
        score: totalScore,
        clientCount: clientCnt,
        taxCount: taxCnt,
        activeTasks: activeCnt,
        reworks: qInfo.totalReworks,
        reasons: reasons
      };
    });

    // Sort descending by score
    scoredList.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      recommendations: scoredList
    });
  } catch (error) {
    console.error('Recommendation API error:', error);
    return res.status(500).json({ success: false, message: 'Recommendation engine error: ' + error.message });
  }
};
