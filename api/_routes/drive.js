const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connectToDatabase } = require('./db');
const { verifyToken, checkRole } = require('./auth');

// Helper to create Google Service Account OAuth2 Bearer Token without mandatory external packages
async function getServiceAccountAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file',
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

  const formattedPrivateKey = credentials.private_key.replace(/\\n/g, '\n');
  const signature = signer.sign(formattedPrivateKey, 'base64url');
  const jwt = `${unsignedToken}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Failed to obtain Google access token');
  }

  return data.access_token;
}

// Retrieve credentials from MongoDB settings collection or process.env or service-account.json
async function getDriveConfig(db) {
  const settingsCol = db.collection('settings');
  const configDoc = await settingsCol.findOne({ key: 'google_drive_config' });

  if (configDoc && configDoc.credentials && configDoc.credentials.client_email) {
    return configDoc;
  }

  // Check local file service-account.json if present
  const saFilePath = path.join(__dirname, '..', 'service-account.json');
  if (fs.existsSync(saFilePath)) {
    try {
      const saFileContent = JSON.parse(fs.readFileSync(saFilePath, 'utf8'));
      if (saFileContent.client_email && saFileContent.private_key) {
        return {
          credentials: {
            client_email: saFileContent.client_email,
            private_key: saFileContent.private_key
          },
          folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null
        };
      }
    } catch (e) {
      console.warn('Failed to parse service-account.json file:', e.message);
    }
  }

  // Check process.env variables
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY
      },
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null
    };
  }

  return null;
}

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    const { db } = await connectToDatabase();
    const driveConfig = await getDriveConfig(db);

    const action = req.query.action || (req.body && req.body.action) || 'status';

    // 1. STATUS: Return connection health
    if (action === 'status') {
      if (!driveConfig) {
        return res.status(200).json({
          success: true,
          configured: false,
          message: 'Google Drive service account not configured yet.'
        });
      }

      try {
        const token = await getServiceAccountAccessToken(driveConfig.credentials);
        // Test call: get drive info / list root
        const testRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const testData = await testRes.json();

        return res.status(200).json({
          success: true,
          configured: true,
          clientEmail: driveConfig.credentials.client_email,
          rootFolderId: driveConfig.folderId || null,
          driveInfo: testData
        });
      } catch (err) {
        return res.status(200).json({
          success: true,
          configured: true,
          connected: false,
          error: err.message,
          clientEmail: driveConfig.credentials.client_email
        });
      }
    }

    // 2. CONFIGURE: Save Google Service Account credentials (Partner only)
    if (action === 'configure') {
      if (!checkRole(decoded, ['partner'])) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });
      }

      const { credentialsJson, clientEmail, privateKey, folderId } = req.body;
      let creds = null;

      if (credentialsJson) {
        try {
          const parsed = typeof credentialsJson === 'string' ? JSON.parse(credentialsJson) : credentialsJson;
          creds = {
            client_email: parsed.client_email,
            private_key: parsed.private_key
          };
        } catch (e) {
          return res.status(400).json({ success: false, message: 'Invalid service-account JSON.' });
        }
      } else if (clientEmail && privateKey) {
        creds = { client_email: clientEmail.trim(), private_key: privateKey.trim() };
      }

      if (!creds || !creds.client_email || !creds.private_key) {
        return res.status(400).json({ success: false, message: 'Service account client_email and private_key are required.' });
      }

      // Verify token immediately before saving
      await getServiceAccountAccessToken(creds);

      const settingsCol = db.collection('settings');
      await settingsCol.updateOne(
        { key: 'google_drive_config' },
        {
          $set: {
            key: 'google_drive_config',
            credentials: creds,
            folderId: folderId ? folderId.trim() : null,
            updatedAt: new Date(),
            updatedBy: decoded.username
          }
        },
        { upsert: true }
      );

      return res.status(200).json({
        success: true,
        message: 'Google Drive Service Account connected successfully!'
      });
    }

    // Check if configured for remaining file operations
    if (!driveConfig) {
      return res.status(400).json({
        success: false,
        message: 'Google Drive is not configured. Please configure service account in settings.'
      });
    }

    const token = await getServiceAccountAccessToken(driveConfig.credentials);

    // 3. LIST FILES: Search or list files for a client folder or overall
    if (action === 'listFiles') {
      const { clientCode, query } = req.query;
      let q = "trashed = false";

      if (clientCode) {
        q += ` and (name contains '${clientCode}' or description contains '${clientCode}')`;
      }
      if (query) {
        q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
      }
      if (driveConfig.folderId) {
        // If root folder is specified
        q += ` and '${driveConfig.folderId}' in parents`;
      }

      const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,description)&pageSize=50&orderBy=modifiedTime desc`;
      const gRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
      const gData = await gRes.json();

      if (!gRes.ok) {
        return res.status(500).json({ success: false, message: gData.error ? gData.error.message : 'Drive API error' });
      }

      return res.status(200).json({
        success: true,
        files: gData.files || []
      });
    }

    // 4. UPLOAD FILE: Upload file (base64 payload) to Drive
    if (action === 'upload') {
      const { fileName, mimeType, base64Data, clientCode, description } = req.body;
      if (!fileName || !base64Data) {
        return res.status(400).json({ success: false, message: 'fileName and base64Data are required.' });
      }

      const metadata = {
        name: clientCode ? `[${clientCode}] ${fileName}` : fileName,
        description: description || `Client Document for Code: ${clientCode || 'General'}`,
        parents: driveConfig.folderId ? [driveConfig.folderId] : []
      };

      const buffer = Buffer.from(base64Data, 'base64');
      const boundary = '-------314159265358979323846';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBody = Buffer.concat([
        Buffer.from(
          delimiter +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(metadata) +
          delimiter +
          `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
        ),
        buffer,
        Buffer.from(closeDelimiter)
      ]);

      const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });

      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) {
        return res.status(500).json({ success: false, message: uploadData.error ? uploadData.error.message : 'Upload failed' });
      }

      return res.status(200).json({
        success: true,
        message: 'File uploaded to Google Drive successfully.',
        file: uploadData
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid action.' });
  } catch (error) {
    console.error('Drive API error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Drive service error' });
  }
};
