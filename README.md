# 🎯 PollRooms - Real-Time Polling with Authentication

A professional, production-ready polling application with user authentication, device fingerprinting, and real-time updates.

## ✨ Features

- **Secure Authentication**: Email/password + Google OAuth
- **Device Fingerprinting**: One vote per email AND one vote per device
- **Real-Time Updates**: Socket.io for instant result synchronization
- **Poll Management**: Create, edit, and share polls
- **Vote Changing**: Users can update their votes
- **Multiple Poll Types**: Single-choice and multiple-choice
- **User Dashboard**: Track all your polls and statistics
- **Modern UI**: Beautiful dark theme with smooth animations
- **Mobile Responsive**: Works perfectly on all devices

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env and add SESSION_SECRET

# Start server
npm start

# Visit http://localhost:3000/login
```

## 📖 Full Documentation

See **COMPLETE_SETUP.md** for detailed instructions.

## 🔒 Security

- Triple-layer vote protection (email + device + IP)
- Bcrypt password hashing
- Secure session management
- Device fingerprinting
- Rate limiting

## 🌐 Deployment

Ready to deploy to:
- Render.com (recommended)
- Railway.app
- Heroku
- Any Node.js hosting

See COMPLETE_SETUP.md for deployment guides.

## 📊 Tech Stack

- **Backend**: Node.js, Express, Passport.js
- **Database**: SQLite (better-sqlite3)
- **Real-time**: Socket.io
- **Authentication**: Local + Google OAuth
- **Frontend**: Vanilla JS, HTML5, CSS3
- **Security**: bcrypt, device fingerprinting

## 📝 License

MIT License

## 🙏 Acknowledgments

Built for itsmyscreen hiring assignment.