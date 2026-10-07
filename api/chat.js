const { connectToDatabase } = require('./db');
const { verifyToken, checkRole } = require('./auth');

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required.' });
    }

    const query = message.trim();
    const queryLower = query.toLowerCase();

    const { db } = await connectToDatabase();
    const clientsCol = db.collection('clients');
    const tasksCol = db.collection('tasks');
    const attendanceCol = db.collection('attendance');
    const usersCol = db.collection('users');

    let recordsFound = {
      clients: [],
      tasks: [],
      attendance: [],
      driveFiles: []
    };

    // 1. Search Clients by Name, PAN, Phone, Email, GSTIN
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

    // 2. Search Tasks by ClientName, ClientCode, NatureOfWork, Operator, Status
    let taskConditions = [
      { clientName: clientRegex },
      { clientCode: clientRegex },
      { natureOfWork: clientRegex },
      { workTakenBy: clientRegex }
    ];

    if (queryLower.includes('pending') || queryLower.includes('open') || queryLower.includes('active')) {
      taskConditions.push({ currentStatus: { $in: ['Preparation', 'Verification', 'Review', 'Correction'] } });
    }
    if (queryLower.includes('review')) {
      taskConditions.push({ currentStatus: 'Review' });
    }
    if (queryLower.includes('filed') || queryLower.includes('completed') || queryLower.includes('done')) {
      taskConditions.push({ currentStatus: 'Filed' });
    }
    if (queryLower.includes('unassigned')) {
      taskConditions.push({ currentStatus: 'Unassigned' });
    }

    let taskQuery = { $or: taskConditions };
    // Non-partners only see their own tasks
    if (!checkRole(decoded, ['partner'])) {
      taskQuery = { $and: [{ workTakenBy: decoded.username }, { $or: taskConditions }] };
    }

    const matchedTasks = await tasksCol.find(taskQuery).sort({ dateReceived: -1 }).limit(8).toArray();
    recordsFound.tasks = matchedTasks;

    // 3. Search Attendance if query mentions attendance / clock / present / absent / od
    if (queryLower.includes('attend') || queryLower.includes('present') || queryLower.includes('absent') || queryLower.includes('clock') || queryLower.includes('od')) {
      const todayIST = (() => {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const ist = new Date(utc + (3600000 * 5.5));
        return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
      })();

      let attQuery = { date: todayIST };
      if (!checkRole(decoded, ['partner'])) {
        attQuery.username = decoded.username;
      }
      recordsFound.attendance = await attendanceCol.find(attQuery).limit(10).toArray();
    }

    // 4. Query Google Drive (RAG retrieval)
    try {
      const driveConfigDoc = await db.collection('settings').findOne({ key: 'google_drive_config' });
      if (driveConfigDoc && driveConfigDoc.credentials) {
        // Query Google Drive for related docs
        const driveHandler = require('./drive');
        // Extract client code if found
        let driveKeywords = query;
        if (matchedClients.length > 0) {
          driveKeywords = String(matchedClients[0].id);
        }
        // Query Drive internal mock/API
        const mockReq = {
          query: { action: 'listFiles', clientCode: driveKeywords },
          headers: req.headers
        };
        // Quick Drive fetch using stored credentials
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

    // 5. Generate Synthesized Response
    let reply = "";

    // Client findings
    if (recordsFound.clients.length > 0) {
      reply += `### Client Records Found:\n`;
      recordsFound.clients.forEach(c => {
        reply += `- **[#${c.id}] ${c.name}** | PAN: \`${c.pan || 'N/A'}\` | Phone: ${c.contact || 'N/A'} | Status: *${c.status || 'Active'}*\n`;
        if (c.gstNumber) reply += `  - GSTIN: \`${c.gstNumber}\`\n`;
      });
      reply += `\n`;
    }

    // Task findings
    if (recordsFound.tasks.length > 0) {
      reply += `### Associated Tasks (${recordsFound.tasks.length}):\n`;
      recordsFound.tasks.forEach(t => {
        const dueText = t.dueDate ? `(Due: ${t.dueDate})` : '';
        const operatorText = t.workTakenBy ? `@${t.workTakenBy}` : 'Unassigned';
        reply += `- **${t.natureOfWork}** for *${t.clientName}* [${t.currentStatus}] - Assigned: **${operatorText}** ${dueText}\n`;
      });
      reply += `\n`;
    }

    // Attendance findings
    if (recordsFound.attendance.length > 0) {
      reply += `### Today's Attendance Status:\n`;
      recordsFound.attendance.forEach(a => {
        const inTime = a.clockIn ? new Date(a.clockIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'None';
        const outTime = a.clockOut ? new Date(a.clockOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'None';
        reply += `- **${a.name}** (@${a.username}): **${a.status}** (In: ${inTime}, Out: ${outTime})\n`;
      });
      reply += `\n`;
    }

    // Google Drive RAG documents
    if (recordsFound.driveFiles.length > 0) {
      reply += `### Google Drive Vault Documents:\n`;
      recordsFound.driveFiles.forEach(f => {
        reply += `- 📄 [${f.name}](${f.webViewLink}) *(Google Drive)*\n`;
      });
      reply += `\n`;
    }

    if (!reply) {
      reply = `I could not find any matching database records or Google Drive files for **"${query}"**.\n\nTry searching by:\n- Client Name (e.g. *"Ramesh"*)\n- Client PAN or ID\n- Task status (e.g. *"Pending Review"*, *"GST returns"*)\n- Attendance (e.g. *"Who is present today?"*)`;
    }

    return res.status(200).json({
      success: true,
      reply,
      data: recordsFound
    });
  } catch (err) {
    console.error('Chatbot API error:', err);
    return res.status(500).json({ success: false, message: 'Chatbot error: ' + err.message });
  }
};
