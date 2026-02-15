const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const path = require('path');
const { statements } = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// Helper function to get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.socket.remoteAddress || 
         'unknown';
}

// Helper function to get or create voter fingerprint
function getVoterFingerprint(req, res) {
  let fingerprint = req.cookies.voter_id;
  if (!fingerprint) {
    fingerprint = uuidv4();
    res.cookie('voter_id', fingerprint, { 
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      httpOnly: true 
    });
  }
  return fingerprint;
}

// Anti-abuse checks
function canVote(pollId, fingerprint, ipAddress) {
  // Check 1: Has this fingerprint already voted?
  const fingerprintCheck = statements.hasVotedFingerprint.get(pollId, fingerprint);
  if (fingerprintCheck.count > 0) {
    return { allowed: false, reason: 'You have already voted in this poll' };
  }

  // Check 2: Rate limiting - max 3 votes per IP per poll in last 5 minutes
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  const recentVotes = statements.getRecentVotesFromIP.get(pollId, ipAddress, fiveMinutesAgo);
  if (recentVotes.count >= 3) {
    return { allowed: false, reason: 'Too many votes from your network. Please try again later' };
  }

  return { allowed: true };
}

// API Routes

// Create a new poll
app.post('/api/polls', (req, res) => {
  try {
    const { question, options } = req.body;

    if (!question || !options || options.length < 2) {
      return res.status(400).json({ error: 'Question and at least 2 options are required' });
    }

    const pollId = uuidv4();
    const timestamp = Date.now();

    // Create poll
    statements.createPoll.run(pollId, question, timestamp);

    // Create options
    for (const option of options) {
      statements.createOption.run(pollId, option);
    }

    res.json({ 
      success: true, 
      pollId,
      shareUrl: `${req.protocol}://${req.get('host')}/poll/${pollId}`
    });
  } catch (error) {
    console.error('Error creating poll:', error);
    res.status(500).json({ error: 'Failed to create poll' });
  }
});

// Get poll data
app.get('/api/polls/:pollId', (req, res) => {
  try {
    const { pollId } = req.params;
    const fingerprint = getVoterFingerprint(req, res);

    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    const options = statements.getOptions.all(pollId);
    
    // Check if user has already voted
    const hasVoted = statements.hasVotedFingerprint.get(pollId, fingerprint);

    res.json({
      poll: {
        id: poll.id,
        question: poll.question,
        createdAt: poll.created_at
      },
      options,
      hasVoted: hasVoted.count > 0
    });
  } catch (error) {
    console.error('Error fetching poll:', error);
    res.status(500).json({ error: 'Failed to fetch poll' });
  }
});

// Submit a vote
app.post('/api/polls/:pollId/vote', (req, res) => {
  try {
    const { pollId } = req.params;
    const { optionId } = req.body;
    const fingerprint = getVoterFingerprint(req, res);
    const ipAddress = getClientIP(req);

    // Validate poll exists
    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check anti-abuse rules
    const voteCheck = canVote(pollId, fingerprint, ipAddress);
    if (!voteCheck.allowed) {
      return res.status(403).json({ error: voteCheck.reason });
    }

    // Record vote
    const timestamp = Date.now();
    statements.recordVote.run(pollId, optionId, fingerprint, ipAddress, timestamp);
    statements.incrementVoteCount.run(optionId);

    // Get updated results
    const options = statements.getOptions.all(pollId);

    // Emit real-time update to all connected clients viewing this poll
    io.to(`poll-${pollId}`).emit('vote-update', { options });

    res.json({ 
      success: true, 
      options 
    });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve poll page
app.get('/poll/:pollId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'poll.html'));
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join a poll room
  socket.on('join-poll', (pollId) => {
    socket.join(`poll-${pollId}`);
    console.log(`Socket ${socket.id} joined poll-${pollId}`);
  });

  // Leave a poll room
  socket.on('leave-poll', (pollId) => {
    socket.leave(`poll-${pollId}`);
    console.log(`Socket ${socket.id} left poll-${pollId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to create a poll`);
});
