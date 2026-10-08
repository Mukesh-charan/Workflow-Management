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
    const clientsCollection = db.collection('clients');
    const tasksCollection = db.collection('tasks');

    if (req.method === 'GET') {
        if (!checkRole(decoded, ['partner', 'staff', 'article'])) {
            return res.status(403).json({ success: false, message: 'Forbidden: Insufficient privileges.' });
        }
        const { search, page, limit } = req.query;
        let query = {};
        if (search) {
            const searchRegex = { $regex: search.trim(), $options: 'i' };
            query.$or = [
                { name: searchRegex },
                { pan: searchRegex },
                { contact: searchRegex },
                { email: searchRegex },
                { gstNumber: searchRegex }
            ];
        }
        const totalCount = await clientsCollection.countDocuments(query);
        let cursor = clientsCollection.find(query).sort({ id: 1 });
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 0;
        if (limitNum > 0) {
            cursor = cursor.skip((pageNum - 1) * limitNum).limit(limitNum);
        }
        const clients = await cursor.toArray();
        const response = { success: true, clients, totalCount };
        if (limitNum > 0) {
            response.page = pageNum;
            response.totalPages = Math.ceil(totalCount / limitNum);
        }
        return res.status(200).json(response);
    }

    // 2. POST: Create or Save a new client
    if (req.method === 'POST') {
      const { 
        id, name, pan, contact, email,
        passwordITR, taxAuditCase, dob, address,
        area, city, pinCode, aadhaar, status,
        gstUsername, gstPassword, gstNumber, gstStaff, gstMobileNo, gstContactPerson, gstEmail
      } = req.body;

      if (!name) {
        return res.status(400).json({ success: false, message: 'Client name is required.' });
      }

      let targetId = 0;
      if (id) {
        targetId = parseInt(id);
        const existingClient = await clientsCollection.findOne({ id: targetId });
        if (existingClient) {
          return res.status(400).json({ success: false, message: `Duplicate numbering detected! Client ID [${targetId}] already exists.` });
        }
      } else {
        // Auto-generate ID: Find max ID or default to 1000
        const maxClient = await clientsCollection.find({}).sort({ id: -1 }).limit(1).toArray();
        const maxId = maxClient.length > 0 ? maxClient[0].id : 1000;
        targetId = maxId + 1;
      }

      const hasGst = !!gstNumber;
      const isCmp = hasGst && name.toLowerCase().includes('- gstr 4');
      const calculatedGstType = hasGst ? (isCmp ? 'cmp' : 'normal') : '';

      const newClient = {
        id: targetId,
        name: name.trim(),
        pan: pan ? pan.trim().toUpperCase() : '',
        contact: contact ? contact.trim() : '',
        email: email ? email.trim() : '',
        passwordITR: passwordITR ? passwordITR.trim() : '',
        taxAuditCase: taxAuditCase ? taxAuditCase.trim() : '',
        dob: dob ? dob.trim() : '',
        address: address ? address.trim() : '',
        area: area ? area.trim() : '',
        city: city ? city.trim() : '',
        pinCode: pinCode ? pinCode.trim() : '',
        aadhaar: aadhaar ? aadhaar.trim() : '',
        status: status ? status.trim() : '',
        gstUsername: gstUsername ? gstUsername.trim() : '',
        gstPassword: gstPassword ? gstPassword.trim() : '',
        gstNumber: gstNumber ? gstNumber.trim().toUpperCase() : '',
        gstStaff: gstStaff ? gstStaff.trim().toLowerCase() : '',
        gstMobileNo: gstMobileNo ? gstMobileNo.trim() : '',
        gstContactPerson: gstContactPerson ? gstContactPerson.trim() : '',
        gstEmail: gstEmail ? gstEmail.trim() : '',
        gstType: calculatedGstType
      };

      await clientsCollection.insertOne(newClient);
      await logAuditAction(db, decoded.username, 'CREATE_CLIENT', { clientId: targetId, clientName: name.trim() });
      return res.status(201).json({ success: true, message: `Client registered under ID: [${targetId}].`, client: newClient });
    }

    // 3. PUT: Update a client's details
    if (req.method === 'PUT') {
      const { 
        id, name, pan, contact, email,
        passwordITR, taxAuditCase, dob, address,
        area, city, pinCode, aadhaar, status,
        gstUsername, gstPassword, gstNumber, gstStaff, gstMobileNo, gstContactPerson, gstEmail
      } = req.body;

      if (!id) {
        return res.status(400).json({ success: false, message: 'Client ID is required.' });
      }

      if (!name) {
        return res.status(400).json({ success: false, message: 'Client name is required.' });
      }

      const targetId = parseInt(id);
      const client = await clientsCollection.findOne({ id: targetId });

      if (!client) {
        return res.status(404).json({ success: false, message: 'Client not found.' });
      }

      const hasGst = !!gstNumber;
      const isCmp = hasGst && name.toLowerCase().includes('- gstr 4');
      const calculatedGstType = hasGst ? (isCmp ? 'cmp' : 'normal') : '';

      const updateFields = {
        name: name.trim(),
        pan: pan ? pan.trim().toUpperCase() : '',
        contact: contact ? contact.trim() : '',
        email: email ? email.trim() : '',
        passwordITR: passwordITR ? passwordITR.trim() : '',
        taxAuditCase: taxAuditCase ? taxAuditCase.trim() : '',
        dob: dob ? dob.trim() : '',
        address: address ? address.trim() : '',
        area: area ? area.trim() : '',
        city: city ? city.trim() : '',
        pinCode: pinCode ? pinCode.trim() : '',
        aadhaar: aadhaar ? aadhaar.trim() : '',
        status: status ? status.trim() : '',
        gstUsername: gstUsername ? gstUsername.trim() : '',
        gstPassword: gstPassword ? gstPassword.trim() : '',
        gstNumber: gstNumber ? gstNumber.trim().toUpperCase() : '',
        gstStaff: gstStaff ? gstStaff.trim().toLowerCase() : '',
        gstMobileNo: gstMobileNo ? gstMobileNo.trim() : '',
        gstContactPerson: gstContactPerson ? gstContactPerson.trim() : '',
        gstEmail: gstEmail ? gstEmail.trim() : '',
        gstType: calculatedGstType
      };

      await clientsCollection.updateOne({ id: targetId }, { $set: updateFields });
      await logAuditAction(db, decoded.username, 'UPDATE_CLIENT', { clientId: targetId, clientName: name.trim() });

      // Update name in tasks collection as well for database consistency
      await tasksCollection.updateMany({ clientCode: String(targetId) }, { $set: { clientName: name.trim() } });

      return res.status(200).json({ success: true, message: 'Client profile updated successfully.', client: { id: targetId, ...updateFields } });
    }

    // 4. DELETE: Wipe out client and associated tasks
    if (req.method === 'DELETE') {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ success: false, message: 'Client ID parameter is required.' });
      }

      const targetId = parseInt(id);
      const client = await clientsCollection.findOne({ id: targetId });

      if (!client) {
        return res.status(404).json({ success: false, message: 'Client profile not found.' });
      }

      // Delete client
      await clientsCollection.deleteOne({ id: targetId });

      // Delete all related tasks (clientCode is string matches String(id))
      await tasksCollection.deleteMany({ clientCode: String(targetId) });

      await logAuditAction(db, decoded.username, 'DELETE_CLIENT', {
        clientId: targetId,
        clientName: client.name
      });

      return res.status(200).json({
        success: true,
        message: `Client "${client.name}" and all associated workflow tasks wiped globally.`
      });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (error) {
    console.error('Clients endpoint error:', error);
    res.status(500).json({ success: false, error: error.message || 'Database error.' });
  }
};
