// =============================================================================
// Sangam College Events Hub - Shared Cloud Backend & Persistent Database
// =============================================================================
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'sangam-db.json');

// Invite codes for special roles
const CODES = {
  organiser: 'ORG-2026',
  admin: 'ADMIN-2026'
};

const CATS = ['Technical', 'Workshop', 'Cultural', 'Sports', 'Competition', 'Talk', 'General'];

// Middleware
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Database Persistence Layer (Atomic, Zero-Dependency, Thread-Safe JSON Store)
// -----------------------------------------------------------------------------
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hashPassword(str) {
  return crypto.createHash('sha256').update(String(str || '')).digest('hex');
}

function generateId(prefix = '') {
  const id = crypto.randomBytes(6).toString('hex');
  return prefix ? `${prefix}-${id}` : id;
}

function getInitialDatabase() {
  const defaultPassword = hashPassword('password123');
  return {
    users: [
      { id: 'usr-student', name: 'Aarav Sharma', email: 'student@campus.edu', role: 'student', club: '', hash: defaultPassword, created_at: new Date().toISOString() },
      { id: 'usr-gdsc', name: 'Priya Verma', email: 'gdsc@campus.edu', role: 'organiser', club: 'Google Developer Student Club', hash: defaultPassword, created_at: new Date().toISOString() },
      { id: 'usr-acm', name: 'Rohan Mehta', email: 'acm@campus.edu', role: 'organiser', club: 'ACM Student Chapter', hash: defaultPassword, created_at: new Date().toISOString() },
      { id: 'usr-cultural', name: 'Ananya Iyer', email: 'cultural@campus.edu', role: 'organiser', club: 'Cultural & Dramatics Committee', hash: defaultPassword, created_at: new Date().toISOString() },
      { id: 'usr-sports', name: 'Vikram Singh', email: 'sports@campus.edu', role: 'organiser', club: 'Campus Sports Council', hash: defaultPassword, created_at: new Date().toISOString() },
      { id: 'usr-admin', name: 'Dr. S. K. Kulkarni', email: 'admin@campus.edu', role: 'admin', club: '', hash: defaultPassword, created_at: new Date().toISOString() }
    ],
    events: [],
    registrations: [],
    notifications: [],
    sessions: {}
  };
}

let db = null;

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
      if (!Array.isArray(db.users)) db.users = [];
      if (!Array.isArray(db.events)) db.events = [];
      if (!Array.isArray(db.registrations)) db.registrations = [];
      if (!Array.isArray(db.notifications)) db.notifications = [];
      if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
      return db;
    }
  } catch (err) {
    console.error('Error reading database file, creating fresh store:', err.message);
  }

  db = getInitialDatabase();
  saveDatabase();
  return db;
}

function saveDatabase() {
  try {
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('Error saving database:', err.message);
  }
}

// Initial load
loadDatabase();

// -----------------------------------------------------------------------------
// Authentication Helpers
// -----------------------------------------------------------------------------
function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    club: u.club || ''
  };
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-auth-token'] || req.query.token);

  if (!token || !db.sessions[token]) {
    req.user = null;
    return next();
  }

  const session = db.sessions[token];
  const user = db.users.find(u => u.id === session.userId);
  if (!user) {
    delete db.sessions[token];
    saveDatabase();
    req.user = null;
    return next();
  }

  req.token = token;
  req.user = user;
  next();
}

function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Please sign in to continue' });
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Your account doesn't have permission for this action" });
    }
    next();
  };
}

function addNotification(userId, title, body, eventId = '') {
  const notif = {
    id: generateId('notif'),
    user_id: userId,
    title,
    body,
    event_id: eventId,
    created: new Date().toISOString(),
    read: '0'
  };
  db.notifications.unshift(notif);
  if (db.notifications.length > 500) {
    db.notifications = db.notifications.slice(0, 500);
  }
  saveDatabase();
  return notif;
}

function formatEventOutput(event, currentUserId = null) {
  const regs = db.registrations.filter(r => r.event_id === event.id);
  const isRegistered = currentUserId ? regs.some(r => r.user_id === currentUserId) : false;
  const isPast = new Date(event.at).getTime() < Date.now();

  return {
    ...event,
    cap: event.cap ? parseInt(event.cap, 10) : null,
    count: regs.length,
    registered: isRegistered,
    past: isPast
  };
}

// Attach auth middleware to all /api routes
app.use('/api', authenticate);

// -----------------------------------------------------------------------------
// API Routes
// -----------------------------------------------------------------------------

// Health check & Server Status
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    time: new Date().toISOString(),
    version: '1.0.0',
    sharedDatabase: true,
    stats: {
      users: db.users.length,
      events: db.events.length,
      registrations: db.registrations.length,
      activeSessions: Object.keys(db.sessions).length
    }
  });
});

// GET /api/status - tells the frontend it is connected to the real cloud database
app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    storage: 'cloud-json-persistent',
    dbKey: 'sangam-live-server',
    time: new Date().toISOString()
  });
});

// POST /api/register
app.post('/api/register', (req, res) => {
  const { name, email, password, role, club, code } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim().slice(0, 80);

  if (!['student', 'organiser', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Choose a valid account role' });
  }
  if (!cleanName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter your name and a valid college email' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'Password needs at least 6 characters' });
  }

  let finalClub = '';
  if (role === 'organiser') {
    if (code !== CODES.organiser) {
      return res.status(400).json({ error: 'Invalid organiser invite code (hint: ORG-2026)' });
    }
    finalClub = String(club || '').trim().slice(0, 80);
    if (!finalClub) {
      return res.status(400).json({ error: 'Enter your club or committee name' });
    }
  }

  if (role === 'admin') {
    if (code !== CODES.admin) {
      return res.status(400).json({ error: 'Invalid admin invite code (hint: ADMIN-2026)' });
    }
  }

  if (db.users.some(u => u.email.toLowerCase() === cleanEmail)) {
    return res.status(400).json({ error: 'An account with this email already exists' });
  }

  const newUser = {
    id: generateId('usr'),
    name: cleanName,
    email: cleanEmail,
    role,
    club: finalClub,
    hash: hashPassword(password),
    created_at: new Date().toISOString()
  };

  db.users.push(newUser);

  // Create session
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId: newUser.id, created: Date.now() };
  saveDatabase();

  res.json({
    user: sanitizeUser(newUser),
    token
  });
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const inputHash = hashPassword(password);

  const user = db.users.find(u => u.email.toLowerCase() === cleanEmail);
  if (!user || user.hash !== inputHash) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId: user.id, created: Date.now() };
  saveDatabase();

  res.json({
    user: sanitizeUser(user),
    token
  });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  if (req.token && db.sessions[req.token]) {
    delete db.sessions[req.token];
    saveDatabase();
  }
  res.json({ ok: true });
});

// GET /api/me
app.get('/api/me', (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// GET /api/events - Public explore feed of approved, upcoming events
app.get('/api/events', (req, res) => {
  const currentUserId = req.user ? req.user.id : null;
  const now = Date.now();

  const publicEvents = db.events
    .filter(e => e.status === 'approved' && new Date(e.at).getTime() >= now)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .map(e => formatEventOutput(e, currentUserId));

  res.json(publicEvents);
});

// POST /api/events - Organiser submits an event
app.post('/api/events', requireAuth('organiser'), (req, res) => {
  const { title, desc, at, venue, cap, cat } = req.body || {};
  const cleanTitle = String(title || '').trim().slice(0, 120);
  const eventDate = new Date(at);

  if (!cleanTitle) {
    return res.status(400).json({ error: 'Please provide an event title' });
  }
  if (isNaN(eventDate.getTime()) || eventDate.getTime() < Date.now()) {
    return res.status(400).json({ error: 'Pick a future date and time for the event' });
  }

  const cleanCap = String(cap || '').trim();
  if (cleanCap && (!/^\d+$/.test(cleanCap) || parseInt(cleanCap, 10) <= 0)) {
    return res.status(400).json({ error: 'Seat capacity must be a positive number' });
  }

  const newEvent = {
    id: generateId('ev'),
    club: req.user.club,
    owner: req.user.id,
    status: 'pending',
    title: cleanTitle,
    desc: String(desc || '').slice(0, 1500),
    at: eventDate.toISOString().replace(/\.\d+Z$/, 'Z'),
    venue: String(venue || '').slice(0, 120),
    cap: cleanCap,
    cat: CATS.includes(cat) ? cat : 'General',
    created: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  };

  db.events.push(newEvent);

  // Notify admins
  db.users.filter(u => u.role === 'admin').forEach(adm => {
    addNotification(
      adm.id,
      'New Event Submission',
      `${newEvent.title} was submitted by ${req.user.club} and is pending approval.`,
      newEvent.id
    );
  });

  saveDatabase();
  res.json(formatEventOutput(newEvent, req.user.id));
});

// GET /api/my-events - Organiser's managed events
app.get('/api/my-events', requireAuth('organiser'), (req, res) => {
  const clubName = req.user.club.toLowerCase();
  const myEvents = db.events
    .filter(e => (e.club || '').toLowerCase() === clubName)
    .sort((a, b) => new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime())
    .map(e => formatEventOutput(e, req.user.id));

  res.json(myEvents);
});

// GET /api/my-registrations - Student's RSVP list
app.get('/api/my-registrations', requireAuth('student'), (req, res) => {
  const myRegEventIds = db.registrations
    .filter(r => r.user_id === req.user.id)
    .map(r => r.event_id);

  const registeredEvents = db.events
    .filter(e => myRegEventIds.includes(e.id))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .map(e => formatEventOutput(e, req.user.id));

  res.json(registeredEvents);
});

// GET /api/admin/events - Admin Approvals Center
app.get('/api/admin/events', requireAuth('admin'), (req, res) => {
  const allEvents = db.events
    .map(e => formatEventOutput(e, req.user.id))
    .sort((a, b) => new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime());

  res.json(allEvents);
});

// GET /api/notifications
app.get('/api/notifications', requireAuth(), (req, res) => {
  const userNotes = db.notifications
    .filter(n => n.user_id === req.user.id)
    .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
    .slice(0, 40);

  res.json(userNotes);
});

// POST /api/notifications/read
app.post('/api/notifications/read', requireAuth(), (req, res) => {
  db.notifications.forEach(n => {
    if (n.user_id === req.user.id) n.read = '1';
  });
  saveDatabase();
  res.json({ ok: true });
});

// GET /api/events/:id - Event details
app.get('/api/events/:id', (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const isOwner = req.user && req.user.role === 'organiser' && (req.user.club || '').toLowerCase() === (event.club || '').toLowerCase();
  const isAdmin = req.user && req.user.role === 'admin';

  if (event.status !== 'approved' && !isOwner && !isAdmin) {
    return res.status(404).json({ error: 'Event not found' });
  }

  res.json(formatEventOutput(event, req.user ? req.user.id : null));
});

// PUT /api/events/:id - Edit event
app.put('/api/events/:id', requireAuth('organiser'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const isOwner = (req.user.club || '').toLowerCase() === (event.club || '').toLowerCase();
  if (!isOwner) {
    return res.status(403).json({ error: 'This event belongs to another club' });
  }

  if (event.status === 'approved' || new Date(event.at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Approved events cannot be edited directly. Cancel it and post a revised event.' });
  }

  const { title, desc, at, venue, cap, cat } = req.body || {};
  const cleanTitle = String(title || '').trim().slice(0, 120);
  const eventDate = new Date(at);

  if (!cleanTitle) {
    return res.status(400).json({ error: 'Please provide an event title' });
  }
  if (isNaN(eventDate.getTime()) || eventDate.getTime() < Date.now()) {
    return res.status(400).json({ error: 'Pick a future date and time for the event' });
  }

  const cleanCap = String(cap || '').trim();
  if (cleanCap && (!/^\d+$/.test(cleanCap) || parseInt(cleanCap, 10) <= 0)) {
    return res.status(400).json({ error: 'Seat capacity must be a positive number' });
  }

  event.title = cleanTitle;
  event.desc = String(desc || '').slice(0, 1500);
  event.at = eventDate.toISOString().replace(/\.\d+Z$/, 'Z');
  event.venue = String(venue || '').slice(0, 120);
  event.cap = cleanCap;
  event.cat = CATS.includes(cat) ? cat : 'General';
  event.status = 'pending';

  saveDatabase();
  res.json(formatEventOutput(event, req.user.id));
});

// DELETE /api/events/:id - Cancel/delete event
app.delete('/api/events/:id', requireAuth('organiser', 'admin'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const isOwner = req.user.role === 'organiser' && (req.user.club || '').toLowerCase() === (event.club || '').toLowerCase();
  const isAdmin = req.user.role === 'admin';

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'This event belongs to another club' });
  }

  // If approved and in the future, notify attendees of cancellation
  if (event.status === 'approved' && new Date(event.at).getTime() >= Date.now()) {
    const attendees = db.registrations.filter(r => r.event_id === event.id);
    attendees.forEach(r => {
      addNotification(
        r.user_id,
        'Event Cancelled',
        `"${event.title}" by ${event.club} has been cancelled by the organizers.`,
        event.id
      );
    });
  }

  db.events = db.events.filter(e => e.id !== event.id);
  db.registrations = db.registrations.filter(r => r.event_id !== event.id);
  saveDatabase();

  res.json({ ok: true });
});

// POST /api/events/:id/decision - Admin approves/rejects
app.post('/api/events/:id/decision', requireAuth('admin'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const { decision } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or rejected' });
  }
  if (event.status !== 'pending') {
    return res.status(400).json({ error: "This event isn't pending a decision" });
  }

  event.status = decision;

  addNotification(
    event.owner,
    `Event ${decision.toUpperCase()}`,
    `"${event.title}" was ${decision} by campus administration.` +
      (decision === 'approved' ? ' It is now live on Sangam for student registrations!' : ' Edit details and resubmit.'),
    event.id
  );

  saveDatabase();
  res.json(formatEventOutput(event, req.user.id));
});

// POST /api/events/:id/register - Student RSVP
app.post('/api/events/:id/register', requireAuth('student'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }
  if (event.status !== 'approved' || new Date(event.at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Registration is closed for this event' });
  }

  const existing = db.registrations.find(r => r.event_id === event.id && r.user_id === req.user.id);
  if (existing) {
    return res.status(400).json({ error: 'You are already registered for this event' });
  }

  const currentCount = db.registrations.filter(r => r.event_id === event.id).length;
  if (event.cap && currentCount >= parseInt(event.cap, 10)) {
    return res.status(400).json({ error: 'This event has reached full capacity' });
  }

  const { name, year, branch } = req.body || {};
  if (!name || !year || !branch) {
    return res.status(400).json({ error: 'Please fill in your name, academic year, and branch' });
  }

  const reg = {
    id: generateId('reg'),
    event_id: event.id,
    user_id: req.user.id,
    name: String(name).slice(0, 80),
    year: String(year).slice(0, 10),
    branch: String(branch).slice(0, 40),
    created: new Date().toISOString()
  };

  db.registrations.push(reg);

  addNotification(
    req.user.id,
    'Registration Confirmed 🎉',
    `You are registered for "${event.title}" by ${event.club}. Venue: ${event.venue || 'TBA'}`,
    event.id
  );

  saveDatabase();
  res.json({ ok: true, registration: reg });
});

// DELETE /api/events/:id/register - Cancel RSVP
app.delete('/api/events/:id/register', requireAuth('student'), (req, res) => {
  db.registrations = db.registrations.filter(
    r => !(r.event_id === req.params.id && r.user_id === req.user.id)
  );
  saveDatabase();
  res.json({ ok: true });
});

// GET /api/events/:id/registrants - Attendee roster
app.get('/api/events/:id/registrants', requireAuth('organiser', 'admin'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const isOwner = req.user.role === 'organiser' && (req.user.club || '').toLowerCase() === (event.club || '').toLowerCase();
  const isAdmin = req.user.role === 'admin';

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Access restricted to event organizer or administrator' });
  }

  const attendees = db.registrations
    .filter(r => r.event_id === event.id)
    .map(r => {
      const user = db.users.find(u => u.id === r.user_id);
      return {
        ...r,
        email: user ? user.email : 'N/A'
      };
    });

  res.json(attendees);
});

// GET /api/data - Full CSV export data
app.get('/api/data', (req, res) => {
  res.json({
    users: db.users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, club: u.club })),
    events: db.events,
    registrations: db.registrations,
    notifications: db.notifications
  });
});

// POST /api/reset - Clear data back to 0 events
app.post('/api/reset', (req, res) => {
  db.events = [];
  db.registrations = [];
  db.notifications = [];
  db.sessions = {};
  saveDatabase();
  res.json({ ok: true, message: 'Database reset to clean 0-events state' });
});

// -----------------------------------------------------------------------------
// Static Frontend Serving (Root, Assets, HTML)
// -----------------------------------------------------------------------------
app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 SANGAM Backend Server running on port ${PORT}`);
  console.log(`🌐 Live URL: http://localhost:${PORT}`);
  console.log(`💾 Database file: ${DB_FILE}`);
  console.log(`👥 Seeded accounts: ${db.users.length}`);
  console.log(`📅 Live events: ${db.events.length}`);
  console.log('====================================================');
});
