const { connectToDatabase } = require('./db');
const { verifyToken, checkRole, logAuditAction } = require('./auth');

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
    const attendanceCollection = db.collection('attendance');

    // Helper to get Indian Standard Time (IST) Date String (YYYY-MM-DD)
    const getISTDateDetails = () => {
      const now = new Date();
      // Add 5.5 hours for IST offset
      const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      const istTime = new Date(utc + (3600000 * 5.5));
      const year = istTime.getFullYear();
      const month = String(istTime.getMonth() + 1).padStart(2, '0');
      const day = String(istTime.getDate()).padStart(2, '0');
      return {
        dateStr: `${year}-${month}-${day}`,
        timestamp: now
      };
    };

    const ensureDailyAbsentRecords = async (db) => {
      const { dateStr } = getISTDateDetails();
      const usersCollection = db.collection('users');
      const attendanceCollection = db.collection('attendance');

      // Find all non-partner users
      const nonPartners = await usersCollection.find({ role: { $ne: 'partner' } }).toArray();

      for (const user of nonPartners) {
        const usernameLower = user.username.trim().toLowerCase();
        const existing = await attendanceCollection.findOne({
          username: usernameLower,
          date: dateStr
        });

        if (!existing) {
          await attendanceCollection.insertOne({
            username: usernameLower,
            name: user.name,
            role: user.role,
            date: dateStr,
            clockIn: null,
            clockOut: null,
            status: 'Absent'
          });
        }
      }
    };

    // Auto-populate absent records for today
    await ensureDailyAbsentRecords(db);

    // 1. GET: Fetch attendance with date/month filtering and pagination
    if (req.method === 'GET') {
        let query = {};
        if (!checkRole(decoded, ['partner'])) {
            query.username = decoded.username;
        }

        const { date, month, page, limit } = req.query;
        if (date) {
            query.date = date;
        } else if (month) {
            // month format: YYYY-MM
            query.date = { $regex: new RegExp('^' + month) };
        } else {
            // Default to today
            const { dateStr } = getISTDateDetails();
            query.date = dateStr;
        }

        const totalCount = await attendanceCollection.countDocuments(query);
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 0;

        let cursor = attendanceCollection.find(query).sort({ date: -1, clockIn: -1 });
        if (limitNum > 0) {
            cursor = cursor.skip((pageNum - 1) * limitNum).limit(limitNum);
        }
        const logs = await cursor.toArray();

        const response = { success: true, logs, totalCount };
        if (limitNum > 0) {
            response.page = pageNum;
            response.totalPages = Math.ceil(totalCount / limitNum);
        }
        return res.status(200).json(response);
    }

    // 2. POST: Handle Clock In (Entry) and Clock Out (Exit)
    if (req.method === 'POST') {
      const { action, username, name, role } = req.body;

      if (!username) {
        return res.status(400).json({ success: false, message: 'Username is required.' });
      }

      const { dateStr, timestamp } = getISTDateDetails();

      if (action === 'clockIn') {
        if (!name || !role) {
          return res.status(400).json({ success: false, message: 'Name and role are required for clock-in.' });
        }

        // Check if user already has an active or completed attendance record for today
        const existingRecord = await attendanceCollection.findOne({
          username: username.toLowerCase(),
          date: dateStr
        });

        if (existingRecord) {
          if (existingRecord.status === 'Completed') {
            return res.status(400).json({
              success: false,
              message: `${name} has already clocked in and out for today. Attendance is limited to once per day.`
            });
          }
          if (existingRecord.status === 'Active') {
            return res.status(400).json({
              success: false,
              message: `${name} is already clocked in today.`
            });
          }
          if (existingRecord.status === 'On Duty') {
            return res.status(400).json({
              success: false,
              message: `${name} is marked On Duty today.`
            });
          }

          if (existingRecord.status === 'Absent') {
            const updatedFields = {
              clockIn: timestamp,
              status: 'Active'
            };
            await attendanceCollection.updateOne(
              { _id: existingRecord._id },
              { $set: updatedFields }
            );
            return res.status(200).json({
              success: true,
              message: 'Clock-in entry recorded successfully.',
              log: { ...existingRecord, ...updatedFields }
            });
          }
        }

        const newLog = {
          username: username.toLowerCase(),
          name: name,
          role: role,
          date: dateStr,
          clockIn: timestamp,
          clockOut: null,
          status: 'Active'
        };

        await attendanceCollection.insertOne(newLog);
        return res.status(201).json({ success: true, message: 'Clock-in entry recorded successfully.', log: newLog });
      }
      
      if (action === 'markOD') {
        // Enforce partner-only access
        if (!checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
        }

        if (!name || !role) {
          return res.status(400).json({ success: false, message: 'Name and role are required for OD entry.' });
        }

        const targetDate = req.body.date || dateStr;

        const existingRecord = await attendanceCollection.findOne({
          username: username.toLowerCase(),
          date: targetDate
        });

        if (existingRecord) {
          if (existingRecord.status === 'Completed' || existingRecord.status === 'Active') {
            return res.status(400).json({
              success: false,
              message: `${name} already has a present/active attendance record logged for ${targetDate}.`
            });
          }

          await attendanceCollection.updateOne(
            { _id: existingRecord._id },
            { $set: { status: 'On Duty' } }
          );

          await logAuditAction(db, decoded.username, 'MANUAL_OD_MARKED', {
            targetUser: username.toLowerCase(),
            name,
            date: targetDate
          });

          return res.status(200).json({
            success: true,
            message: 'On-Duty (OD) entry updated successfully.',
            log: { ...existingRecord, status: 'On Duty' }
          });
        }

        const newLog = {
          username: username.toLowerCase(),
          name: name,
          role: role,
          date: targetDate,
          clockIn: null,
          clockOut: null,
          status: 'On Duty'
        };

        await attendanceCollection.insertOne(newLog);

        await logAuditAction(db, decoded.username, 'MANUAL_OD_MARKED', {
          targetUser: username.toLowerCase(),
          name,
          date: targetDate
        });

        return res.status(201).json({ success: true, message: 'On-Duty (OD) entry recorded successfully.', log: newLog });
      }

      if (action === 'clockOut') {
        // Find today's record
        const existingRecord = await attendanceCollection.findOne({
          username: username.toLowerCase(),
          date: dateStr
        });

        if (!existingRecord) {
          return res.status(400).json({
            success: false,
            message: 'No preceding Clock-In record found for today. The operator must clock-in first.'
          });
        }

        if (existingRecord.status === 'Completed') {
          return res.status(400).json({
            success: false,
            message: 'The operator is already clocked out for today.'
          });
        }

        await attendanceCollection.updateOne(
          { _id: existingRecord._id },
          { $set: { clockOut: timestamp, status: 'Completed' } }
        );

        return res.status(200).json({
          success: true,
          message: 'Clock-out exit logged successfully.',
          log: { ...existingRecord, clockOut: timestamp, status: 'Completed' }
        });
      }

      return res.status(400).json({ success: false, message: 'Invalid attendance action.' });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (error) {
    console.error('Attendance endpoint error:', error);
    res.status(500).json({ success: false, error: error.message || 'Database error.' });
  }
};
