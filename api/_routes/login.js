const { connectToDatabase } = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-local-secret-key-12345';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    const { db } = await connectToDatabase();
    const usersCollection = db.collection('users');
    const engagementsCollection = db.collection('engagements');

    // Run database seeding checks on login if no users exist
    const usersCount = await usersCollection.countDocuments();
    if (usersCount === 0) {
      // Seed default Partner
      await usersCollection.insertOne({
        username: 'smk',
        password: '1234',
        name: 'CA. S. Masilamani Karthikeyan',
        role: 'partner',
        requireBiometric: false,
        faceDescriptor: null
      });

      // Seed default Engagements
      const engagementsCount = await engagementsCollection.countDocuments();
      if (engagementsCount === 0) {
        const defaultEngagements = [
          { title: "Statutory Audit" },
          { title: "Tax Audit (3CD)" },
          { title: "GST Annual Return (9/9C)" },
          { title: "GST Monthly Return" },
          { title: "Income Tax Assessment" },
          { title: "TDS Quarterly Filing" }
        ];
        await engagementsCollection.insertMany(defaultEngagements);
      }
    }

    const uInput = username.trim().toLowerCase();
    const user = await usersCollection.findOne({ username: uInput });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Security Error: Username or Password incorrect.'
      });
    }

    let isPasswordCorrect = false;
    const isHashed = user.password.startsWith('$2a$') || user.password.startsWith('$2b$');
    
    if (isHashed) {
      isPasswordCorrect = await bcrypt.compare(password, user.password);
      if (isPasswordCorrect) {
        // Revert legacy hashed password back to plain-text
        await usersCollection.updateOne({ _id: user._id }, { $set: { password: password } });
      }
    } else {
      isPasswordCorrect = user.password === password;
    }

    if (isPasswordCorrect) {
      const token = jwt.sign(
        { username: user.username, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.status(200).json({
        success: true,
        token,
        requireBiometric: false,
        faceDescriptor: user.faceDescriptor || null,
        user: {
          username: user.username,
          name: user.name,
          role: user.role
        }
      });
    } else {
      return res.status(401).json({
        success: false,
        message: 'Security Error: Username or Password incorrect.'
      });
    }
  } catch (error) {
    console.error('Login endpoint error:', error);
    res.status(500).json({ success: false, error: error.message || 'Authentication service error.' });
  }
};
