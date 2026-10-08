const { connectToDatabase } = require('./db');
const { verifyToken, checkRole, logAuditAction } = require('./auth');
const { computeRecommendations } = require('./recommend');

function isGstWorkCheck(natureOfWork) {
  if (!natureOfWork) return false;
  const str = String(natureOfWork).toLowerCase().trim();
  return str.includes('gst') || str.includes('cmp');
}

// =============================================================================
// UNSTRUCTURED PARAGRAPH / SENTENCE PARAMETER EXTRACTOR
// Extracts Client, Nature, AY, Due Date, Operator, Top-N recommendations, Status
// in a single pass from natural language paragraphs or sentences.
// =============================================================================
function parseUnstructuredTaskParameters(text, allClients = [], allUsers = [], allEngagements = []) {
  const tLower = text.toLowerCase();
  const result = {
    clientCode: '',
    clientName: '',
    natureOfWork: '',
    assessmentYear: '',
    dueDate: '',
    operator: '',
    assignToBest: false,
    requestedN: null,
    wantsRecommendation: false,
    taskId: null,
    targetStatus: null,
    confidence: {
      hasClient: false,
      hasNature: false,
      hasDueDate: false
    }
  };

  // 1. Task ID extraction (e.g., "task #12345", "job 12345", "#1234567")
  const taskIdMatch = text.match(/(?:task|job)\s*#?(\d{5,})/i) || text.match(/#(\d{5,})/);
  if (taskIdMatch) {
    result.taskId = parseInt(taskIdMatch[1]);
  }

  // 2. Client Extraction (ID, Name, PAN, GSTIN, or Phrased Name)
  // 2a. Check by ID (e.g., "#101", "client 101", "client #101")
  const idMatch = text.match(/(?:client\s*#?|id\s*#?)(\d{1,6})/i);
  if (idMatch) {
    const cId = parseInt(idMatch[1]);
    const found = allClients.find(c => Number(c.id) === cId);
    if (found) {
      result.clientCode = String(found.id);
      result.clientName = found.name;
      result.confidence.hasClient = true;
    }
  }

  // 2b. Match existing clients by name from DB
  if (!result.clientCode) {
    for (const c of allClients) {
      const cNameClean = c.name.toLowerCase().trim();
      if (cNameClean.length >= 3 && tLower.includes(cNameClean)) {
        result.clientCode = String(c.id);
        result.clientName = c.name;
        result.confidence.hasClient = true;
        break;
      }
    }
  }

  // 2c. Substring / phrase match (e.g. "for client Ramesh & Sons", "for Alpha Corp", "client: TCS")
  if (!result.clientCode) {
    const phraseMatch = text.match(/(?:for client|for|client:)\s+([a-zA-Z0-9\s&.,'-]+?)(?:\s+(?:for|due|ay|period|with|and|recommend|assign|status|to)|$)/i);
    if (phraseMatch) {
      const candidateName = phraseMatch[1].trim();
      if (candidateName.length >= 2 && !['task', 'the', 'a', 'an', 'gst', 'it', 'tds'].includes(candidateName.toLowerCase())) {
        const fuzzy = allClients.find(c => c.name.toLowerCase().includes(candidateName.toLowerCase()) || candidateName.toLowerCase().includes(c.name.toLowerCase()));
        if (fuzzy) {
          result.clientCode = String(fuzzy.id);
          result.clientName = fuzzy.name;
        } else {
          result.clientCode = String(Date.now()).slice(-5);
          result.clientName = candidateName;
        }
        result.confidence.hasClient = true;
      }
    }
  }

  // 3. Nature of Work Extraction
  if (tLower.includes('tax audit') || tLower.includes('3cd') || tLower.includes('44ab')) {
    result.natureOfWork = 'Tax Audit (3CD)';
    result.confidence.hasNature = true;
  } else if (tLower.includes('statutory audit') || tLower.includes('company audit')) {
    result.natureOfWork = 'Statutory Audit';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gstr 3b') || tLower.includes('gstr3b')) {
    result.natureOfWork = 'GSTR 3B';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gstr 1') || tLower.includes('gstr1')) {
    result.natureOfWork = 'GSTR 1';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gstr 4') || tLower.includes('cmp 8') || tLower.includes('cmp-8')) {
    result.natureOfWork = 'GSTR 4';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gst annual') || tLower.includes('9/9c') || tLower.includes('gstr 9')) {
    result.natureOfWork = 'GST Annual Return (9/9C)';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gst monthly') || tLower.includes('gst return') || tLower.includes('gst filing') || tLower.includes('gst')) {
    result.natureOfWork = 'GST Monthly Return';
    result.confidence.hasNature = true;
  } else if (tLower.includes('tds') || tLower.includes('26q') || tLower.includes('24q')) {
    result.natureOfWork = 'TDS Quarterly Filing';
    result.confidence.hasNature = true;
  } else if (tLower.includes('roc') || tLower.includes('mca') || tLower.includes('aoc-4')) {
    result.natureOfWork = 'ROC Filing';
    result.confidence.hasNature = true;
  } else if (tLower.includes('it return') || tLower.includes('itr') || tLower.includes('income tax')) {
    result.natureOfWork = 'IT Return';
    result.confidence.hasNature = true;
  } else {
    // Check against engagement titles from DB
    for (const eng of allEngagements) {
      if (tLower.includes(eng.toLowerCase())) {
        result.natureOfWork = eng;
        result.confidence.hasNature = true;
        break;
      }
    }
  }

  // Default nature if missing but creation intended
  if (!result.natureOfWork) {
    if (tLower.includes('tax')) result.natureOfWork = 'IT Return';
    else if (tLower.includes('audit')) result.natureOfWork = 'Statutory Audit';
    else result.natureOfWork = 'GST Monthly Return';
  }

  // 4. Assessment Year / Period Extraction
  const ayMatch = text.match(/(?:ay|assessment year|period|fy|financial year)\s*[:=]?\s*([0-9]{4}[-/][0-9]{2,4}|[0-9]{4}-[0-9]{2})/i) ||
                  text.match(/\b(20[2-3][0-9]-[2-3][0-9])\b/);
  if (ayMatch) {
    result.assessmentYear = ayMatch[1].trim();
  } else {
    // Month + Year period (e.g. "October 2026", "Oct 2026")
    const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december',
                        'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    for (let m = 0; m < monthNames.length; m++) {
      const mStr = monthNames[m];
      const pMatch = text.match(new RegExp(`(?:period|month|for)\\s+${mStr}\\s*(\\d{4})?`, 'i'));
      if (pMatch) {
        const yr = pMatch[1] || new Date().getFullYear();
        const mNum = String((m % 12) + 1).padStart(2, '0');
        result.assessmentYear = `${yr}-${mNum}`;
        break;
      }
    }
  }

  // If GST work, clear assessment year per repo rule
  if (isGstWorkCheck(result.natureOfWork)) {
    result.assessmentYear = '';
  } else if (!result.assessmentYear) {
    const now = new Date();
    const currYear = now.getFullYear();
    result.assessmentYear = `${currYear}-${(currYear + 1).toString().slice(-2)}`;
  }

  // 5. Due Date Extraction
  const now = new Date();
  const currYear = now.getFullYear();
  const currMonth = String(now.getMonth() + 1).padStart(2, '0');

  // 5a. ISO format YYYY-MM-DD
  const isoDateMatch = text.match(/\b(20[2-3][0-9]-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))\b/);
  if (isoDateMatch) {
    result.dueDate = isoDateMatch[1];
    result.confidence.hasDueDate = true;
  }

  // 5b. DD-MM-YYYY or DD/MM/YYYY
  if (!result.dueDate) {
    const indianDateMatch = text.match(/\b(0?[1-9]|[12][0-9]|3[01])[/-](0?[1-9]|1[0-2])[/-](20[2-3][0-9])\b/);
    if (indianDateMatch) {
      const d = String(indianDateMatch[1]).padStart(2, '0');
      const m = String(indianDateMatch[2]).padStart(2, '0');
      const y = indianDateMatch[3];
      result.dueDate = `${y}-${m}-${d}`;
      result.confidence.hasDueDate = true;
    }
  }

  // 5c. "20th November", "20 November", "Nov 20", "20th"
  if (!result.dueDate) {
    const monthNames = {
      jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
      apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
      aug: '08', august: '08', sep: '09', september: '09', oct: '10', october: '10',
      nov: '11', november: '11', dec: '12', december: '12'
    };
    const dayMonthMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,9})(?:\s+(\d{4}))?\b/i) ||
                          text.match(/\b([a-zA-Z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i);
    if (dayMonthMatch) {
      let dayPart = parseInt(dayMonthMatch[1]) || parseInt(dayMonthMatch[2]);
      let monthPart = (dayMonthMatch[1] && isNaN(dayMonthMatch[1])) ? dayMonthMatch[1].toLowerCase() : dayMonthMatch[2].toLowerCase();
      let yearPart = dayMonthMatch[3] ? parseInt(dayMonthMatch[3]) : currYear;

      if (monthNames[monthPart]) {
        result.dueDate = `${yearPart}-${monthNames[monthPart]}-${String(dayPart).padStart(2, '0')}`;
        result.confidence.hasDueDate = true;
      }
    }
  }

  // 5d. Relative terms: "tomorrow", "next week", "next month", "in X days"
  if (!result.dueDate) {
    if (tLower.includes('tomorrow')) {
      const target = new Date(now.getTime() + 86400000);
      result.dueDate = target.toISOString().split('T')[0];
      result.confidence.hasDueDate = true;
    } else if (tLower.includes('next week')) {
      const target = new Date(now.getTime() + 7 * 86400000);
      result.dueDate = target.toISOString().split('T')[0];
      result.confidence.hasDueDate = true;
    } else if (tLower.includes('next month')) {
      const target = new Date(now.getTime() + 30 * 86400000);
      result.dueDate = target.toISOString().split('T')[0];
      result.confidence.hasDueDate = true;
    } else {
      const inDaysMatch = text.match(/in\s+(\d+)\s*days/i);
      if (inDaysMatch) {
        const days = parseInt(inDaysMatch[1]);
        const target = new Date(now.getTime() + days * 86400000);
        result.dueDate = target.toISOString().split('T')[0];
        result.confidence.hasDueDate = true;
      }
    }
  }

  // 5e. Smart statutory fallback
  if (!result.dueDate) {
    if (result.natureOfWork.includes('GST')) {
      result.dueDate = `${currYear}-${currMonth}-20`;
    } else if (result.natureOfWork.includes('Audit')) {
      result.dueDate = `${currYear}-10-31`;
    } else {
      const target = new Date(now.getTime() + 30 * 86400000);
      result.dueDate = target.toISOString().split('T')[0];
    }
  }

  // 6. Operator / Assignment Extraction
  if (tLower.includes('assign to best') || tLower.includes('assign to top 1') || tLower.includes('assign to top staff') || tLower.includes('assign best')) {
    result.assignToBest = true;
  } else {
    const opMatch = text.match(/(?:assign(?:\s+task)?\s+to|allocate\s+to|operator\s*[:=]|give\s+(?:it\s+)?to)\s*@?([a-zA-Z0-9_]+)/i);
    if (opMatch) {
      const candOp = opMatch[1].trim().toLowerCase();
      if (!['top', 'best', 'the', 'a', 'task', 'staff'].includes(candOp)) {
        const userExists = allUsers.find(u => u.username.toLowerCase() === candOp);
        if (userExists) {
          result.operator = userExists.username.toLowerCase();
        } else {
          result.operator = candOp;
        }
      }
    }
  }

  // 7. Top-N Recommendations Extraction
  const nMatch = text.match(/(?:top|recommend|suggest)\s*(\d+)/i) ||
                 text.match(/(\d+)\s*(?:staff|candidates|recommendations|members|operators)/i);
  if (nMatch) {
    result.requestedN = parseInt(nMatch[1]);
    result.wantsRecommendation = true;
  } else if (tLower.includes('recommend') || tLower.includes('suggest staff') || tLower.includes('best staff') || tLower.includes('who should do')) {
    result.requestedN = 3; // Default to top 3 without asking
    result.wantsRecommendation = true;
  }

  // 8. Status Progression Intent Extraction
  if (tLower.includes('approve') || tLower.includes('approved')) {
    result.targetStatus = 'Approved';
  } else if (tLower.includes('file') || tLower.includes('mark filed') || tLower.includes('mark as filed')) {
    result.targetStatus = 'Filed';
  } else if (tLower.includes('review') || tLower.includes('pending review') || tLower.includes('submit for review')) {
    result.targetStatus = 'Pending Review';
  } else if (tLower.includes('reject') || tLower.includes('send back') || tLower.includes('rework') || tLower.includes('correction')) {
    result.targetStatus = 'Rework';
  }

  return result;
}

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const {
      message = '',
      action = '',
      clientCode,
      clientName,
      natureOfWork,
      assessmentYear,
      dueDate,
      operator,
      taskId,
      targetStatus,
      limit
    } = req.body || {};

    const isAdmin = checkRole(decoded, ['partner']);
    const query = String(message || '').trim();
    const queryLower = query.toLowerCase();

    const { db } = await connectToDatabase();
    const clientsCol = db.collection('clients');
    const tasksCol = db.collection('tasks');
    const attendanceCol = db.collection('attendance');
    const usersCol = db.collection('users');
    const engagementsCol = db.collection('engagements');

    // =========================================================================
    // EXPLICIT ACTION HANDLERS (Invoked by UI buttons or structured chatbot cards)
    // =========================================================================

    // 1. Action: CREATE_TASK
    if (action === 'create_task') {
      if (!isAdmin) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only can create tasks.' });
      }

      if (!clientCode || !clientName || !natureOfWork || !dueDate) {
        return res.status(400).json({ success: false, message: 'Client Code, Client Name, Nature of Work, and Due Date are required.' });
      }

      const cCodeClean = String(clientCode).trim();
      const cNameClean = String(clientName).trim();
      const natureClean = String(natureOfWork).trim();
      const isGst = isGstWorkCheck(natureClean);
      const ayClean = isGst ? '' : (assessmentYear ? String(assessmentYear).trim() : '');
      const assignedOp = operator ? String(operator).trim().toLowerCase() : '';

      // Check duplicates
      const dupQuery = {
        clientCode: cCodeClean,
        natureOfWork: natureClean,
        currentStatus: { $ne: 'Filed' }
      };
      if (ayClean) dupQuery.assessmentYear = ayClean;
      const existingTask = await tasksCol.findOne(dupQuery);
      if (existingTask) {
        return res.status(200).json({
          success: false,
          reply: `⚠️ **Duplicate Task Blocked**: An active task for **${cNameClean}** (#${cCodeClean}) for **${natureClean}** is already open (Status: *${existingTask.currentStatus}*, Assigned: @${existingTask.workTakenBy || 'Unassigned'}, Task ID: #${existingTask.id}).`,
          task: existingTask
        });
      }

      const nowStr = new Date().toISOString().split('T')[0];
      const newTask = {
        id: Date.now(),
        clientCode: cCodeClean,
        clientName: cNameClean,
        natureOfWork: natureClean,
        assessmentYear: ayClean,
        dateReceived: nowStr,
        dueDate: dueDate,
        currentStatus: assignedOp ? 'Assigned' : 'Unassigned',
        workTakenBy: assignedOp,
        workTakenOn: assignedOp ? nowStr : '',
        sendBackCount: 0,
        reasonForPending: ''
      };

      await tasksCol.insertOne(newTask);
      await logAuditAction(db, decoded.username, 'CREATE_TASK_CHAT', {
        taskId: newTask.id,
        clientName: newTask.clientName,
        natureOfWork: newTask.natureOfWork,
        operator: newTask.workTakenBy
      });

      let replyMsg = `✅ **Task #${newTask.id} Created Successfully!**\n- **Client**: [${cCodeClean}] ${cNameClean}\n- **Work**: ${natureClean}${ayClean ? ` (AY: ${ayClean})` : ''}\n- **Due Date**: \`${dueDate}\`\n- **Status**: **${newTask.currentStatus}** ${assignedOp ? `(Assigned to @${assignedOp})` : ''}\n\n`;

      let chips = [];
      if (!assignedOp) {
        replyMsg += `Would you like me to recommend the best staff for this task?`;
        chips = [
          { label: '⭐ Recommend Top 3 Staff', action: 'recommend_staff', params: { clientCode: cCodeClean, natureOfWork: natureClean, limit: 3, taskId: newTask.id } },
          { label: '⭐ Recommend Top 5 Staff', action: 'recommend_staff', params: { clientCode: cCodeClean, natureOfWork: natureClean, limit: 5, taskId: newTask.id } }
        ];
      } else {
        replyMsg += `Task is assigned. You can proceed with its status when work progresses.`;
        chips = [
          { label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: newTask.id, targetStatus: 'Pending Review' } }
        ];
      }

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        task: newTask,
        chips
      });
    }

    // 2. Action: RECOMMEND_STAFF
    if (action === 'recommend_staff') {
      const nLimit = parseInt(limit || '3') || 3;
      const recs = await computeRecommendations(db, {
        clientCode: clientCode || '',
        natureOfWork: natureOfWork || '',
        limit: nLimit
      });

      if (recs.length === 0) {
        return res.status(200).json({
          success: true,
          reply: `No eligible staff members found in the directory.`,
          recommendations: []
        });
      }

      let replyMsg = `### 🎯 Top ${recs.length} Recommended Staff\n`;
      if (natureOfWork || clientCode) {
        replyMsg += `*(Matched for **${natureOfWork || 'General Tax'}** | Client: \`#${clientCode || 'N/A'}\`)*\n\n`;
      }

      recs.forEach((r, idx) => {
        const attBadge = r.attendanceStatus === 'Present' ? '🟢 Present' : (r.attendanceStatus === 'Absent' ? '🔴 Absent' : '⚪ ' + r.attendanceStatus);
        replyMsg += `**${idx + 1}. ${r.name}** (@${r.username}) — **${r.score}% Match** [${attBadge}]\n`;
        replyMsg += `  - *Role*: ${r.role} | *Active load*: ${r.activeTasks} task(s)\n`;
        if (r.reasons && r.reasons.length > 0) {
          replyMsg += `  - *Highlights*: ${r.reasons.join(', ')}\n`;
        }
        replyMsg += `\n`;
      });

      // Interactive assignment chips
      const chips = recs.map(r => ({
        label: `Assign to @${r.username}`,
        action: 'assign_task',
        params: { taskId: taskId || null, operator: r.username, clientCode, natureOfWork }
      }));

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        recommendations: recs,
        chips
      });
    }

    // 3. Action: ASSIGN_TASK
    if (action === 'assign_task') {
      if (!isAdmin) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only can assign tasks.' });
      }

      const opUsername = String(operator || '').trim().toLowerCase();
      if (!opUsername) {
        return res.status(400).json({ success: false, message: 'Operator username is required.' });
      }

      const opUser = await usersCol.findOne({ username: opUsername });
      if (!opUser) {
        return res.status(404).json({ success: false, message: `Staff user @${opUsername} not found.` });
      }

      let targetTask = null;
      if (taskId) {
        targetTask = await tasksCol.findOne({ id: parseInt(taskId) });
      } else if (clientCode && natureOfWork) {
        targetTask = await tasksCol.findOne({
          clientCode: String(clientCode),
          natureOfWork: String(natureOfWork),
          currentStatus: { $in: ['Unassigned', 'Assigned'] }
        });
      }

      if (!targetTask) {
        return res.status(404).json({ success: false, message: 'No matching active task found to assign.' });
      }

      const todayStr = new Date().toISOString().split('T')[0];
      await tasksCol.updateOne(
        { id: targetTask.id },
        {
          $set: {
            workTakenBy: opUsername,
            workTakenOn: todayStr,
            currentStatus: 'Assigned'
          }
        }
      );

      const updatedTask = await tasksCol.findOne({ id: targetTask.id });
      await logAuditAction(db, decoded.username, 'ASSIGN_TASK_CHAT', {
        taskId: updatedTask.id,
        operator: opUsername,
        clientName: updatedTask.clientName
      });

      const replyMsg = `✅ **Task #${updatedTask.id} Assigned to ${opUser.name} (@${opUsername})**\n- **Client**: ${updatedTask.clientName}\n- **Nature**: ${updatedTask.natureOfWork}\n- **Current Status**: **Assigned**\n- **Assigned On**: \`${todayStr}\`\n\nWould you like to advance or review this task's status?`;

      const chips = [
        { label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: updatedTask.id, targetStatus: 'Pending Review' } },
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
      ];

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        task: updatedTask,
        chips
      });
    }

    // 4. Action: ADVANCE_STATUS
    if (action === 'advance_status') {
      if (!taskId) {
        return res.status(400).json({ success: false, message: 'Task ID is required.' });
      }

      const tId = parseInt(taskId);
      const existingTask = await tasksCol.findOne({ id: tId });
      if (!existingTask) {
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }

      let nextStatus = targetStatus;

      if (!nextStatus) {
        switch (existingTask.currentStatus) {
          case 'Unassigned':
            return res.status(200).json({
              success: false,
              reply: `Task #${tId} is currently **Unassigned**. Assign an operator before advancing status.`,
              chips: [
                { label: '⭐ Recommend Top 3 Staff', action: 'recommend_staff', params: { taskId: tId, clientCode: existingTask.clientCode, natureOfWork: existingTask.natureOfWork, limit: 3 } }
              ]
            });
          case 'Assigned':
            nextStatus = 'Pending Review';
            break;
          case 'Pending Review':
            if (isAdmin) nextStatus = 'Approved';
            else nextStatus = 'Pending Review';
            break;
          case 'Approved':
            nextStatus = 'Filed';
            break;
          case 'Filed':
            return res.status(200).json({
              success: true,
              reply: `Task #${tId} is already **Filed** and locked.`
            });
          default:
            nextStatus = 'Pending Review';
        }
      }

      if (nextStatus === 'Approved' && !isAdmin) {
        return res.status(403).json({ success: false, message: 'Only Partners can approve tasks.' });
      }

      let updateDoc = { currentStatus: nextStatus };
      if (targetStatus === 'Reject' || targetStatus === 'Rework') {
        nextStatus = 'Assigned';
        updateDoc = {
          currentStatus: 'Assigned',
          sendBackCount: (existingTask.sendBackCount || 0) + 1
        };
      }

      await tasksCol.updateOne({ id: tId }, { $set: updateDoc });
      const updatedTask = await tasksCol.findOne({ id: tId });

      await logAuditAction(db, decoded.username, 'STATUS_CHANGE_CHAT', {
        taskId: tId,
        fromStatus: existingTask.currentStatus,
        toStatus: updatedTask.currentStatus,
        operator: updatedTask.workTakenBy
      });

      let replyMsg = `🔄 **Task #${tId} Status Updated!**\n- **Client**: ${updatedTask.clientName}\n- **Work**: ${updatedTask.natureOfWork}\n- **Operator**: @${updatedTask.workTakenBy || 'Unassigned'}\n- **New Status**: **${updatedTask.currentStatus}**\n\n`;

      const nextChips = [];
      if (updatedTask.currentStatus === 'Assigned') {
        replyMsg += `Work is in progress with @${updatedTask.workTakenBy}.`;
        nextChips.push({ label: '⏩ Submit for Review', action: 'advance_status', params: { taskId: tId, targetStatus: 'Pending Review' } });
      } else if (updatedTask.currentStatus === 'Pending Review' && isAdmin) {
        replyMsg += `Task is awaiting partner review verdict:`;
        nextChips.push({ label: '✅ Approve Task', action: 'advance_status', params: { taskId: tId, targetStatus: 'Approved' } });
        nextChips.push({ label: '❌ Send Back for Correction', action: 'advance_status', params: { taskId: tId, targetStatus: 'Rework' } });
      } else if (updatedTask.currentStatus === 'Approved') {
        replyMsg += `Task is partner-approved and ready for portal filing!`;
        nextChips.push({ label: '🏛️ Mark as Filed', action: 'advance_status', params: { taskId: tId, targetStatus: 'Filed' } });
      } else if (updatedTask.currentStatus === 'Filed') {
        replyMsg += `🎉 Task completed and successfully filed on portal.`;
      }

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        task: updatedTask,
        chips: nextChips
      });
    }

    // =========================================================================
    // NATURAL LANGUAGE CONVERSATIONAL PROCESSING (ONE-SHOT UNSTRUCTURED PARSING)
    // =========================================================================

    const allClients = await clientsCol.find({ status: { $ne: 'Inactive' } }).limit(500).toArray();
    const allUsers = await usersCol.find({}).toArray();
    const allEngagements = (await engagementsCol.find({}).toArray()).map(e => e.title);

    // Extract all parameters in one pass from unstructured paragraph/sentence
    const parsed = parseUnstructuredTaskParameters(query, allClients, allUsers, allEngagements);

    const isTaskCreationOrIntent = queryLower.includes('create task') ||
                                   queryLower.includes('new task') ||
                                   queryLower.includes('add task') ||
                                   queryLower.includes('register task') ||
                                   queryLower.includes('inward task') ||
                                   queryLower.includes('create a task') ||
                                   queryLower.startsWith('create ') ||
                                   queryLower.startsWith('register ') ||
                                   (parsed.confidence.hasClient && (parsed.confidence.hasNature || queryLower.includes('task')));

    // Case 1: Status Progression Intent on existing task
    if (parsed.taskId && parsed.targetStatus) {
      const existingTask = await tasksCol.findOne({ id: parsed.taskId });
      if (existingTask) {
        let updateDoc = { currentStatus: parsed.targetStatus };
        if (parsed.targetStatus === 'Rework') {
          updateDoc = { currentStatus: 'Assigned', sendBackCount: (existingTask.sendBackCount || 0) + 1 };
        }
        await tasksCol.updateOne({ id: parsed.taskId }, { $set: updateDoc });
        const updated = await tasksCol.findOne({ id: parsed.taskId });

        await logAuditAction(db, decoded.username, 'STATUS_CHANGE_NL', {
          taskId: parsed.taskId,
          status: updated.currentStatus
        });

        return res.status(200).json({
          success: true,
          reply: `🔄 **Task #${updated.id} Status Updated to "${updated.currentStatus}"**\n- **Client**: ${updated.clientName}\n- **Nature**: ${updated.natureOfWork}\n- **Operator**: @${updated.workTakenBy || 'Unassigned'}`,
          task: updated,
          chips: [
            { label: '⏩ Advance Status', action: 'advance_status', params: { taskId: updated.id } },
            { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
          ]
        });
      }
    }

    // Case 2: Assignment Intent on existing task or inferred task
    if (parsed.operator && (queryLower.includes('assign') || queryLower.includes('allocate')) && !isTaskCreationOrIntent) {
      let targetTask = null;
      if (parsed.taskId) {
        targetTask = await tasksCol.findOne({ id: parsed.taskId });
      } else if (parsed.clientCode) {
        targetTask = await tasksCol.findOne({ clientCode: parsed.clientCode, currentStatus: { $in: ['Unassigned', 'Assigned'] } });
      }

      if (targetTask) {
        const todayStr = new Date().toISOString().split('T')[0];
        await tasksCol.updateOne({ id: targetTask.id }, { $set: { workTakenBy: parsed.operator, workTakenOn: todayStr, currentStatus: 'Assigned' } });
        const updated = await tasksCol.findOne({ id: targetTask.id });

        return res.status(200).json({
          success: true,
          reply: `✅ **Task #${updated.id} Assigned to @${parsed.operator}**\n- **Client**: ${updated.clientName}\n- **Nature**: ${updated.natureOfWork}\n- **Current Status**: **Assigned**`,
          task: updated,
          chips: [
            { label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: updated.id, targetStatus: 'Pending Review' } }
          ]
        });
      }
    }

    // Case 3: ONE-SHOT TASK CREATION & ALLOCATION FROM UNSTRUCTURED PARAGRAPH
    if (isTaskCreationOrIntent && isAdmin) {
      // If client couldn't be extracted, pick first matching or show structured prompt
      if (!parsed.clientName) {
        parsed.clientName = 'Client (Pending Name)';
        parsed.clientCode = String(Date.now()).slice(-5);
      }

      const clientCodeClean = parsed.clientCode || String(Date.now()).slice(-5);
      const clientNameClean = parsed.clientName;
      const natureClean = parsed.natureOfWork || 'GST Monthly Return';
      const isGst = isGstWorkCheck(natureClean);
      const ayClean = isGst ? '' : (parsed.assessmentYear || '');
      const dueDateClean = parsed.dueDate;

      // Duplicate check
      const dupQuery = {
        clientCode: clientCodeClean,
        natureOfWork: natureClean,
        currentStatus: { $ne: 'Filed' }
      };
      if (ayClean) dupQuery.assessmentYear = ayClean;
      const existingTask = await tasksCol.findOne(dupQuery);

      if (existingTask) {
        return res.status(200).json({
          success: false,
          reply: `⚠️ **Active Task Already Exists**\n\nTask **#${existingTask.id}** for **${clientNameClean}** (${natureClean}) is already active in status **${existingTask.currentStatus}** (Assigned: @${existingTask.workTakenBy || 'Unassigned'}).`,
          task: existingTask,
          chips: [
            { label: `⚙️ Manage Task #${existingTask.id}`, action: 'prompt_text', text: `Proceed status of task #${existingTask.id}` },
            { label: '⭐ Recommend Staff', action: 'recommend_staff', params: { taskId: existingTask.id, clientCode: clientCodeClean, natureOfWork: natureClean, limit: 3 } }
          ]
        });
      }

      // Compute Top-N Recommendations if requested or if user wanted auto-assign
      let topCandidates = [];
      let assignedOperator = parsed.operator || '';

      const recLimit = parsed.requestedN || 3;
      topCandidates = await computeRecommendations(db, {
        clientCode: clientCodeClean,
        natureOfWork: natureClean,
        limit: recLimit
      });

      // If user said "assign to top 1" or "assign to best", pick #1 scored candidate!
      if (parsed.assignToBest && topCandidates.length > 0) {
        assignedOperator = topCandidates[0].username;
      }

      // If user specified an operator that exists in top candidates
      const nowStr = new Date().toISOString().split('T')[0];
      const initialStatus = assignedOperator ? (parsed.targetStatus === 'Pending Review' ? 'Pending Review' : 'Assigned') : 'Unassigned';

      const newTask = {
        id: Date.now(),
        clientCode: clientCodeClean,
        clientName: clientNameClean,
        natureOfWork: natureClean,
        assessmentYear: ayClean,
        dateReceived: nowStr,
        dueDate: dueDateClean,
        currentStatus: initialStatus,
        workTakenBy: assignedOperator,
        workTakenOn: assignedOperator ? nowStr : '',
        sendBackCount: 0,
        reasonForPending: ''
      };

      await tasksCol.insertOne(newTask);
      await logAuditAction(db, decoded.username, 'CREATE_TASK_ONE_SHOT', {
        taskId: newTask.id,
        clientName: newTask.clientName,
        natureOfWork: newTask.natureOfWork,
        operator: newTask.workTakenBy,
        sourceText: query
      });

      // Build Rich Markdown Response with Extracted Structured Parameters
      let replyMsg = `### 📋 Task Created Successfully (#${newTask.id})\n\n`;
      replyMsg += `**Structured Parameters Extracted:**\n`;
      replyMsg += `- 🏢 **Client**: [#${newTask.clientCode}] **${newTask.clientName}**\n`;
      replyMsg += `- 📂 **Nature of Work**: **${newTask.natureOfWork}**\n`;
      if (newTask.assessmentYear) {
        replyMsg += `- 📅 **Assessment Year**: \`${newTask.assessmentYear}\`\n`;
      }
      replyMsg += `- ⏰ **Due Date**: \`${newTask.dueDate}\`\n`;
      replyMsg += `- 🚦 **Current Status**: **${newTask.currentStatus}**\n`;
      if (assignedOperator) {
        replyMsg += `- 👤 **Assigned Operator**: **@${assignedOperator}**\n`;
      } else {
        replyMsg += `- 👤 **Assigned Operator**: *Unassigned*\n`;
      }
      replyMsg += `\n`;

      const chips = [];

      // Append Top-N Recommendations evaluation
      if (topCandidates.length > 0) {
        replyMsg += `### 🎯 Top ${topCandidates.length} Matched Staff Evaluation:\n`;
        topCandidates.forEach((r, idx) => {
          const attBadge = r.attendanceStatus === 'Present' ? '🟢 Present' : (r.attendanceStatus === 'Absent' ? '🔴 Absent' : '⚪ ' + r.attendanceStatus);
          const isSelected = r.username.toLowerCase() === assignedOperator.toLowerCase();
          replyMsg += `**${idx + 1}. ${r.name}** (@${r.username}) — **${r.score}% Match** [${attBadge}] ${isSelected ? '✅ *(Assigned)*' : ''}\n`;
          replyMsg += `  - *Role*: ${r.role} | *Active Queue*: ${r.activeTasks} task(s)\n`;
          if (r.reasons && r.reasons.length > 0) {
            replyMsg += `  - *Why*: ${r.reasons.join(', ')}\n`;
          }
          replyMsg += `\n`;

          if (!assignedOperator) {
            chips.push({
              label: `Assign @${r.username} (${r.score}%)`,
              action: 'assign_task',
              params: { taskId: newTask.id, operator: r.username, clientCode: newTask.clientCode, natureOfWork: newTask.natureOfWork }
            });
          }
        });
      }

      if (assignedOperator) {
        chips.push({ label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: newTask.id, targetStatus: 'Pending Review' } });
        chips.push({ label: '✅ Approve Task', action: 'advance_status', params: { taskId: newTask.id, targetStatus: 'Approved' } });
      }

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        task: newTask,
        chips
      });
    }

    // Case 4: Standalone Recommendation Intent (e.g., "recommend top 5 staff for GST return")
    if (parsed.wantsRecommendation) {
      const recLimit = parsed.requestedN || 3;
      const recs = await computeRecommendations(db, {
        clientCode: parsed.clientCode || '',
        natureOfWork: parsed.natureOfWork || '',
        limit: recLimit
      });

      let replyMsg = `### 🎯 Top ${recs.length} Recommended Staff:\n`;
      if (parsed.natureOfWork || parsed.clientName) {
        replyMsg += `*(Target: **${parsed.natureOfWork || 'General Tax'}** | Client: **${parsed.clientName || 'General'}**)*\n\n`;
      }

      recs.forEach((r, idx) => {
        const attBadge = r.attendanceStatus === 'Present' ? '🟢 Present' : (r.attendanceStatus === 'Absent' ? '🔴 Absent' : '⚪ ' + r.attendanceStatus);
        replyMsg += `**${idx + 1}. ${r.name}** (@${r.username}) — **${r.score}% Match** [${attBadge}]\n`;
        replyMsg += `  - *Load*: ${r.activeTasks} task(s) | *Role*: ${r.role}\n`;
        if (r.reasons && r.reasons.length > 0) {
          replyMsg += `  - *Highlights*: ${r.reasons.join(', ')}\n`;
        }
        replyMsg += `\n`;
      });

      const chips = recs.map(r => ({
        label: `Create & Assign @${r.username}`,
        action: 'create_task',
        params: {
          clientCode: parsed.clientCode || String(Date.now()).slice(-5),
          clientName: parsed.clientName || 'General Client',
          natureOfWork: parsed.natureOfWork || 'GST Monthly Return',
          assessmentYear: parsed.assessmentYear || '',
          dueDate: parsed.dueDate,
          operator: r.username
        }
      }));

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        recommendations: recs,
        chips
      });
    }

    // =========================================================================
    // GENERAL SEARCH & RAG (Clients, Tasks, Attendance, Google Drive)
    // =========================================================================

    let recordsFound = {
      clients: [],
      tasks: [],
      attendance: [],
      driveFiles: []
    };

    const clientRegex = { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const matchedClients = await clientsCol.find({
      $or: [
        { name: clientRegex },
        { pan: clientRegex },
        { contact: clientRegex },
        { gstNumber: clientRegex },
        { id: isNaN(query) ? -999999 : Number(query) }
      ]
    }).limit(5).toArray();
    recordsFound.clients = matchedClients;

    let taskConditions = [
      { clientName: clientRegex },
      { clientCode: clientRegex },
      { natureOfWork: clientRegex },
      { workTakenBy: clientRegex }
    ];

    if (queryLower.includes('pending') || queryLower.includes('open') || queryLower.includes('active')) {
      taskConditions.push({ currentStatus: { $in: ['Assigned', 'Pending Review', 'Approved'] } });
    }
    if (queryLower.includes('review')) {
      taskConditions.push({ currentStatus: 'Pending Review' });
    }
    if (queryLower.includes('filed') || queryLower.includes('completed') || queryLower.includes('done')) {
      taskConditions.push({ currentStatus: 'Filed' });
    }
    if (queryLower.includes('unassigned')) {
      taskConditions.push({ currentStatus: 'Unassigned' });
    }

    let taskQuery = { $or: taskConditions };
    if (!isAdmin) {
      taskQuery = { $and: [{ workTakenBy: decoded.username }, { $or: taskConditions }] };
    }

    const matchedTasks = await tasksCol.find(taskQuery).sort({ dateReceived: -1 }).limit(8).toArray();
    recordsFound.tasks = matchedTasks;

    if (queryLower.includes('attend') || queryLower.includes('present') || queryLower.includes('absent') || queryLower.includes('clock') || queryLower.includes('od')) {
      const todayIST = (() => {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const ist = new Date(utc + (3600000 * 5.5));
        return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
      })();

      let attQuery = { date: todayIST };
      if (!isAdmin) {
        attQuery.username = decoded.username;
      }
      recordsFound.attendance = await attendanceCol.find(attQuery).limit(10).toArray();
    }

    // Google Drive RAG
    try {
      const driveConfigDoc = await db.collection('settings').findOne({ key: 'google_drive_config' });
      if (driveConfigDoc && driveConfigDoc.credentials) {
        let driveKeywords = query;
        if (matchedClients.length > 0) driveKeywords = String(matchedClients[0].id);

        const crypto = require('crypto');
        const nowSec = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const claimSet = {
          iss: driveConfigDoc.credentials.client_email,
          scope: 'https://www.googleapis.com/auth/drive.readonly',
          aud: 'https://oauth2.googleapis.com/token',
          exp: nowSec + 3600,
          iat: nowSec
        };
        const base64UrlEncode = (str) => Buffer.from(str).toString('base64url');
        const encodedHeader = base64UrlEncode(JSON.stringify(header));
        const encodedClaim = base64UrlEncode(JSON.stringify(claimSet));
        const unsignedToken = `${encodedHeader}.${encodedClaim}`;
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(unsignedToken);
        signer.end();
        const sig = signer.sign(driveConfigDoc.credentials.private_key.replace(/\\n/g, '\n'), 'base64url');
        const jwt = `${unsignedToken}.${sig}`;

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
          })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.access_token) {
          const listUrl = `https://www.googleapis.com/drive/v3/files?q=trashed=false and (name contains '${encodeURIComponent(driveKeywords)}')&fields=files(id,name,mimeType,webViewLink,modifiedTime)&pageSize=5`;
          const dRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
          const dData = await dRes.json();
          if (dData.files) {
            recordsFound.driveFiles = dData.files;
          }
        }
      }
    } catch (e) {
      console.warn('Google Drive RAG fetch note:', e.message);
    }

    let reply = '';
    const chips = [];

    if (recordsFound.clients.length > 0) {
      reply += `### Client Records Found:\n`;
      recordsFound.clients.forEach(c => {
        reply += `- **[#${c.id}] ${c.name}** | PAN: \`${c.pan || 'N/A'}\` | Phone: ${c.contact || 'N/A'} | Status: *${c.status || 'Active'}*\n`;
        if (isAdmin) {
          chips.push({
            label: `➕ New Task for ${c.name}`,
            action: 'prompt_text',
            text: `Create GST Monthly Return for ${c.name} (#${c.id}) due 20th next month, recommend top 3 staff`
          });
        }
      });
      reply += `\n`;
    }

    if (recordsFound.tasks.length > 0) {
      reply += `### Associated Tasks (${recordsFound.tasks.length}):\n`;
      recordsFound.tasks.forEach(t => {
        const dueText = t.dueDate ? `(Due: ${t.dueDate})` : '';
        const operatorText = t.workTakenBy ? `@${t.workTakenBy}` : 'Unassigned';
        reply += `- **#${t.id} ${t.natureOfWork}** for *${t.clientName}* [**${t.currentStatus}**] — Operator: **${operatorText}** ${dueText}\n`;

        if (isAdmin && t.currentStatus !== 'Filed') {
          chips.push({
            label: `⚙️ Manage Task #${t.id}`,
            action: 'prompt_text',
            text: `Proceed status of task #${t.id}`
          });
        }
      });
      reply += `\n`;
    }

    if (recordsFound.attendance.length > 0) {
      reply += `### Today's Attendance Status:\n`;
      recordsFound.attendance.forEach(a => {
        const inTime = a.clockIn ? new Date(a.clockIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'None';
        const outTime = a.clockOut ? new Date(a.clockOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'None';
        reply += `- **${a.name}** (@${a.username}): **${a.status}** (In: ${inTime}, Out: ${outTime})\n`;
      });
      reply += `\n`;
    }

    if (recordsFound.driveFiles.length > 0) {
      reply += `### Google Drive Vault Documents:\n`;
      recordsFound.driveFiles.forEach(f => {
        reply += `- 📄 [${f.name}](${f.webViewLink}) *(Google Drive)*\n`;
      });
      reply += `\n`;
    }

    if (!reply) {
      reply = `I could not find matching records for **"${query}"**.\n\nYou can describe any action in natural language or full paragraph, e.g.:\n- *"Create a task for Alpha Corp for GST Monthly Return period 2026-10 due 2026-11-20, recommend top 3 staff and assign to best"*`;
      if (isAdmin) {
        chips.push({ label: '➕ Create GST Task', action: 'prompt_text', text: 'Create GST Monthly Return for Alpha Corp due on 20th next month, recommend top 3 staff and assign to best' });
        chips.push({ label: '⭐ Recommend Top 3 Staff', action: 'recommend_staff', params: { limit: 3 } });
        chips.push({ label: '🕒 Check Attendance', action: 'prompt_text', text: 'Who is present today?' });
      }
    }

    return res.status(200).json({
      success: true,
      reply,
      data: recordsFound,
      chips: chips.slice(0, 6)
    });
  } catch (err) {
    console.error('Chatbot API error:', err);
    return res.status(500).json({ success: false, message: 'Chatbot error: ' + err.message });
  }
};
