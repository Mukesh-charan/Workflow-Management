const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  if (!uri) {
    throw new Error('Please define the MONGODB_URI environment variable inside .env or Vercel dashboard');
  }

  // The mongodb client options for modern driver
  const client = new MongoClient(uri);

  await client.connect();
  const db = client.db('ca_office_workflow');

  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

module.exports = { connectToDatabase };
