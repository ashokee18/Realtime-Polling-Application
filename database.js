const Database = require('better-sqlite3');
const path = require('path');

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'polls.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    poll_type TEXT DEFAULT 'single',
    allow_multiple INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
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
    device_fingerprint TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    voted_at INTEGER NOT NULL,
    FOREIGN KEY (poll_id) REFERENCES polls(id),
    FOREIGN KEY (option_id) REFERENCES poll_options(id)
  );

  CREATE INDEX IF NOT EXISTS idx_votes_device ON votes(device_fingerprint, poll_id);
  CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id);
  CREATE INDEX IF NOT EXISTS idx_votes_ip ON votes(ip_address, poll_id, voted_at);
`);

// Prepared statements
const statements = {
  // Poll operations
  createPoll: db.prepare(`
    INSERT INTO polls (id, question, poll_type, allow_multiple, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  
  getPoll: db.prepare('SELECT * FROM polls WHERE id = ?'),
  
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
    INSERT INTO votes (poll_id, option_id, device_fingerprint, ip_address, user_agent, voted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  
  // Check if device has voted
  hasDeviceVoted: db.prepare(`
    SELECT COUNT(*) as count FROM votes 
    WHERE poll_id = ? AND device_fingerprint = ?
  `),
  
  // Get device's votes for a poll
  getDeviceVotes: db.prepare(`
    SELECT option_id FROM votes 
    WHERE poll_id = ? AND device_fingerprint = ?
  `),
  
  // Remove all votes from a device for a poll
  removeDeviceVotes: db.prepare(`
    DELETE FROM votes 
    WHERE poll_id = ? AND device_fingerprint = ?
  `),
  
  // Check recent votes from IP (rate limiting)
  getRecentVotesFromIP: db.prepare(`
    SELECT COUNT(*) as count FROM votes 
    WHERE poll_id = ? AND ip_address = ? AND voted_at > ?
  `),
  
  // Get vote statistics
  getPollStats: db.prepare(`
    SELECT 
      COUNT(DISTINCT device_fingerprint) as unique_devices,
      COUNT(*) as total_votes
    FROM votes
    WHERE poll_id = ?
  `)
};

module.exports = {
  db,
  statements
};