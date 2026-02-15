require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const path = require('path');
const { body, validationResult } = require('express-validator');

const { 
  statements, 
  userStatements, 
  deviceStatements,
  createUser,
  recordDeviceFingerprint,
  hashPassword,
  verifyPassword
} = require('./database');

const { passport, isAuthenticated, ensureAuthenticated } = require('./auth');

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

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static('public'));

// Helper function to get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.socket.remoteAddress || 
         'unknown';
}

// Anti-abuse checks with device fingerprinting
function canVote(pollId, userId, deviceFingerprint, ipAddress, isChangingVote = false) {
  // Check 1: Has this user already voted?
  if (!isChangingVote) {
    const userVoteCheck = statements.hasUserVoted.get(pollId, userId);
    if (userVoteCheck.count > 0) {
      return { allowed: false, reason: 'You have already voted in this poll. Click "Change My Vote" to update your vote.' };
    }
  }
  
  // Check 2: Has this device already voted?
  if (!isChangingVote) {
    const deviceVoteCheck = statements.hasDeviceVoted.get(pollId, deviceFingerprint);
    if (deviceVoteCheck.count > 0) {
      return { allowed: false, reason: 'This device has already been used to vote in this poll' };
    }
  }

  // Check 3: Rate limiting - max vote actions per IP
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  const recentVotes = statements.getRecentVotesFromIP.get(pollId, ipAddress, fiveMinutesAgo);
  
  const maxActions = isChangingVote ? 10 : 5;
  
  if (recentVotes.count >= maxActions) {
    return { allowed: false, reason: 'Too many vote actions from your network. Please try again later' };
  }

  return { allowed: true };
}

// ============================================
// AUTHENTICATION ROUTES
// ============================================

// Register with email/password
app.post('/auth/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name } = req.body;

    // Check if user exists
    const existingUser = userStatements.getUserByEmail.get(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Create user
    const userId = createUser(email, password, null, name, null);
    const user = userStatements.getUserById.get(userId);

    // Log user in
    req.login(user, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to log in' });
      }
      res.json({ 
        success: true, 
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        }
      });
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login with email/password
app.post('/auth/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) {
      return res.status(500).json({ error: 'Authentication failed' });
    }
    if (!user) {
      return res.status(401).json({ error: info.message || 'Invalid credentials' });
    }
    req.login(user, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Login failed' });
      }
      res.json({ 
        success: true, 
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar_url: user.avatar_url
        }
      });
    });
  })(req, res, next);
});

// Google OAuth routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/');
  }
);

// Logout
app.post('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// Get current user
app.get('/auth/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      authenticated: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        avatar_url: req.user.avatar_url
      }
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ============================================
// POLL API ROUTES (PROTECTED)
// ============================================

// Create a new poll (requires authentication)
app.post('/api/polls', isAuthenticated, (req, res) => {
  try {
    const { question, options, pollType } = req.body;

    if (!question || !options || options.length < 2) {
      return res.status(400).json({ error: 'Question and at least 2 options are required' });
    }

    const pollId = uuidv4();
    const timestamp = Date.now();
    const allowMultiple = pollType === 'multiple' ? 1 : 0;
    const requireAuth = 1; // Always require auth

    // Create poll
    statements.createPoll.run(
      pollId, 
      question, 
      pollType || 'single', 
      allowMultiple, 
      req.user.id,
      requireAuth,
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

// Get poll data (requires authentication for voting)
app.get('/api/polls/:pollId', (req, res) => {
  try {
    const { pollId } = req.params;

    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    const options = statements.getOptions.all(pollId);
    
    let hasVoted = false;
    let votedOptionIds = [];
    let canUserVote = poll.require_auth && !req.isAuthenticated();

    if (req.isAuthenticated()) {
      // Check if user has voted
      const userVotes = statements.getUserVotes.all(pollId, req.user.id);
      hasVoted = userVotes.length > 0;
      votedOptionIds = userVotes.map(v => v.option_id);
    }

    // Get statistics
    const stats = statements.getPollStats.get(pollId);

    res.json({
      poll: {
        id: poll.id,
        question: poll.question,
        poll_type: poll.poll_type,
        allow_multiple: poll.allow_multiple,
        require_auth: poll.require_auth,
        createdAt: poll.created_at
      },
      options,
      hasVoted,
      votedOptionIds,
      requiresAuth: poll.require_auth === 1,
      stats: {
        uniqueVoters: stats?.unique_voters || 0,
        totalVotes: stats?.total_votes || 0,
        uniqueDevices: stats?.unique_devices || 0
      }
    });
  } catch (error) {
    console.error('Error fetching poll:', error);
    res.status(500).json({ error: 'Failed to fetch poll' });
  }
});

// Submit a vote (requires authentication)
app.post('/api/polls/:pollId/vote', isAuthenticated, (req, res) => {
  try {
    const { pollId } = req.params;
    const { optionId, optionIds, deviceFingerprint } = req.body;
    const userId = req.user.id;
    const ipAddress = getClientIP(req);
    const userAgent = req.headers['user-agent'] || '';

    if (!deviceFingerprint) {
      return res.status(400).json({ error: 'Device fingerprint required' });
    }

    // Validate poll exists
    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check if user has already voted
    const existingVotes = statements.getUserVotes.all(pollId, userId);
    const isChangingVote = existingVotes.length > 0;

    // Check anti-abuse rules
    const voteCheck = canVote(pollId, userId, deviceFingerprint, ipAddress, isChangingVote);
    if (!voteCheck.allowed) {
      return res.status(403).json({ error: voteCheck.reason });
    }

    // Record device fingerprint
    recordDeviceFingerprint(userId, deviceFingerprint, userAgent);

    // If changing vote, remove previous votes
    if (isChangingVote) {
      // Decrement counts for previous votes
      existingVotes.forEach(vote => {
        statements.decrementVoteCount.run(vote.option_id);
      });
      // Remove old vote records
      statements.removeUserVotes.run(pollId, userId);
    }

    const timestamp = Date.now();
    
    // Handle multiple choice or single choice
    const idsToVote = poll.allow_multiple && optionIds ? optionIds : [optionId];

    for (const id of idsToVote) {
      statements.recordVote.run(pollId, id, userId, deviceFingerprint, ipAddress, userAgent, timestamp);
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
        totalVotes: stats.total_votes,
        uniqueDevices: stats.unique_devices
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

// Add new option to existing poll (requires authentication + ownership)
app.post('/api/polls/:pollId/options', isAuthenticated, (req, res) => {
  try {
    const { pollId } = req.params;
    const { optionText } = req.body;

    if (!optionText || optionText.trim() === '') {
      return res.status(400).json({ error: 'Option text is required' });
    }

    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check ownership
    if (poll.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only poll creator can add options' });
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

// Delete option from poll (requires authentication + ownership)
app.delete('/api/polls/:pollId/options/:optionId', isAuthenticated, (req, res) => {
  try {
    const { pollId, optionId } = req.params;

    const poll = statements.getPoll.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check ownership
    if (poll.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only poll creator can delete options' });
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

// Get user's polls
app.get('/api/my-polls', isAuthenticated, (req, res) => {
  try {
    const polls = statements.getUserPolls.all(req.user.id);
    
    const pollsWithStats = polls.map(poll => {
      const options = statements.getOptions.all(poll.id);
      const stats = statements.getPollStats.get(poll.id);
      
      return {
        ...poll,
        optionCount: options.length,
        stats: {
          uniqueVoters: stats?.unique_voters || 0,
          totalVotes: stats?.total_votes || 0
        }
      };
    });

    res.json({ polls: pollsWithStats });
  } catch (error) {
    console.error('Error fetching user polls:', error);
    res.status(500).json({ error: 'Failed to fetch polls' });
  }
});

// ============================================
// PAGE ROUTES
// ============================================

// Serve the main page (requires authentication)
app.get('/', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve poll page (requires authentication)
app.get('/poll/:pollId', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'poll.html'));
});

// Login page
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Register page
app.get('/register', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// My polls page
app.get('/my-polls', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'my-polls.html'));
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
  console.log(`Visit http://localhost:${PORT} to access the app`);
  console.log(`Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? 'Enabled' : 'Disabled (set GOOGLE_CLIENT_ID)'}`);
});