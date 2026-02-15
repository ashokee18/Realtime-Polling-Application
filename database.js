const Database = require('better-sqlite3');
const path = require('path');

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'polls.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    option_text TEXT NOT NULL,
    vote_count INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES polls(id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    option_id INTEGER NOT NULL,
    voter_fingerprint TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    voted_at INTEGER NOT NULL,
    FOREIGN KEY (poll_id) REFERENCES polls(id),
    FOREIGN KEY (option_id) REFERENCES poll_options(id)
  );

  CREATE INDEX IF NOT EXISTS idx_votes_fingerprint ON votes(voter_fingerprint, poll_id);
  CREATE INDEX IF NOT EXISTS idx_votes_ip ON votes(ip_address, poll_id, voted_at);
`);

// Prepared statements
const statements = {
  // Poll operations
  createPoll: db.prepare('INSERT INTO polls (id, question, created_at) VALUES (?, ?, ?)'),
  
  getPoll: db.prepare('SELECT * FROM polls WHERE id = ?'),
  
  // Option operations
  createOption: db.prepare('INSERT INTO poll_options (poll_id, option_text, vote_count) VALUES (?, ?, 0)'),
  
  getOptions: db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY id'),
  
  incrementVoteCount: db.prepare('UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ?'),
  
  // Vote operations
  recordVote: db.prepare(`
    INSERT INTO votes (poll_id, option_id, voter_fingerprint, ip_address, voted_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  
  // Check if user has voted (fingerprint check)
  hasVotedFingerprint: db.prepare(`
    SELECT COUNT(*) as count FROM votes 
    WHERE poll_id = ? AND voter_fingerprint = ?
  `),
  
  // Check recent votes from IP (rate limiting)
  getRecentVotesFromIP: db.prepare(`
    SELECT COUNT(*) as count FROM votes 
    WHERE poll_id = ? AND ip_address = ? AND voted_at > ?
  `),
  
  // Get all votes for a poll (for debugging)
  getVotesForPoll: db.prepare('SELECT * FROM votes WHERE poll_id = ? ORDER BY voted_at DESC')
};

module.exports = {
  db,
  statements
};
