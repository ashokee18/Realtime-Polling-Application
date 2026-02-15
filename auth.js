const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { userStatements, verifyPassword } = require('./database');

// Serialize user for session
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser((id, done) => {
  try {
    const user = userStatements.getUserById.get(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// Local Strategy (Email/Password)
passport.use(new LocalStrategy(
  {
    usernameField: 'email',
    passwordField: 'password'
  },
  async (email, password, done) => {
    try {
      const user = userStatements.getUserByEmail.get(email);
      
      if (!user) {
        return done(null, false, { message: 'Invalid email or password' });
      }
      
      if (!user.password_hash) {
        return done(null, false, { message: 'Please sign in with Google' });
      }
      
      const isValid = await verifyPassword(password, user.password_hash);
      
      if (!isValid) {
        return done(null, false, { message: 'Invalid email or password' });
      }
      
      // Update last login
      userStatements.updateLastLogin.run(Date.now(), user.id);
      
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));

// Google OAuth Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists with this Google ID
        let user = userStatements.getUserByGoogleId.get(profile.id);
        
        if (user) {
          // Update last login
          userStatements.updateLastLogin.run(Date.now(), user.id);
          return done(null, user);
        }
        
        // Check if user exists with this email
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        
        if (email) {
          user = userStatements.getUserByEmail.get(email);
          
          if (user) {
            // Link Google account to existing user
            // Update user with Google ID
            // For now, just return error
            return done(null, false, { 
              message: 'Email already registered. Please sign in with email/password.' 
            });
          }
        }
        
        // Create new user
        const { createUser } = require('./database');
        const name = profile.displayName || profile.name?.givenName || 'User';
        const avatarUrl = profile.photos && profile.photos[0] ? profile.photos[0].value : null;
        
        const userId = createUser(email, null, profile.id, name, avatarUrl);
        user = userStatements.getUserById.get(userId);
        
        // Mark email as verified since it's from Google
        userStatements.verifyEmail.run(userId);
        
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }
  ));
}

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required', redirect: '/login' });
}

// Middleware to check if user is authenticated (for HTML pages)
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
}

module.exports = {
  passport,
  isAuthenticated,
  ensureAuthenticated
};