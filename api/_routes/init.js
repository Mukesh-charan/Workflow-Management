const { connectToDatabase } = require('./db');

module.exports = async (req, res) => {
  // Allow simple GET requests to initialize
  try {
    const { db } = await connectToDatabase();
    
    const usersCollection = db.collection('users');
    const engagementsCollection = db.collection('engagements');
    const clientsCollection = db.collection('clients');
    const tasksCollection = db.collection('tasks');

    let seededUsers = false;
    let seededEngagements = false;

    // Check if partner exists
    const partnerCount = await usersCollection.countDocuments({ role: 'partner' });
    if (partnerCount === 0) {
      await usersCollection.insertOne({
        username: 'smk',
        password: '1234',
        name: 'CA. S. Masilamani Karthikeyan',
        role: 'partner'
      });
      seededUsers = true;
    }

    // Check if engagements exist
    const defaultTitles = [
      "Statutory Audit",
      "Tax Audit (3CD)",
      "GST Annual Return (9/9C)",
      "GST Monthly Return",
      "Income Tax Assessment",
      "TDS Quarterly Filing",
      "GSTR 1",
      "GSTR 3B",
      "GSTR 4",
      "CMP 8"
    ];
    for (const title of defaultTitles) {
      const exists = await engagementsCollection.findOne({ title });
      if (!exists) {
        await engagementsCollection.insertOne({ title });
        seededEngagements = true;
      }
    }

    res.status(200).json({
      success: true,
      message: 'Database initialization check complete.',
      seededUsers,
      seededEngagements
    });
  } catch (error) {
    console.error('Initialization error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Database initialization failed.'
    });
  }
};
