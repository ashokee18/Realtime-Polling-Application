const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'polls.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    name TEXT,
    avatar_url TEXT,
    email_verified INTEGER DEFAULT 0,
    verification_token TEXT,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );

  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    poll_type TEXT DEFAULT 'single',
    allow_multiple INTEGER DEFAULT 0,
    created_by INTEGER NOT NULL,
    require_auth INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    option_text TEXT NOT NULL,
    vote_count INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES polls(id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    option_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    device_fingerprint TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    voted_at INTEGER NOT NULL,
    FOREIGN KEY (poll_id) REFERENCES polls(id),
    FOREIGN KEY (option_id) REFERENCES poll_options(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS device_fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    user_agent TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    vote_count INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
  CREATE INDEX IF NOT EXISTS idx_votes_user ON votes(user_id, poll_id);
  CREATE INDEX IF NOT EXISTS idx_votes_device ON votes(device_fingerprint, poll_id);
  CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id);
  CREATE INDEX IF NOT EXISTS idx_device_fp ON device_fingerprints(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_polls_creator ON polls(created_by);
`);

// Prepared statements for users
const userStatements = {
  createUser: db.prepare(`
    INSERT INTO users (email, password_hash, google_id, name, avatar_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  
  getUserByGoogleId: db.prepare('SELECT * FROM users WHERE google_id = ?'),
  
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  
  updateLastLogin: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
  
  verifyEmail: db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?'),
  
  updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
};

// Prepared statements for device fingerprints
const deviceStatements = {
  recordDevice: db.prepare(`
    INSERT INTO device_fingerprints (user_id, fingerprint, user_agent, first_seen, last_seen, vote_count)
    VALUES (?, ?, ?, ?, ?, 0)
  `),
  
  getDevice: db.prepare(`
    SELECT * FROM device_fingerprints 
    WHERE user_id = ? AND fingerprint = ?
  `),
  
  updateDeviceLastSeen: db.prepare(`
    UPDATE device_fingerprints 
    SET last_seen = ?, vote_count = vote_count + 1
    WHERE user_id = ? AND fingerprint = ?
  `),
  
  getDeviceVoteCount: db.prepare(`
    SELECT vote_count FROM device_fingerprints
    WHERE user_id = ? AND fingerprint = ?
  `)
};

// Prepared statements for polls
const statements = {
  // Poll operations
  createPoll: db.prepare(`
    INSERT INTO polls (id, question, poll_type, allow_multiple, created_by, require_auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  
  getPoll: db.prepare('SELECT * FROM polls WHERE id = ?'),
  
  getPollWithCreator: db.prepare(`
    SELECT p.*, u.name as creator_name, u.email as creator_email
    FROM polls p
    JOIN users u ON p.created_by = u.id
    WHERE p.id = ?
  `),
  
  getUserPolls: db.prepare(`
    SELECT * FROM polls WHERE created_by = ? ORDER BY created_at DESC
  `),
  
  updatePollQuestion: db.prepare('UPDATE polls SET question = ? WHERE id = ?'),
  
  // Option operations
  createOption: db.prepare(`
    INSERT INTO poll_options (poll_id, option_text, vote_count)
    VALUES (?, ?, 0)
  `),
  
  getOptions: db.prepare(`
    SELECT * FROM poll_options 
    WHERE poll_id = ? AND is_deleted = 0 
    ORDER BY id
  `),
  
  deleteOption: db.prepare('UPDATE poll_options SET is_deleted = 1 WHERE id = ?'),
  
  incrementVoteCount: db.prepare(`
    UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ?
  `),
  
  decrementVoteCount: db.prepare(`
    UPDATE poll_options SET vote_count = vote_count - 1 WHERE id = ? AND vote_count > 0
  `),
  
  // Vote operations
  recordVote: db.prepare(`
    INSERT INTO votes (poll_id, option_id, user_id, device_fingerprint, ip_address, user_agent, voted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  
  // Check if user has voted (by user_id)
  hasUserVoted: db.prepare(`
    SELECT COUNT(*) as count FROM votes 
    WHERE poll_id = ? AND user_id = ?
  `),
  
  // Check if device has voted
  hasDeviceVoted: db.prepare(`
    SELECT COUNT(*) as count FROM votes 
    WHERE poll_id = ? AND device_fingerprint = ?
  `),
  
  // Get user's votes for a poll
  getUserVotes: db.prepare(`
    SELECT option_id FROM votes 
    WHERE poll_id = ? AND user_id = ?
  `),
  
  // Remove all votes from a user for a poll
  removeUserVotes: db.prepare(`
    DELETE FROM votes 
    WHERE poll_id = ? AND user_id = ?
  `),
  
  // Check recent votes from IP (rate limiting)
  getRecentVotesFromIP: db.prepare(`
    SELECT COUNT(*) as count FROM votes 
    WHERE poll_id = ? AND ip_address = ? AND voted_at > ?
  `),
  
  // Get vote statistics
  getPollStats: db.prepare(`
    SELECT 
      COUNT(DISTINCT user_id) as unique_voters,
      COUNT(*) as total_votes,
      COUNT(DISTINCT device_fingerprint) as unique_devices
    FROM votes
    WHERE poll_id = ?
  `)
};

// Helper functions
async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

function createUser(email, password, googleId = null, name = null, avatarUrl = null) {
  const timestamp = Date.now();
  let passwordHash = null;
  
  if (password) {
    passwordHash = bcrypt.hashSync(password, 10);
  }
  
  const result = userStatements.createUser.run(
    email,
    passwordHash,
    googleId,
    name,
    avatarUrl,
    timestamp
  );
  
  return result.lastInsertRowid;
}

function recordDeviceFingerprint(userId, fingerprint, userAgent) {
  const timestamp = Date.now();
  const existing = deviceStatements.getDevice.get(userId, fingerprint);
  
  if (existing) {
    deviceStatements.updateDeviceLastSeen.run(timestamp, userId, fingerprint);
  } else {
    deviceStatements.recordDevice.run(userId, fingerprint, userAgent, timestamp, timestamp);
  }
}

module.exports = {
  db,
  statements,
  userStatements,
  deviceStatements,
  hashPassword,
  verifyPassword,
  createUser,
  recordDeviceFingerprint
};