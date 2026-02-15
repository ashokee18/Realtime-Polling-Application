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

// Helper function to get or create voter ID
function getVoterID(req, res) {
  let voterId = req.cookies.voter_id;
  if (!voterId) {
    voterId = uuidv4();
    res.cookie('voter_id', voterId, { 
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      httpOnly: true 
    });
  }
  return voterId;
}

// Anti-abuse checks
function canVote(pollId, voterId, ipAddress, isChangingVote = false) {
  // Check 1: Has this voter already voted?
  if (!isChangingVote) {
    const voterCheck = statements.hasVoterVoted.get(pollId, voterId);
    if (voterCheck.count > 0) {
      return { allowed: false, reason: 'You have already voted in this poll. Click "Change My Vote" to update your vote.' };
    }
  }

  // Check 2: Rate limiting - max vote actions per IP
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  const recentVotes = statements.getRecentVotesFromIP.get(pollId, ipAddress, fiveMinutesAgo);
  
  const maxActions = isChangingVote ? 10 : 5;
  
  if (recentVotes.count >= maxActions) {
    return { allowed: false, reason: 'Too many vote actions from your network. Please try again later' };
  }

  return { allowed: true };
}

// ============================================
// POLL API ROUTES
// ============================================

// Create a new poll
app.post('/api/polls', (req, res) => {
  try {
    const { question, options, pollType } = req.body;

    if (!question || !options || options.length < 2) {
      return res.status(400).json({ error: 'Question and at least 2 options are required' });
    }

    const pollId = uuidv4();
    const timestamp = Date.now();
    const allowMultiple = pollType === 'multiple' ? 1 : 0;
    const creatorId = getVoterID(req, res); // Use voter ID as creator ID

    // Create poll
    statements.createPoll.run(
      pollId, 
      question, 
      pollType || 'single', 
      allowMultiple,
      creatorId,
      timestamp
    );

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
    const voterId = getVoterID(req, res);

    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    const options = statements.getOptions.all(pollId);
    
    // Check if voter has voted
    const voterVotes = statements.getVoterVotes.all(pollId, voterId);
    const hasVoted = voterVotes.length > 0;
    const votedOptionIds = voterVotes.map(v => v.option_id);
    
    // Check if current user is the creator
    const isCreator = poll.creator_id === voterId;

    // Get statistics
    const stats = statements.getPollStats.get(pollId);

    res.json({
      poll: {
        id: poll.id,
        question: poll.question,
        poll_type: poll.poll_type,
        allow_multiple: poll.allow_multiple,
        createdAt: poll.created_at
      },
      options,
      hasVoted,
      votedOptionIds,
      isCreator, // NEW: Tell client if they created this poll
      stats: {
        uniqueVoters: stats?.unique_voters || 0,
        totalVotes: stats?.total_votes || 0
      }
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
    const { optionId, optionIds } = req.body;
    const voterId = getVoterID(req, res);
    const ipAddress = getClientIP(req);

    // Validate poll exists
    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check if voter has already voted
    const existingVotes = statements.getVoterVotes.all(pollId, voterId);
    const isChangingVote = existingVotes.length > 0;

    // Check anti-abuse rules
    const voteCheck = canVote(pollId, voterId, ipAddress, isChangingVote);
    if (!voteCheck.allowed) {
      return res.status(403).json({ error: voteCheck.reason });
    }

    // If changing vote, remove previous votes
    if (isChangingVote) {
      // Decrement counts for previous votes
      existingVotes.forEach(vote => {
        statements.decrementVoteCount.run(vote.option_id);
      });
      // Remove old vote records
      statements.removeVoterVotes.run(pollId, voterId);
    }

    const timestamp = Date.now();
    
    // Handle multiple choice or single choice
    const idsToVote = poll.allow_multiple && optionIds ? optionIds : [optionId];

    for (const id of idsToVote) {
      statements.recordVote.run(pollId, id, voterId, ipAddress, timestamp);
      statements.incrementVoteCount.run(id);
    }

    // Get updated results
    const options = statements.getOptions.all(pollId);
    const stats = statements.getPollStats.get(pollId);

    // Emit real-time update to all connected clients viewing this poll
    io.to(`poll-${pollId}`).emit('vote-update', { 
      options,
      stats: {
        uniqueVoters: stats.unique_voters,
        totalVotes: stats.total_votes
      }
    });

    res.json({ 
      success: true, 
      options,
      message: isChangingVote ? 'Vote changed successfully' : 'Vote recorded successfully'
    });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

// Add new option to existing poll (creator only)
app.post('/api/polls/:pollId/options', (req, res) => {
  try {
    const { pollId } = req.params;
    const { optionText } = req.body;
    const voterId = getVoterID(req, res);

    if (!optionText || optionText.trim() === '') {
      return res.status(400).json({ error: 'Option text is required' });
    }

    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check if current user is the creator
    if (poll.creator_id !== voterId) {
      return res.status(403).json({ error: 'Only the poll creator can add options' });
    }

    statements.createOption.run(pollId, optionText.trim());
    const options = statements.getOptions.all(pollId);

    // Emit update to all viewers
    io.to(`poll-${pollId}`).emit('options-update', { options });

    res.json({ success: true, options });
  } catch (error) {
    console.error('Error adding option:', error);
    res.status(500).json({ error: 'Failed to add option' });
  }
});

// Delete option from poll (creator only)
app.delete('/api/polls/:pollId/options/:optionId', (req, res) => {
  try {
    const { pollId, optionId } = req.params;
    const voterId = getVoterID(req, res);

    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check if current user is the creator
    if (poll.creator_id !== voterId) {
      return res.status(403).json({ error: 'Only the poll creator can delete options' });
    }

    statements.deleteOption.run(optionId);
    const options = statements.getOptions.all(pollId);

    // Emit update to all viewers
    io.to(`poll-${pollId}`).emit('options-update', { options });

    res.json({ success: true, options });
  } catch (error) {
    console.error('Error deleting option:', error);
    res.status(500).json({ error: 'Failed to delete option' });
  }
});

// ============================================
// PAGE ROUTES
// ============================================

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve poll page
app.get('/poll/:pollId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'poll.html'));
});

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-poll', (pollId) => {
    socket.join(`poll-${pollId}`);
    console.log(`Socket ${socket.id} joined poll-${pollId}`);
  });

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