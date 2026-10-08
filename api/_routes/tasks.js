const { connectToDatabase } = require('./db');
const { verifyToken, checkRole, logAuditAction } = require('./auth');

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    const { db } = await connectToDatabase();
    const tasksCollection = db.collection('tasks');

    // 1. GET: Fetch tasks with filtering and pagination
    if (req.method === 'GET') {
        if (!checkRole(decoded, ['partner', 'staff', 'article'])) {
            return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges.' });
        }
        try {
            await generateAutoGstTasks(db);
        } catch (err) {
            console.error('Error generating automatic GST tasks:', err);
        }

        const { status, search, operator, page, limit, mode } = req.query;

        // Stats mode for analytics dashboard
        if (mode === 'stats') {
            const statusCounts = await tasksCollection.aggregate([
                { $group: { _id: '$currentStatus', count: { $sum: 1 } } }
            ]).toArray();
            const operatorCounts = await tasksCollection.aggregate([
                { $match: { currentStatus: { $nin: ['Filed', 'Unassigned'] } } },
                { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
            ]).toArray();
            const leaderboard = await tasksCollection.aggregate([
                { $match: { currentStatus: 'Filed' } },
                { $group: { _id: '$workTakenBy', totalFiled: { $sum: 1 }, totalReworks: { $sum: '$sendBackCount' } } }
            ]).toArray();
            return res.status(200).json({
                success: true,
                stats: {
                    statusCounts: statusCounts.reduce((acc, s) => { acc[s._id] = s.count; return acc; }, {}),
                    operatorCounts: operatorCounts.reduce((acc, s) => { acc[s._id] = s.count; return acc; }, {}),
                    leaderboard
                }
            });
        }

        // Build filter query
        let query = {};
        if (status) {
            const statuses = status.split(',').map(s => s.trim());
            query.currentStatus = statuses.length === 1 ? statuses[0] : { $in: statuses };
        }
        if (operator) {
            query.workTakenBy = operator.trim().toLowerCase();
        }
        // Enforce own-tasks-only for non-partner users
        if (!checkRole(decoded, ['partner'])) {
            if (operator) query.workTakenBy = decoded.username;
        }
        if (search) {
            const searchRegex = { $regex: search.trim(), $options: 'i' };
            query.$or = [
                { clientName: searchRegex },
                { clientCode: searchRegex },
                { natureOfWork: searchRegex },
                { assessmentYear: searchRegex },
                { workTakenBy: searchRegex },
                { reasonForPending: searchRegex }
            ];
        }

        const totalCount = await tasksCollection.countDocuments(query);
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 0;
        let cursor = tasksCollection.find(query).sort({ id: -1 });
        if (limitNum > 0) {
            cursor = cursor.skip((pageNum - 1) * limitNum).limit(limitNum);
        }
        const tasksList = await cursor.toArray();

        const response = { success: true, tasks: tasksList, totalCount };
        if (limitNum > 0) {
            response.page = pageNum;
            response.totalPages = Math.ceil(totalCount / limitNum);
        }
        return res.status(200).json(response);
    }

    // 2. POST: Inward new client work (Accessible by partner, staff, article)
    if (req.method === 'POST') {
      if (!checkRole(decoded, ['partner', 'staff', 'article'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges.' });
      }

      const { clientCode, clientName, natureOfWork, assessmentYear, dateReceived, dueDate, operator } = req.body;

      if (!clientCode || !clientName || !natureOfWork || !dateReceived || !dueDate) {
        return res.status(400).json({ success: false, message: 'All registration parameters are required.' });
      }

      const clientCodeClean = String(clientCode);
      const natureOfWorkClean = natureOfWork.trim();
      const isGstWork = isGstWorkCheck(natureOfWorkClean);
      const ayClean = isGstWork ? "" : (assessmentYear ? String(assessmentYear).trim() : "");

      // Check for duplicate active task (currentStatus !== "Filed")
      const duplicateQuery = {
        clientCode: clientCodeClean,
        natureOfWork: natureOfWorkClean,
        currentStatus: { $ne: "Filed" }
      };
      if (ayClean) {
        duplicateQuery.assessmentYear = ayClean;
      }
      const existingTask = await tasksCollection.findOne(duplicateQuery);
      if (existingTask) {
        return res.status(400).json({
          success: false,
          message: `Duplicate task allocation blocked: An active task for client "${clientName.trim()}" for "${natureOfWorkClean}"${ayClean ? ' (AY: ' + ayClean + ')' : ''} is already open (Status: ${existingTask.currentStatus}, Assigned to: ${existingTask.workTakenBy || 'Unassigned'}).`
        });
      }

      const isAssigned = !!operator;

      const newTask = {
        id: Date.now(), // Numeric ID to match original frontend design
        clientCode: clientCodeClean,
        clientName: clientName.trim(),
        natureOfWork: natureOfWorkClean,
        assessmentYear: ayClean,
        dateReceived: dateReceived,
        dueDate: dueDate,
        currentStatus: isAssigned ? "Assigned" : "Unassigned",
        workTakenBy: isAssigned ? operator.trim().toLowerCase() : "",
        workTakenOn: isAssigned ? new Date().toISOString().split('T')[0] : "",
        sendBackCount: 0,
        reasonForPending: ""
      };

      await tasksCollection.insertOne(newTask);
      await logAuditAction(db, decoded.username, 'CREATE_TASK', {
        taskId: newTask.id,
        clientName: newTask.clientName,
        natureOfWork: newTask.natureOfWork,
        assessmentYear: newTask.assessmentYear,
        operator: newTask.workTakenBy
      });
      return res.status(201).json({ success: true, message: isAssigned ? 'Work registered and allocated.' : 'Inward work registered.', task: newTask });
    }

    // 3. PUT: Update task metadata (edit task details) (Accessible by partner, staff, article)
    if (req.method === 'PUT') {
      if (!checkRole(decoded, ['partner', 'staff', 'article'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges.' });
      }

      const { id, clientCode, clientName, natureOfWork, assessmentYear, operator, dueDate, currentStatus } = req.body;

      if (!id) {
        return res.status(400).json({ success: false, message: 'Task ID is required.' });
      }

      const taskId = parseInt(id);
      const task = await tasksCollection.findOne({ id: taskId });

      if (!task) {
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }

      // If not partner, ensure user is assigned operator
      if (!checkRole(decoded, ['partner']) && task.workTakenBy !== decoded.username) {
        return res.status(403).json({ success: false, message: 'Forbidden: You can only edit your own assigned tasks.' });
      }

      const updateFields = {};
      if (clientCode) updateFields.clientCode = String(clientCode);
      if (clientName) updateFields.clientName = clientName.trim();
      if (natureOfWork) updateFields.natureOfWork = natureOfWork.trim();

      const targetNature = (natureOfWork || task.natureOfWork).trim();
      const isGstWork = isGstWorkCheck(targetNature);

      if (isGstWork) {
        updateFields.assessmentYear = "";
      } else if (assessmentYear !== undefined) {
        updateFields.assessmentYear = String(assessmentYear).trim();
      }

      if (dueDate) updateFields.dueDate = dueDate;

      // Duplicate check when editing key task fields
      const targetClientCode = updateFields.clientCode || task.clientCode;
      const targetAY = updateFields.assessmentYear !== undefined ? updateFields.assessmentYear : (task.assessmentYear || "");

      const dupCheckQuery = {
        id: { $ne: taskId },
        clientCode: targetClientCode,
        natureOfWork: targetNature,
        currentStatus: { $ne: "Filed" }
      };
      if (targetAY) {
        dupCheckQuery.assessmentYear = targetAY;
      }
      const existingDup = await tasksCollection.findOne(dupCheckQuery);
      if (existingDup) {
        return res.status(400).json({
          success: false,
          message: `Cannot update: An active task for client #${targetClientCode} for "${targetNature}"${targetAY ? ' (AY: ' + targetAY + ')' : ''} already exists (ID: #${existingDup.id}).`
        });
      }

      // Handle operator updating and status assignment
      if (operator !== undefined) {
        const targetOp = operator.trim().toLowerCase();
        updateFields.workTakenBy = targetOp;
        if (targetOp) {
          updateFields.workTakenOn = task.workTakenOn || new Date().toISOString().split('T')[0];
          if (task.currentStatus === 'Unassigned') {
            updateFields.currentStatus = 'Assigned';
          }
        } else {
          updateFields.workTakenOn = "";
          updateFields.currentStatus = 'Unassigned';
        }
      }

      if (currentStatus) {
        updateFields.currentStatus = currentStatus;
      }

      await tasksCollection.updateOne({ id: taskId }, { $set: updateFields });
      const updatedTask = await tasksCollection.findOne({ id: taskId });
      await logAuditAction(db, decoded.username, 'UPDATE_TASK', {
        taskId: taskId,
        clientName: updatedTask.clientName,
        natureOfWork: updatedTask.natureOfWork,
        operator: updatedTask.workTakenBy
      });
      return res.status(200).json({ success: true, message: 'Task updated successfully.', task: updatedTask });
    }

    // 4. DELETE: Delete a task from the ledger (Accessible by partner only)
    if (req.method === 'DELETE') {
      if (!checkRole(decoded, ['partner'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
      }

      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ success: false, message: 'Task ID is required.' });
      }

      const taskId = parseInt(id);
      const taskToDelete = await tasksCollection.findOne({ id: taskId });
      if (!taskToDelete) {
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }

      const result = await tasksCollection.deleteOne({ id: taskId });

      if (result.deletedCount === 0) {
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }

      await logAuditAction(db, decoded.username, 'DELETE_TASK', {
        taskId,
        clientName: taskToDelete.clientName,
        natureOfWork: taskToDelete.natureOfWork
      });

      return res.status(200).json({ success: true, message: 'Task deleted successfully.' });
    }

    // 5. PATCH: Handle updates (allocation, dates, status, reviews, filing)
    if (req.method === 'PATCH') {
      const { id, action } = req.body;

      if (!id || !action) {
        return res.status(400).json({ success: false, message: 'Task ID and action are required.' });
      }

      const taskId = parseInt(id);
      const task = await tasksCollection.findOne({ id: taskId });

      if (!task) {
        return res.status(404).json({ success: false, message: 'Task not found.' });
      }

      // Enforce access control on patch actions
      if (action === 'submitReview' || action === 'markFiled' || action === 'updatePendingReason') {
        if (!checkRole(decoded, ['partner', 'staff', 'article'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges.' });
        }
        // If not partner, ensure user is the assigned operator
        if (!checkRole(decoded, ['partner']) && task.workTakenBy !== decoded.username) {
          return res.status(403).json({ success: false, message: 'Forbidden: You can only update your own tasks.' });
        }
      } else {
        // changeDueDate, allocateJob, verdictApprove, verdictReject are partner-only
        if (!checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
        }
      }

      let updateFields = {};

      if (action === 'changeDueDate') {
        const { dueDate } = req.body;
        if (!dueDate) return res.status(400).json({ success: false, message: 'Due date is required.' });
        if (task.currentStatus === 'Filed') {
          return res.status(400).json({ success: false, message: 'Filed tasks are locked and cannot be edited.' });
        }
        updateFields = { dueDate };
      }

      else if (action === 'allocateJob') {
        const { operator } = req.body;
        if (!operator) return res.status(400).json({ success: false, message: 'Operator username is required.' });

        updateFields = {
          workTakenBy: operator.trim().toLowerCase(),
          workTakenOn: new Date().toISOString().split('T')[0],
          currentStatus: "Assigned"
        };
      }

      else if (action === 'submitReview') {
        updateFields = {
          currentStatus: "Pending Review"
        };
      }

      else if (action === 'verdictApprove') {
        // Admin approval moves status to "Approved" (gives back to staff to file)
        updateFields = {
          currentStatus: "Approved"
        };
      }

      else if (action === 'verdictReject') {
        const currentReworkCount = task.sendBackCount || 0;
        updateFields = {
          currentStatus: "Assigned",
          sendBackCount: currentReworkCount + 1
        };
      }

      else if (action === 'markFiled') {
        // Staff/partner marks Approved task as Filed
        updateFields = {
          currentStatus: "Filed"
        };
      }

      else if (action === 'updatePendingReason') {
        const { reason } = req.body;
        if (reason === undefined) return res.status(400).json({ success: false, message: 'Reason is required.' });
        if (task.currentStatus === 'Filed') {
          return res.status(400).json({ success: false, message: 'Filed tasks are locked and cannot be edited.' });
        }
        updateFields = {
          reasonForPending: String(reason).trim()
        };
      }

      else {
        return res.status(400).json({ success: false, message: 'Invalid PATCH action.' });
      }

      await tasksCollection.updateOne({ id: taskId }, { $set: updateFields });

      const updatedTask = await tasksCollection.findOne({ id: taskId });
      await logAuditAction(db, decoded.username, 'PATCH_TASK', {
        taskId: taskId,
        action: action,
        clientName: task.clientName,
        natureOfWork: task.natureOfWork,
        status: updatedTask.currentStatus
      });
      return res.status(200).json({ success: true, message: `Task action "${action}" completed.`, task: updatedTask });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (error) {
    console.error('Tasks endpoint error:', error);
    res.status(500).json({ success: false, error: error.message || 'Database error.' });
  }
};

async function generateAutoGstTasks(db) {
  const now = new Date();
  const startGeneratingDate = new Date("2026-07-01T00:00:00+05:30");
  if (now < startGeneratingDate) {
    return;
  }

  // Get current date string in IST/local format (YYYY-MM-DD)
  const todayStr = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0];
  const systemStateCollection = db.collection('system_state');

  const state = await systemStateCollection.findOne({ key: 'lastGstTaskGenDate' });
  if (state && state.value === todayStr) {
    return; // Already generated today!
  }

  const clientsCollection = db.collection('clients');
  const tasksCollection = db.collection('tasks');

  // Fetch all clients with a GST Number
  const gstClients = await clientsCollection.find({ gstNumber: { $ne: "" } }).toArray();
  if (gstClients.length === 0) return;

  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed (Jan = 1, Dec = 12)
  const day = now.getDate();

  const mm = String(month).padStart(2, '0');
  const tasksToCreate = [];

  for (const client of gstClients) {
    const gstType = client.gstType || 'normal';
    const staff = client.gstStaff || '';
    if (!staff) continue; // Skip if no operator is assigned to this client's GST

    // 1. Normal GST cases
    if (gstType === 'normal') {
      // GSTR 1: assigned on 1st of every month, due on 11th
      if (day >= 1) {
        const expectedDateReceived = `${year}-${mm}-01`;
        const expectedDueDate = `${year}-${mm}-11`;
        tasksToCreate.push({
          client,
          natureOfWork: 'GSTR 1',
          dateReceived: expectedDateReceived,
          dueDate: expectedDueDate,
          operator: staff
        });
      }
      // GSTR 3B: assigned on 14th of every month, due on 20th
      if (day >= 14) {
        const expectedDateReceived = `${year}-${mm}-14`;
        const expectedDueDate = `${year}-${mm}-20`;
        tasksToCreate.push({
          client,
          natureOfWork: 'GSTR 3B',
          dateReceived: expectedDateReceived,
          dueDate: expectedDueDate,
          operator: staff
        });
      }
    }
    // 2. GST Composition cases
    else if (gstType === 'cmp') {
      // GSTR 4: assigned on April 30th, due June 30th
      const isApril30Passed = (month > 4) || (month === 4 && day >= 30);
      if (isApril30Passed) {
        const expectedDateReceived = `${year}-04-30`;
        const expectedDueDate = `${year}-06-30`;
        tasksToCreate.push({
          client,
          natureOfWork: 'GSTR 4',
          dateReceived: expectedDateReceived,
          dueDate: expectedDueDate,
          operator: staff
        });
      }

      // CMP 8: assigned on 1st of every quarter (Jan, Apr, Jul, Oct), due on 18th
      const quarterMonths = [1, 4, 7, 10];
      const activeQuarterMonths = quarterMonths.filter(m => month >= m);
      for (const qMonth of activeQuarterMonths) {
        const isQStartPassed = (month > qMonth) || (month === qMonth && day >= 1);
        if (isQStartPassed) {
          const qMM = String(qMonth).padStart(2, '0');
          const expectedDateReceived = `${year}-${qMM}-01`;
          const expectedDueDate = `${year}-${qMM}-18`;
          tasksToCreate.push({
            client,
            natureOfWork: 'CMP 8',
            dateReceived: expectedDateReceived,
            dueDate: expectedDueDate,
            operator: staff
          });
        }
      }
    }
  }

  for (const item of tasksToCreate) {
    const { client, natureOfWork, dateReceived, dueDate, operator } = item;

    await tasksCollection.updateOne(
      {
        clientCode: String(client.id),
        natureOfWork: natureOfWork,
        dateReceived: dateReceived
      },
      {
        $setOnInsert: {
          id: Date.now() + Math.floor(Math.random() * 1000),
          clientName: client.name,
          dueDate: dueDate,
          currentStatus: "Assigned",
          workTakenBy: operator.toLowerCase(),
          workTakenOn: dateReceived,
          sendBackCount: 0,
          reasonForPending: ""
        }
      },
      { upsert: true }
    );
  }

  // Record that we successfully generated for today
  await systemStateCollection.updateOne(
    { key: 'lastGstTaskGenDate' },
    { $set: { value: todayStr } },
    { upsert: true }
  );
}

function isGstWorkCheck(natureOfWork) {
  if (!natureOfWork) return false;
  const str = String(natureOfWork).toLowerCase().trim();
  return str.includes('gst') || str.includes('cmp');
}
