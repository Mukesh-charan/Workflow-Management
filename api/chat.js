const { connectToDatabase } = require('./db');
const { verifyToken, checkRole, logAuditAction } = require('./auth');
const { computeRecommendations } = require('./recommend');

function isGstWorkCheck(natureOfWork) {
  if (!natureOfWork) return false;
  const str = String(natureOfWork).toLowerCase().trim();
  return str.includes('gst') || str.includes('cmp');
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
        // Find most recent unassigned task for this client & nature
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
      let reworkIncrement = 0;

      // Determine next status if not explicitly given
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

      // Check permissions: only partner can approve/reject
      if (nextStatus === 'Approved' && !isAdmin) {
        return res.status(403).json({ success: false, message: 'Only Partners can approve tasks.' });
      }

      let updateDoc = { currentStatus: nextStatus };
      if (targetStatus === 'Reject' || targetStatus === 'Rework') {
        nextStatus = 'Assigned';
        reworkIncrement = 1;
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
    // NATURAL LANGUAGE CONVERSATIONAL PARSING
    // =========================================================================

    // A. Detect Status Progression Intent (e.g., "approve task 123", "mark task 456 as filed", "proceed status task 789")
    const statusMatch = query.match(/(?:proceed|advance|approve|reject|send\s*back|file|mark\s*filed)\s*(?:task|job)?\s*#?(\d+)/i) ||
                        query.match(/(?:task|job)\s*#?(\d+)\s*(?:status|proceed|approve|file|reject)/i);
    if (statusMatch && (queryLower.includes('approve') || queryLower.includes('file') || queryLower.includes('reject') || queryLower.includes('proceed') || queryLower.includes('advance') || queryLower.includes('status'))) {
      const targetId = parseInt(statusMatch[1]);
      const matchedTask = await tasksCol.findOne({ id: targetId });
      if (matchedTask) {
        let desiredStatus = null;
        if (queryLower.includes('approve')) desiredStatus = 'Approved';
        else if (queryLower.includes('reject') || queryLower.includes('send back') || queryLower.includes('correction')) desiredStatus = 'Rework';
        else if (queryLower.includes('file')) desiredStatus = 'Filed';
        else if (queryLower.includes('review')) desiredStatus = 'Pending Review';

        let promptText = `Found **Task #${matchedTask.id}** for **${matchedTask.clientName}**.\n- Nature: *${matchedTask.natureOfWork}*\n- Current Status: **${matchedTask.currentStatus}**\n- Assigned to: **@${matchedTask.workTakenBy || 'Unassigned'}**\n\n`;

        const chips = [];
        if (matchedTask.currentStatus === 'Unassigned') {
          promptText += `Please assign staff to proceed.`;
          chips.push({ label: '⭐ Recommend Top 3 Staff', action: 'recommend_staff', params: { taskId: matchedTask.id, clientCode: matchedTask.clientCode, natureOfWork: matchedTask.natureOfWork, limit: 3 } });
        } else if (matchedTask.currentStatus === 'Assigned') {
          promptText += `Advance work status:`;
          chips.push({ label: '⏩ Submit for Review', action: 'advance_status', params: { taskId: matchedTask.id, targetStatus: 'Pending Review' } });
        } else if (matchedTask.currentStatus === 'Pending Review' && isAdmin) {
          promptText += `Take partner review action:`;
          chips.push({ label: '✅ Approve Task', action: 'advance_status', params: { taskId: matchedTask.id, targetStatus: 'Approved' } });
          chips.push({ label: '❌ Send Back (Rework)', action: 'advance_status', params: { taskId: matchedTask.id, targetStatus: 'Rework' } });
        } else if (matchedTask.currentStatus === 'Approved') {
          promptText += `Ready to file:`;
          chips.push({ label: '🏛️ Mark as Filed', action: 'advance_status', params: { taskId: matchedTask.id, targetStatus: 'Filed' } });
        } else if (matchedTask.currentStatus === 'Filed') {
          promptText += `Task is completed and archived.`;
        }

        return res.status(200).json({
          success: true,
          reply: promptText,
          task: matchedTask,
          chips
        });
      }
    }

    // B. Detect Assignment Intent (e.g., "assign task 123 to rahul", "assign to @ramesh")
    const assignMatch = query.match(/assign\s*(?:task\s*#?(\d+))?\s*(?:to\s*@?([a-zA-Z0-9_]+))/i) ||
                        query.match(/allocate\s*(?:task\s*#?(\d+))?\s*(?:to\s*@?([a-zA-Z0-9_]+))/i);
    if (assignMatch && isAdmin) {
      const tId = assignMatch[1] ? parseInt(assignMatch[1]) : null;
      const targetOp = assignMatch[2] ? assignMatch[2].toLowerCase() : '';

      if (targetOp) {
        const staffUser = await usersCol.findOne({ username: targetOp });
        if (staffUser) {
          let chosenTask = null;
          if (tId) chosenTask = await tasksCol.findOne({ id: tId });
          else chosenTask = await tasksCol.findOne({ currentStatus: 'Unassigned' });

          if (chosenTask) {
            const todayStr = new Date().toISOString().split('T')[0];
            await tasksCol.updateOne({ id: chosenTask.id }, { $set: { workTakenBy: targetOp, workTakenOn: todayStr, currentStatus: 'Assigned' } });
            const updated = await tasksCol.findOne({ id: chosenTask.id });

            return res.status(200).json({
              success: true,
              reply: `✅ **Task #${updated.id} Assigned to ${staffUser.name} (@${targetOp})**\n- Client: **${updated.clientName}**\n- Nature: *${updated.natureOfWork}*\n- Status: **Assigned**\n\nNext step: operator prepares filing and submits for review.`,
              task: updated,
              chips: [
                { label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: updated.id, targetStatus: 'Pending Review' } }
              ]
            });
          }
        }
      }
    }

    // C. Detect Staff Recommendation Intent (e.g., "recommend top 3 staff", "recommend 5 staff", "suggest staff")
    const isRecommendQuery = queryLower.includes('recommend') || queryLower.includes('suggest staff') || queryLower.includes('best staff') || queryLower.includes('who should do');
    if (isRecommendQuery) {
      // Extract N (Top N)
      const numMatch = query.match(/(?:top|recommend|suggest)\s*(\d+)/i) || query.match(/(\d+)\s*(?:staff|candidates|operators|members)/i);
      let requestedN = numMatch ? parseInt(numMatch[1]) : null;

      // Check if client / task context is present in query
      let matchedClientForRec = null;
      const clientKeywords = query.replace(/(?:recommend|suggest|top|\d+|staff|candidates|for|doing|task|the)/gi, '').trim();
      if (clientKeywords.length >= 2) {
        matchedClientForRec = await clientsCol.findOne({
          $or: [
            { name: { $regex: clientKeywords, $options: 'i' } },
            { id: isNaN(clientKeywords) ? -999999 : Number(clientKeywords) }
          ]
        });
      }

      if (!requestedN) {
        // Ask Admin explicitly for N input as requested by user
        return res.status(200).json({
          success: true,
          reply: `🤖 **Staff Allocation Intelligence**\n\nHow many top staff recommendations would you like to see for this task?\n\nSelect an option below or type e.g. *"Recommend top 4 staff"*:`,
          chips: [
            { label: '⭐ Top 3 Staff', action: 'recommend_staff', params: { clientCode: matchedClientForRec ? String(matchedClientForRec.id) : '', limit: 3 } },
            { label: '⭐ Top 5 Staff', action: 'recommend_staff', params: { clientCode: matchedClientForRec ? String(matchedClientForRec.id) : '', limit: 5 } },
            { label: '⭐ Top 10 Staff', action: 'recommend_staff', params: { clientCode: matchedClientForRec ? String(matchedClientForRec.id) : '', limit: 10 } }
          ]
        });
      }

      const recs = await computeRecommendations(db, {
        clientCode: matchedClientForRec ? String(matchedClientForRec.id) : '',
        natureOfWork: queryLower.includes('gst') ? 'GST Monthly Return' : (queryLower.includes('it') ? 'IT Return' : ''),
        limit: requestedN
      });

      let replyMsg = `### 🎯 Top ${recs.length} Recommended Staff\n`;
      recs.forEach((r, idx) => {
        const attBadge = r.attendanceStatus === 'Present' ? '🟢 Present' : (r.attendanceStatus === 'Absent' ? '🔴 Absent' : '⚪ ' + r.attendanceStatus);
        replyMsg += `**${idx + 1}. ${r.name}** (@${r.username}) — **${r.score}% Match** [${attBadge}]\n`;
        replyMsg += `  - *Role*: ${r.role} | *Active load*: ${r.activeTasks} task(s)\n`;
        if (r.reasons && r.reasons.length > 0) {
          replyMsg += `  - *Highlights*: ${r.reasons.join(', ')}\n`;
        }
        replyMsg += `\n`;
      });

      const chips = recs.map(r => ({
        label: `Assign to @${r.username}`,
        action: 'assign_task',
        params: { operator: r.username, clientCode: matchedClientForRec ? String(matchedClientForRec.id) : '' }
      }));

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        recommendations: recs,
        chips
      });
    }

    // D. Detect Task Creation Intent (e.g., "create task for Ramesh", "new task", "create a task")
    const isCreateIntent = queryLower.includes('create task') ||
                          queryLower.includes('new task') ||
                          queryLower.includes('add task') ||
                          queryLower.includes('register task') ||
                          queryLower.includes('create a task') ||
                          queryLower.startsWith('create ') ||
                          queryLower.startsWith('inward ');

    if (isCreateIntent && isAdmin) {
      // 1. Try to find client from query
      let matchedClient = null;
      const allClients = await clientsCol.find({ status: { $ne: 'Inactive' } }).limit(200).toArray();
      for (const c of allClients) {
        if (queryLower.includes(c.name.toLowerCase()) || query.includes(String(c.id))) {
          matchedClient = c;
          break;
        }
      }

      // 2. Try to identify nature of work
      let nature = '';
      if (queryLower.includes('gst monthly') || queryLower.includes('gstr') || queryLower.includes('gst return') || queryLower.includes('gst')) {
        nature = 'GST Monthly Return';
      } else if (queryLower.includes('it return') || queryLower.includes('itr') || queryLower.includes('income tax')) {
        nature = 'IT Return';
      } else if (queryLower.includes('tax audit') || queryLower.includes('audit')) {
        nature = 'Tax Audit';
      } else if (queryLower.includes('tds')) {
        nature = 'TDS Return';
      } else if (queryLower.includes('roc') || queryLower.includes('mca')) {
        nature = 'ROC Filing';
      }

      // If client is missing, ask Admin for client
      if (!matchedClient) {
        const top5Clients = allClients.slice(0, 5);
        const clientChips = top5Clients.map(c => ({
          label: `#${c.id} ${c.name}`,
          action: 'prompt_text',
          text: `Create task for ${c.name} (#${c.id})`
        }));

        return res.status(200).json({
          success: true,
          reply: `📋 **Create New Task — Step 1: Select Client**\n\nWhich client is this task for? Please type the Client Name or Client Code (e.g., *"Create task for Ramesh"*), or pick from active clients below:`,
          chips: clientChips
        });
      }

      // If nature is missing, ask Admin for nature of work
      if (!nature) {
        return res.status(200).json({
          success: true,
          reply: `📋 **Create Task for [${matchedClient.id}] ${matchedClient.name}**\n\nWhat is the Nature of Work for this task?`,
          chips: [
            { label: 'GST Monthly Return', action: 'prompt_text', text: `Create GST Monthly Return for ${matchedClient.name} (#${matchedClient.id})` },
            { label: 'IT Return', action: 'prompt_text', text: `Create IT Return for ${matchedClient.name} (#${matchedClient.id})` },
            { label: 'Tax Audit', action: 'prompt_text', text: `Create Tax Audit for ${matchedClient.name} (#${matchedClient.id})` },
            { label: 'TDS Return', action: 'prompt_text', text: `Create TDS Return for ${matchedClient.name} (#${matchedClient.id})` }
          ]
        });
      }

      // Calculate sensible defaults
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
      const defaultAY = `${currentYear}-${(currentYear + 1).toString().slice(-2)}`;
      const defaultDueDate = nature.includes('GST') ? `${currentYear}-${currentMonth}-20` : `${currentYear}-10-31`;

      const draftTask = {
        clientCode: String(matchedClient.id),
        clientName: matchedClient.name,
        natureOfWork: nature,
        assessmentYear: isGstWorkCheck(nature) ? '' : defaultAY,
        dueDate: defaultDueDate
      };

      const replyMsg = `📝 **Draft Task Prepared**:\n- **Client**: [#${draftTask.clientCode}] **${draftTask.clientName}**\n- **Nature of Work**: **${draftTask.natureOfWork}**\n- **Period / AY**: \`${draftTask.assessmentYear || 'Current Period'}\`\n- **Due Date**: \`${draftTask.dueDate}\`\n\nHow would you like to proceed?`;

      const chips = [
        {
          label: '⭐ Recommend Top 3 Staff & Assign',
          action: 'recommend_staff',
          params: { clientCode: draftTask.clientCode, natureOfWork: draftTask.natureOfWork, limit: 3 }
        },
        {
          label: '⭐ Recommend Top 5 Staff & Assign',
          action: 'recommend_staff',
          params: { clientCode: draftTask.clientCode, natureOfWork: draftTask.natureOfWork, limit: 5 }
        },
        {
          label: '➕ Create as Unassigned',
          action: 'create_task',
          params: draftTask
        }
      ];

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        draft: draftTask,
        chips
      });
    }

    // =========================================================================
    // E. GENERAL SEARCH & RAG (Clients, Tasks, Attendance, Google Drive)
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

    // Query Google Drive if keywords match
    try {
      const driveConfigDoc = await db.collection('settings').findOne({ key: 'google_drive_config' });
      if (driveConfigDoc && driveConfigDoc.credentials) {
        let driveKeywords = query;
        if (matchedClients.length > 0) driveKeywords = String(matchedClients[0].id);

        const crypto = require('crypto');
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const claimSet = {
          iss: driveConfigDoc.credentials.client_email,
          scope: 'https://www.googleapis.com/auth/drive.readonly',
          aud: 'https://oauth2.googleapis.com/token',
          exp: now + 3600,
          iat: now
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
            text: `Create task for ${c.name} (#${c.id})`
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
      reply = `I could not find matching records for **"${query}"**.\n\nYou can ask me to:\n- 📝 *"Create a task for [Client Name]"*\n- ⭐ *"Recommend top 3 staff for GST return"*\n- 🔄 *"Proceed status of task #12345"*`;
      if (isAdmin) {
        chips.push({ label: '➕ Create New Task', action: 'prompt_text', text: 'Create a new task' });
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
