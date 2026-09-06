const { connectToDatabase } = require('./db');
const bcrypt = require('bcryptjs');
const { verifyToken, checkRole, logAuditAction } = require('./auth');

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    const { db } = await connectToDatabase();
    const usersCollection = db.collection('users');

    // 1. GET requests fetch all registered users (any logged in user)
    if (req.method === 'GET') {
        if (!checkRole(decoded, ['partner', 'staff', 'article'])) {
            return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges.' });
        }
        const allUsers = await usersCollection.find({}).toArray();
        const usersData = allUsers.map(u => {
            const { password, faceDescriptor, ...safeUser } = u;
            safeUser.faceDescriptor = !!faceDescriptor;
            if (decoded.role === 'partner') {
                return { ...safeUser, password: u.password };
            }
            return safeUser;
        });
        return res.status(200).json({ success: true, users: usersData });
    }

    // 2. PUT requests update user account details (Partner only)
    if (req.method === 'PUT') {
      if (!checkRole(decoded, ['partner'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
      }

      const { originalUsername, username, password, name, role } = req.body;
      if (!originalUsername || !username || !name || !role) {
        return res.status(400).json({ success: false, message: 'Original username, new username, name, and role are required.' });
      }

      const origUserLower = originalUsername.trim().toLowerCase();
      const newUserLower = username.trim().toLowerCase();

      const user = await usersCollection.findOne({ username: origUserLower });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
      }

      if (origUserLower !== newUserLower) {
        const exist = await usersCollection.findOne({ username: newUserLower });
        if (exist) {
          return res.status(400).json({ success: false, message: 'New username already exists.' });
        }
      }

      const updateFields = {
        username: newUserLower,
        name: name.trim(),
        role: role
      };

      if (password) {
        updateFields.password = password;
      }

      await usersCollection.updateOne({ username: origUserLower }, { $set: updateFields });

      // Cascading updates for tasks & attendance if username changes
      if (origUserLower !== newUserLower) {
        const tasksCollection = db.collection('tasks');
        await tasksCollection.updateMany({ workTakenBy: origUserLower }, { $set: { workTakenBy: newUserLower } });

        const attendanceCollection = db.collection('attendance');
        await attendanceCollection.updateMany({ username: origUserLower }, { $set: { username: newUserLower } });
      }

      await logAuditAction(db, decoded.username, 'UPDATE_USER', {
        targetUser: origUserLower,
        newName: name.trim(),
        newRole: role,
        usernameChanged: origUserLower !== newUserLower
      });

      return res.status(200).json({ success: true, message: 'User account details updated.' });
    }

    // 3. DELETE requests purge user accounts (Partner only)
    if (req.method === 'DELETE') {
      if (!checkRole(decoded, ['partner'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
      }

      const { username } = req.query;
      if (!username) {
        return res.status(400).json({ success: false, message: 'Username is required.' });
      }

      const userLower = username.trim().toLowerCase();
      
      if (decoded.username === userLower) {
        return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
      }

      const result = await usersCollection.deleteOne({ username: userLower });

      if (result.deletedCount === 0) {
        return res.status(404).json({ success: false, message: 'User not found.' });
      }

      await logAuditAction(db, decoded.username, 'DELETE_USER', { targetUser: userLower });

      return res.status(200).json({ success: true, message: 'User account deleted successfully.' });
    }

    // 4. POST requests handle creation, self password changes, and partner overrides
    if (req.method === 'POST') {
      const { action } = req.body;

      if (action === 'create') {
        if (!checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
        }

        const { username, password, name, role } = req.body;
        if (!username || !password || !name || !role) {
          return res.status(400).json({ success: false, message: 'All fields (username, password, name, role) are required.' });
        }

        const uInput = username.trim().toLowerCase();
        const existingUser = await usersCollection.findOne({ username: uInput });
        if (existingUser) {
          return res.status(400).json({ success: false, message: 'Username already exists.' });
        }

        await usersCollection.insertOne({
          username: uInput,
          password: password,
          name: name.trim(),
          role,
          requireBiometric: false,
          faceDescriptor: null
        });

        await logAuditAction(db, decoded.username, 'CREATE_USER', {
          targetUser: uInput,
          role: role
        });

        return res.status(201).json({ success: true, message: `Account provisioned for ${name}.` });
      }

      if (action === 'changePassword') {
        const { username, newPassword } = req.body;
        if (!username || !newPassword) {
          return res.status(400).json({ success: false, message: 'Username and new password are required.' });
        }

        const targetUserLower = username.trim().toLowerCase();
        if (decoded.username !== targetUserLower && !checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Cannot change other user passwords.' });
        }

        const result = await usersCollection.updateOne(
          { username: targetUserLower },
          { $set: { password: newPassword } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ success: false, message: 'User not found.' });
        }

        await logAuditAction(db, decoded.username, 'CHANGE_PASSWORD', {
          targetUser: targetUserLower,
          isSelf: decoded.username === targetUserLower
        });

        return res.status(200).json({ success: true, message: 'Password modified.' });
      }

      if (action === 'resetPassword') {
        if (!checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
        }

        const { targetUser, newPassword } = req.body;
        if (!targetUser || !newPassword) {
          return res.status(400).json({ success: false, message: 'Target user and new security key are required.' });
        }

        const targetUserLower = targetUser.trim().toLowerCase();
        const result = await usersCollection.updateOne(
          { username: targetUserLower },
          { $set: { password: newPassword } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ success: false, message: 'Target user not found.' });
        }

        await logAuditAction(db, decoded.username, 'RESET_PASSWORD', { targetUser: targetUserLower });

        return res.status(200).json({ success: true, message: 'User password rewritten successfully.' });
      }

      if (action === 'toggleBiometric') {
        if (!checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
        }

        const { username, requireBiometric } = req.body;
        if (!username) {
          return res.status(400).json({ success: false, message: 'Username is required.' });
        }

        const targetUserLower = username.trim().toLowerCase();
        const result = await usersCollection.updateOne(
          { username: targetUserLower },
          { $set: { requireBiometric: !!requireBiometric } }
        );

        await logAuditAction(db, decoded.username, 'TOGGLE_BIOMETRIC', {
          targetUser: targetUserLower,
          requireBiometric: !!requireBiometric
        });

        return res.status(200).json({ success: true, message: 'Biometric requirement updated.' });
      }

      if (action === 'registerFace') {
        const { username, faceDescriptor } = req.body;
        if (!username || !faceDescriptor) {
          return res.status(400).json({ success: false, message: 'Username and face descriptor are required.' });
        }

        const targetUserLower = username.trim().toLowerCase();
        if (decoded.username !== targetUserLower && !checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Cannot register face for other users.' });
        }

        const result = await usersCollection.updateOne(
          { username: targetUserLower },
          { $set: { faceDescriptor: faceDescriptor } }
        );

        await logAuditAction(db, decoded.username, 'REGISTER_FACE', { targetUser: targetUserLower });

        return res.status(200).json({ success: true, message: 'Biometric face signature registered.' });
      }

      if (action === 'resetFace') {
        const { username } = req.body;
        if (!username) {
          return res.status(400).json({ success: false, message: 'Username is required.' });
        }

        const targetUserLower = username.trim().toLowerCase();
        if (decoded.username !== targetUserLower && !checkRole(decoded, ['partner'])) {
          return res.status(403).json({ success: false, message: 'Forbidden: Cannot reset face for other users.' });
        }

        const result = await usersCollection.updateOne(
          { username: targetUserLower },
          { $set: { faceDescriptor: null } }
        );

        await logAuditAction(db, decoded.username, 'RESET_FACE', { targetUser: targetUserLower });

        return res.status(200).json({ success: true, message: 'Biometric face signature reset.' });
      }

      return res.status(400).json({ success: false, message: 'Invalid POST action.' });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (error) {
    console.error('Users endpoint error:', error);
    res.status(500).json({ success: false, error: error.message || 'Database error.' });
  }
};
