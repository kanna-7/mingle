const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const bcryptjs = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database initialization
const db = new sqlite3.Database(path.join(__dirname, 'chatapp.db'), (err) => {
  if (err) {
    console.log('Error opening database:', err);
  } else {
    console.log('Database connected successfully');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT,
      bio TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Friends table
    db.run(`CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (friend_id) REFERENCES users(id),
      UNIQUE(user_id, friend_id)
    )`);

    // Messages table
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      message TEXT,
      image_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id)
    )`);

    // Insert admin user if not exists
    const hashedPassword = bcryptjs.hashSync('12345', 10);
    db.run(
      `INSERT OR IGNORE INTO users (username, nickname, password, bio) VALUES (?, ?, ?, ?)`,
      ['admin', 'Admin User', hashedPassword, 'I am the admin'],
      (err) => {
        if (err) {
          console.log('Error inserting admin:', err);
        } else {
          console.log('Admin user ready (admin/12345)');
        }
      }
    );
  });
}

// Store online users
const onlineUsers = new Map();

// Routes

// Register
app.post('/register', (req, res) => {
  const { username, nickname, password, confirmPassword } = req.body;

  if (!username || !nickname || !password) {
    return res.status(400).json({ success: false, message: 'All fields required' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Passwords do not match' });
  }

  const hashedPassword = bcryptjs.hashSync(password, 10);

  db.run(
    `INSERT INTO users (username, nickname, password) VALUES (?, ?, ?)`,
    [username, nickname, hashedPassword],
    function(err) {
      if (err) {
        return res.status(400).json({ success: false, message: 'Username already exists' });
      }
      res.json({ success: true, message: 'Registration successful', userId: this.lastID });
    }
  );
});

// Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }

    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    const isPasswordValid = bcryptjs.compareSync(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }

    res.json({ success: true, message: 'Login successful', user: { id: user.id, username: user.username, nickname: user.nickname, isAdmin: user.username === 'admin' } });
  });
});

// Get all users (excluding self)
app.get('/users/:userId', (req, res) => {
  const userId = req.params.userId;

  db.all(`SELECT id, username, nickname, avatar, bio FROM users WHERE id != ?`, [userId], (err, users) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error' });
    }
    res.json({ success: true, users });
  });
});

// Add friend
app.post('/add-friend', (req, res) => {
  const { userId, friendId } = req.body;

  db.run(
    `INSERT INTO friends (user_id, friend_id) VALUES (?, ?)`,
    [userId, friendId],
    (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: 'Friend already added' });
      }
      res.json({ success: true, message: 'Friend added successfully' });
    }
  );
});

// Get friends list
app.get('/friends/:userId', (req, res) => {
  const userId = req.params.userId;

  db.all(
    `SELECT u.id, u.username, u.nickname, u.avatar FROM users u 
     INNER JOIN friends f ON u.id = f.friend_id 
     WHERE f.user_id = ?`,
    [userId],
    (err, friends) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      res.json({ success: true, friends });
    }
  );
});

// Get chat history
app.get('/messages/:userId/:friendId', (req, res) => {
  const { userId, friendId } = req.params;

  db.all(
    `SELECT * FROM messages 
     WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
     ORDER BY created_at ASC`,
    [userId, friendId, friendId, userId],
    (err, messages) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      res.json({ success: true, messages });
    }
  );
});

// Get all users for admin
app.get('/admin/users/:userId', (req, res) => {
  const userId = req.params.userId;

  db.get(`SELECT username FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err || !user || user.username !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    db.all(`SELECT id, username, nickname, created_at FROM users`, (err, users) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      res.json({ success: true, users });
    });
  });
});

// Delete user (admin)
app.delete('/admin/user/:adminId/:userId', (req, res) => {
  const { adminId, userId } = req.params;

  db.get(`SELECT username FROM users WHERE id = ?`, [adminId], (err, admin) => {
    if (err || !admin || admin.username !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    db.run(`DELETE FROM users WHERE id = ?`, [userId], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error' });
      }
      res.json({ success: true, message: 'User deleted successfully' });
    });
  });
});

// Get all chats for admin
app.get('/admin/chats/:userId', (req, res) => {
  const userId = req.params.userId;

  db.get(`SELECT username FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err || !user || user.username !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    db.all(
      `SELECT m.*, u1.username as sender, u2.username as receiver 
       FROM messages m 
       JOIN users u1 ON m.sender_id = u1.id 
       JOIN users u2 ON m.receiver_id = u2.id 
       ORDER BY m.created_at DESC LIMIT 100`,
      (err, messages) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.json({ success: true, messages });
      }
    );
  });
});

// Socket.io events
io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  socket.on('user_login', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('online_users', Array.from(onlineUsers.keys()));
  });

  socket.on('send_message', (data) => {
    const { senderId, receiverId, message, timestamp } = data;

    // ALWAYS save message to database (offline or online)
    db.run(
      `INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)`,
      [senderId, receiverId, message],
      (err) => {
        if (err) {
          console.log('Error saving message:', err);
          return;
        }
        
        // Try to deliver if online
        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit('receive_message', {
            senderId,
            message,
            timestamp
          });
        } else {
          console.log(`Message saved for offline user ${receiverId}`);
        }
      }
    );
  });

  socket.on('send_image', (data) => {
    const { senderId, receiverId, imageData, timestamp } = data;

    // ALWAYS save image to database (offline or online)
    db.run(
      `INSERT INTO messages (sender_id, receiver_id, image_data) VALUES (?, ?, ?)`,
      [senderId, receiverId, imageData],
      (err) => {
        if (err) {
          console.log('Error saving image:', err);
          return;
        }
        
        // Try to deliver if online
        const receiverSocket = onlineUsers.get(receiverId);
        if (receiverSocket) {
          io.to(receiverSocket).emit('receive_image', {
            senderId,
            imageData,
            timestamp
          });
        } else {
          console.log(`Image saved for offline user ${receiverId}`);
        }
      }
    );
  });

  socket.on('typing', (data) => {
    const receiverSocket = onlineUsers.get(data.receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('user_typing', { senderId: data.senderId });
    }
  });

  socket.on('disconnect', () => {
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        break;
      }
    }
    io.emit('online_users', Array.from(onlineUsers.keys()));
    console.log('User disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ChatHub server running on http://localhost:${PORT}`);
  console.log('Admin Login: admin / 12345');
});
