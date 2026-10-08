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
    const engagementsCollection = db.collection('engagements');

    // 1. GET: Fetch allowed engagement options (Accessible by any authorized user)
    if (req.method === 'GET') {
      const engagements = await engagementsCollection.find({}).toArray();
      const titles = engagements.map(e => e.title);
      return res.status(200).json({ success: true, engagements: titles });
    }

    // 2. POST: Append a new engagement type (Partner only)
    if (req.method === 'POST') {
      if (!checkRole(decoded, ['partner'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
      }

      const { title } = req.body;

      if (!title || title.trim() === '') {
        return res.status(400).json({ success: false, message: 'Engagement title is required.' });
      }

      const formattedTitle = title.trim();
      const existing = await engagementsCollection.findOne({
        title: { $regex: new RegExp(`^${formattedTitle}$`, 'i') }
      });

      if (existing) {
        return res.status(400).json({ success: false, message: 'This Engagement type already exists.' });
      }

      await engagementsCollection.insertOne({ title: formattedTitle });
      return res.status(201).json({ success: true, message: `Engagement [${formattedTitle}] appended.` });
    }

    // 3. PUT: Update/Rename an engagement type (Partner only)
    if (req.method === 'PUT') {
      if (!checkRole(decoded, ['partner'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
      }

      const { originalTitle, title } = req.body;

      if (!originalTitle || !title) {
        return res.status(400).json({ success: false, message: 'Original title and new title are required.' });
      }

      const origTrimmed = originalTitle.trim();
      const newTrimmed = title.trim();

      const existing = await engagementsCollection.findOne({ title: origTrimmed });
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Engagement type not found.' });
      }

      if (origTrimmed !== newTrimmed) {
        const duplicate = await engagementsCollection.findOne({
          title: { $regex: new RegExp(`^${newTrimmed}$`, 'i') }
        });
        if (duplicate) {
          return res.status(400).json({ success: false, message: 'New engagement type already exists.' });
        }
      }

      await engagementsCollection.updateOne({ title: origTrimmed }, { $set: { title: newTrimmed } });

      // Cascade change to tasks
      const tasksCollection = db.collection('tasks');
      await tasksCollection.updateMany({ natureOfWork: origTrimmed }, { $set: { natureOfWork: newTrimmed } });

      return res.status(200).json({ success: true, message: 'Engagement renamed successfully.' });
    }

    // 4. DELETE: Remove an engagement type (Partner only)
    if (req.method === 'DELETE') {
      if (!checkRole(decoded, ['partner'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
      }

      const { title } = req.query;

      if (!title) {
        return res.status(400).json({ success: false, message: 'Engagement title parameter is required.' });
      }

      const result = await engagementsCollection.deleteOne({ title: title.trim() });
      
      if (result.deletedCount === 0) {
        return res.status(404).json({ success: false, message: 'Engagement type not found.' });
      }

      return res.status(200).json({ success: true, message: `Engagement [${title}] removed successfully.` });
    }

    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  } catch (error) {
    console.error('Engagements endpoint error:', error);
    res.status(500).json({ success: false, error: error.message || 'Database error.' });
  }
};
