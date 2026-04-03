/**
 * BusIQ v2 — Production Backend
 * Node.js + Express + SQLite + Socket.IO + Razorpay
 */
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const Razorpay   = require('razorpay');
const { v4: uuidv4 } = require('uuid');
const Database   = require('better-sqlite3');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT            = process.env.PORT || 3000;
const JWT_SECRET      = process.env.JWT_SECRET || 'busiq_v2_secret_2025';
const RZP_KEY_ID      = process.env.RAZORPAY_KEY_ID  || 'rzp_test_DEMO';
const RZP_SECRET      = process.env.RAZORPAY_SECRET   || 'DEMO_SECRET';
const CARBON_PER_KM_CAR = 0.12; // kg CO2 per km for average car
const CARBON_PER_KM_BUS = 0.03; // kg CO2 per km per passenger (bus with avg occupancy)

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

/* ─── DATABASE ─────────────────────────────────────── */
const db = new Database(path.join(__dirname, 'busiq.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('passenger','conductor','admin')),
  avatar TEXT, wallet REAL DEFAULT 0, is_verified INT DEFAULT 0,
  is_active INT DEFAULT 1, home_stop TEXT, work_stop TEXT,
  weekly_pass_expiry TEXT, trip_count INT DEFAULT 0,
  fcm_token TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY, route_number TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  origin TEXT NOT NULL, destination TEXT NOT NULL, stops TEXT NOT NULL,
  stop_coords TEXT, distance_km REAL, duration_min INT,
  fare_per_km REAL DEFAULT 1.5, base_fare REAL DEFAULT 10,
  weekly_pass_fare REAL DEFAULT 150, surge_multiplier REAL DEFAULT 1.0,
  is_active INT DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS buses (
  id TEXT PRIMARY KEY, bus_number TEXT UNIQUE NOT NULL,
  route_id TEXT REFERENCES routes(id), conductor_id TEXT REFERENCES users(id),
  capacity INT DEFAULT 50, model TEXT, reg_number TEXT,
  last_service TEXT, is_active INT DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, bus_id TEXT REFERENCES buses(id),
  route_id TEXT REFERENCES routes(id), departure TEXT NOT NULL,
  arrival TEXT NOT NULL, date TEXT NOT NULL,
  status TEXT DEFAULT 'scheduled'
);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, schedule_id TEXT, bus_id TEXT, conductor_id TEXT,
  route_id TEXT, started_at TEXT, ended_at TEXT,
  status TEXT DEFAULT 'not_started', delay_minutes INT DEFAULT 0,
  current_stop_idx INT DEFAULT 0, lat REAL, lng REAL,
  speed REAL DEFAULT 0, heading REAL DEFAULT 0,
  passenger_count INT DEFAULT 0, fare_collected REAL DEFAULT 0,
  deviation_alert INT DEFAULT 0, sos_active INT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
  trip_id TEXT REFERENCES trips(id), route_id TEXT,
  from_stop TEXT NOT NULL, to_stop TEXT NOT NULL,
  seat_number TEXT NOT NULL, passengers INT DEFAULT 1,
  fare REAL NOT NULL, surge_applied REAL DEFAULT 1.0,
  payment_status TEXT DEFAULT 'pending', payment_method TEXT DEFAULT 'razorpay',
  payment_id TEXT, order_id TEXT, qr_code TEXT UNIQUE,
  boarded INT DEFAULT 0, boarded_at TEXT, alighted INT DEFAULT 0, alighted_at TEXT,
  auto_refunded INT DEFAULT 0, status TEXT DEFAULT 'pending',
  queue_token INT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, booking_id TEXT, user_id TEXT,
  amount REAL, currency TEXT DEFAULT 'INR', method TEXT,
  rz_order TEXT, rz_payment TEXT, rz_sig TEXT,
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
  type TEXT, amount REAL, balance_after REAL,
  description TEXT, ref_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT, type TEXT, title TEXT,
  message TEXT, is_read INT DEFAULT 0, action_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS seat_locks (
  trip_id TEXT, seat_number TEXT, user_id TEXT,
  locked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(trip_id, seat_number)
);
CREATE TABLE IF NOT EXISTS traffic_alerts (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
  lat REAL, lng REAL, alert_type TEXT, description TEXT,
  upvotes INT DEFAULT 0, is_verified INT DEFAULT 0,
  expires_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS queue_tokens (
  id TEXT PRIMARY KEY, trip_id TEXT, user_id TEXT,
  token_number INT, status TEXT DEFAULT 'waiting',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conductor_metrics (
  id TEXT PRIMARY KEY, conductor_id TEXT, date TEXT,
  trips_completed INT DEFAULT 0, passengers_served INT DEFAULT 0,
  revenue_collected REAL DEFAULT 0, avg_delay_mins REAL DEFAULT 0,
  sos_incidents INT DEFAULT 0, rating REAL DEFAULT 5.0
);
CREATE TABLE IF NOT EXISTS demand_heatmap (
  id TEXT PRIMARY KEY, stop_name TEXT, hour INT, day_of_week INT,
  avg_demand REAL, recorded_at TEXT DEFAULT (datetime('now'))
);

-- SDG Tables
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id),
  incident_type TEXT NOT NULL,
  description TEXT NOT NULL,
  location_lat REAL,
  location_lng REAL,
  trip_id TEXT REFERENCES trips(id),
  status TEXT DEFAULT 'reported' CHECK(status IN ('reported', 'investigating', 'resolved', 'rejected')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ev_charging_stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_lat REAL NOT NULL,
  location_lng REAL NOT NULL,
  address TEXT NOT NULL,
  operator TEXT,
  connector_types TEXT,
  power_kw REAL,
  is_active INT DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Add subsidized columns to users table
try { db.prepare('ALTER TABLE users ADD COLUMN subsidized_type TEXT').run(); } catch(e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN subsidized_verified INT DEFAULT 0').run(); } catch(e) {}

/* ─── SEED ─────────────────────────────────────────── */
function seed() {
  if (db.prepare('SELECT COUNT(*) as c FROM users').get().c > 0) return;
  const h = bcrypt.hashSync('password123', 10);
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  // Users
  [
    ['admin-001','Admin BusIQ','admin@busiq.in','9000000001',h,'admin',null,99999],
    ['cond-001','Ramesh Kumar','ramesh@busiq.in','9000000011',h,'conductor',null,0],
    ['cond-002','Suresh Yadav','suresh@busiq.in','9000000012',h,'conductor',null,0],
    ['cond-003','Priya Sharma','priya@busiq.in','9000000013',h,'conductor',null,0],
    ['user-001','Rahul Verma','rahul@gmail.com','9876543201',h,'passenger','Central Bus Stand',500],
    ['user-002','Meera Patel','meera@gmail.com','9876543202',h,'passenger','Market Square',250],
    ['user-003','Aarav Singh','aarav@gmail.com','9876543203',h,'passenger','Hospital',100],
  ].forEach(r => db.prepare(
    'INSERT INTO users(id,name,email,phone,password,role,home_stop,wallet,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)').run(...r, now));

  // Routes with stop coords (lat/lng pairs)
  const stopCoords1 = JSON.stringify([[27.5706,81.5957],[27.5740,81.6000],[27.5770,81.6030],[27.5800,81.6060],[27.5830,81.6090]]);
  const stopCoords2 = JSON.stringify([[27.5780,81.6010],[27.5750,81.5980],[27.5720,81.5960],[27.5700,81.5940],[27.5680,81.5920]]);
  const stopCoords3 = JSON.stringify([[27.5650,81.5880],[27.5670,81.5920],[27.5690,81.5950],[27.5710,81.5980],[27.5730,81.6010]]);
  const stopCoords4 = JSON.stringify([[27.5820,81.6120],[27.5800,81.6080],[27.5780,81.6050],[27.5760,81.6020],[27.5740,81.5990]]);

  [
    ['route-001','R-101','Central → Railway Station','Central Bus Stand','Railway Station',
     JSON.stringify(['Central Bus Stand','Civil Lines','Collectorate','Kotwali','Railway Station']),stopCoords1,18,45,1.5,15,150],
    ['route-002','R-102','Market → City College','Market Square','City College',
     JSON.stringify(['Market Square','GPO','Bus Stand','Gandhi Park','City College']),stopCoords2,12,35,1.5,12,120],
    ['route-003','R-103','Hospital → Shopping Mall','District Hospital','City Mall',
     JSON.stringify(['District Hospital','Medical College','Police Lines','New Market','City Mall']),stopCoords3,9,28,1.5,10,100],
    ['route-004','R-104','Airport → City Center','Airport','City Center',
     JSON.stringify(['Airport','Indira Nagar','Hazratganj','Charbagh','City Center']),stopCoords4,22,55,1.8,20,200],
  ].forEach(r => db.prepare('INSERT INTO routes(id,route_number,name,origin,destination,stops,stop_coords,distance_km,duration_min,fare_per_km,base_fare,weekly_pass_fare,is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)').run(...r));

  // Buses
  [
    ['bus-001','UP-32-BQ-1001','route-001','cond-001',50,'Tata Starbus'],
    ['bus-002','UP-32-BQ-1002','route-002','cond-002',50,'Ashok Leyland'],
    ['bus-003','UP-32-BQ-1003','route-003','cond-003',50,'Eicher Skyline'],
    ['bus-004','UP-32-BQ-1004','route-004','cond-001',50,'Tata Starbus'],
  ].forEach(b => db.prepare('INSERT INTO buses(id,bus_number,route_id,conductor_id,capacity,model,is_active) VALUES (?,?,?,?,?,?,1)').run(...b));

  // Schedules
  [
    ['sch-001','bus-001','route-001','08:00','08:45',today],
    ['sch-002','bus-002','route-002','09:15','09:50',today],
    ['sch-003','bus-003','route-003','10:00','10:28',today],
    ['sch-004','bus-004','route-004','11:00','11:55',today],
    ['sch-005','bus-001','route-001','14:00','14:45',today],
    ['sch-006','bus-002','route-002','15:00','15:35',today],
  ].forEach(s => db.prepare("INSERT INTO schedules VALUES (?,?,?,?,?,?,'scheduled')").run(...s));

  // Live trips with real-ish coords
  [
    ['trip-001','sch-001','bus-001','cond-001','route-001',now,null,'in_progress',2,1,27.5740,81.6000,38.5,90,28,700],
    ['trip-002','sch-002','bus-002','cond-002','route-002',now,null,'in_progress',0,2,27.5750,81.5980,22.0,180,45,1080],
    ['trip-003','sch-003','bus-003','cond-003','route-003',now,null,'in_progress',5,0,27.5690,81.5950,0.0,0,12,240],
    ['trip-004','sch-004','bus-004','cond-001','route-004',now,null,'in_progress',0,3,27.5800,81.6080,45.0,270,38,1900],
  ].forEach(t => db.prepare('INSERT INTO trips(id,schedule_id,bus_id,conductor_id,route_id,started_at,ended_at,status,delay_minutes,current_stop_idx,lat,lng,speed,heading,passenger_count,fare_collected) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...t));

  console.log('✅ Seed OK');
}
seed();

/* ─── RAZORPAY ─────────────────────────────────────── */
const razorpay = new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_SECRET });

/* ─── AUTH ─────────────────────────────────────────── */
function auth(roles = []) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const p = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(p.role)) return res.status(403).json({ error: 'Forbidden' });
      req.user = p; next();
    } catch { res.status(401).json({ error: 'Token invalid' }); }
  };
}

function walletTx(userId, type, amount, desc, refId) {
  const user = db.prepare('SELECT wallet FROM users WHERE id=?').get(userId);
  const bal = (user?.wallet || 0) + amount;
  db.prepare('UPDATE users SET wallet=? WHERE id=?').run(bal, userId);
  db.prepare('INSERT INTO wallet_transactions VALUES (?,?,?,?,?,?,?,datetime(\'now\'))').run(
    uuidv4(), userId, type, amount, bal, desc, refId || null);
  return bal;
}

function notify(userId, type, title, message, actionUrl) {
  db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,0,?,datetime(\'now\'))').run(
    uuidv4(), userId, type, title, message, actionUrl || null);
}

/* ══════════════════════════════════════════════════════
   AUTH ROUTES
══════════════════════════════════════════════════════ */
app.post('/api/auth/register', (req, res) => {
  const { name, email, phone, password, role = 'passenger', home_stop, work_stop } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ error: 'All fields required' });
  if (role === 'admin') return res.status(403).json({ error: 'Cannot self-register as admin' });
  try {
    const id = uuidv4();
    db.prepare('INSERT INTO users(id,name,email,phone,password,role,home_stop,work_stop,wallet,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,0,1,datetime(\'now\'))').run(
      id, name, email, phone.replace(/\D/g,''), bcrypt.hashSync(password,10), role, home_stop||null, work_stop||null);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const token = jwt.sign({ id:u.id, name:u.name, email:u.email, phone:u.phone, role:u.role }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user: { id:u.id, name:u.name, email:u.email, phone:u.phone, role:u.role, wallet:u.wallet } });
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email or phone already registered' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email);
  if (!u || !bcrypt.compareSync(password, u.password)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id:u.id, name:u.name, email:u.email, phone:u.phone, role:u.role }, JWT_SECRET, { expiresIn:'30d' });
  res.json({ token, user: { id:u.id, name:u.name, email:u.email, phone:u.phone, role:u.role, wallet:u.wallet, home_stop:u.home_stop, work_stop:u.work_stop } });
});

app.get('/api/auth/me', auth(), (req, res) => {
  const u = db.prepare('SELECT id,name,email,phone,role,wallet,avatar,home_stop,work_stop,trip_count,weekly_pass_expiry,subsidized_type,subsidized_verified,created_at FROM users WHERE id=?').get(req.user.id);
  const carbon = db.prepare("SELECT COALESCE(SUM(r.distance_km * (0.12 - 0.03)),0) as s FROM bookings b JOIN routes r ON b.route_id=r.id WHERE b.user_id=? AND b.boarded=1").get(req.user.id).s;
  const paper = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE user_id=? AND payment_status='paid'").get(req.user.id).c;
  res.json({ ...u, carbon_saved: parseFloat(carbon.toFixed(3)), paper_saved: paper });
});

app.put('/api/auth/profile', auth(), (req, res) => {
  const { name, phone, home_stop, work_stop } = req.body;
  db.prepare('UPDATE users SET name=?,phone=?,home_stop=?,work_stop=? WHERE id=?').run(name, phone, home_stop, work_stop, req.user.id);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════
   ROUTES & TRIPS
══════════════════════════════════════════════════════ */
app.get('/api/routes', (req, res) => {
  res.json(db.prepare('SELECT * FROM routes WHERE is_active=1').all().map(r => ({...r, stops: JSON.parse(r.stops), stop_coords: r.stop_coords ? JSON.parse(r.stop_coords) : []})));
});

app.get('/api/trips/live', (req, res) => {
  const { user_lat, user_lng } = req.query;
  const trips = db.prepare(`
    SELECT t.*, b.bus_number, b.capacity, r.name as route_name, r.stops, r.stop_coords,
           r.origin, r.destination, r.surge_multiplier, u.name as conductor_name
    FROM trips t JOIN buses b ON t.bus_id=b.id JOIN routes r ON t.route_id=r.id
    JOIN users u ON t.conductor_id=u.id WHERE t.status='in_progress'`).all();

  const result = trips.map(t => {
    const parsed = { ...t, stops: JSON.parse(t.stops), stop_coords: t.stop_coords ? JSON.parse(t.stop_coords) : [] };
    // Distance from user to bus
    if (user_lat && user_lng && t.lat && t.lng) {
      const d = haversine(parseFloat(user_lat), parseFloat(user_lng), t.lat, t.lng);
      parsed.distance_from_user_km = Math.round(d * 10) / 10;
      parsed.eta_minutes = Math.round((d / 25) * 60); // assuming 25 km/h avg
    }
    // Crowd prediction
    const load = t.passenger_count / t.capacity;
    parsed.crowd_pct = Math.round(load * 100);
    parsed.crowd_label = load > 0.85 ? 'Very Crowded' : load > 0.65 ? 'Crowded' : load > 0.4 ? 'Moderate' : 'Comfortable';
    return parsed;
  });
  res.json(result);
});

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.get('/api/trips/search', (req, res) => {
  const { from, to, date, user_lat, user_lng, women_only } = req.query;
  const d = date || new Date().toISOString().split('T')[0];
  const hour = new Date().getHours();
  const isPeak = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20);

  const rows = db.prepare(`
    SELECT s.*, b.bus_number, b.capacity, r.name as route_name, r.origin, r.destination,
           r.stops, r.stop_coords, r.base_fare, r.fare_per_km, r.distance_km, r.surge_multiplier, r.weekly_pass_fare,
           t.id as trip_id, t.status as trip_status, t.passenger_count, t.delay_minutes, t.lat, t.lng
    FROM schedules s JOIN buses b ON s.bus_id=b.id JOIN routes r ON s.route_id=r.id
    LEFT JOIN trips t ON t.schedule_id=s.id WHERE s.date=? ORDER BY s.departure`).all(d);

  const results = rows.map(s => {
    const stops = JSON.parse(s.stops);
    const coords = s.stop_coords ? JSON.parse(s.stop_coords) : [];
    const fi = from ? stops.findIndex(x => x.toLowerCase().includes(from.toLowerCase())) : 0;
    const ti = to   ? stops.findIndex(x => x.toLowerCase().includes(to.toLowerCase()))   : stops.length - 1;
    if (fi < 0 || ti < 0 || fi >= ti) return null;
    
    // Women only filter
    if (women_only && !(s.bus_number.includes('-W') || s.route_name.includes('Women') || s.route_name.includes('Ladies'))) return null;

    const baseFare = Math.round(s.base_fare + (s.distance_km / Math.max(stops.length - 1, 1)) * (ti - fi) * s.fare_per_km);
    const surge = isPeak ? (s.surge_multiplier || 1.0) : 1.0;
    const fare = Math.round(baseFare * surge);
    const booked = s.trip_id ? db.prepare("SELECT seat_number FROM bookings WHERE trip_id=? AND status='confirmed' AND payment_status='paid'").all(s.trip_id).map(x => x.seat_number) : [];
    const available = s.capacity - booked.length;
    const load = s.passenger_count / s.capacity;
    // Crowd prediction next 30 min
    const predictedLoad = Math.min(100, Math.round(load * 100) + (isPeak ? 15 : 5));

    // Distance of bus from user
    let busDistKm = null, busetaMin = null;
    if (user_lat && user_lng && s.lat && s.lng) {
      busDistKm = Math.round(haversine(parseFloat(user_lat), parseFloat(user_lng), s.lat, s.lng) * 10) / 10;
      busetaMin = Math.max(1, Math.round((busDistKm / 25) * 60));
    }

    // Next stop ETA
    const curStopCoord = coords[s.current_stop_idx || 0];
    let arrivalAtStop = null;
    if (curStopCoord && coords[fi]) {
      const stopsAway = fi - (s.current_stop_idx || 0);
      if (stopsAway >= 0) arrivalAtStop = Math.max(1, stopsAway * 7); // ~7 min per stop
    }

    return {
      ...s, stops, stop_coords: coords, fromStop: stops[fi], toStop: stops[ti], fromIdx: fi, toIdx: ti,
      fare, baseFare, surge, bookedSeats: booked, availableSeats: available,
      crowd_pct: Math.round(load * 100), predicted_crowd_pct: predictedLoad,
      crowd_label: load > 0.85 ? 'Very Crowded' : load > 0.65 ? 'Crowded' : load > 0.4 ? 'Moderate' : 'Comfortable',
      bus_distance_km: busDistKm, bus_eta_min: busetaMin,
      arrival_at_stop_min: arrivalAtStop,
      weekly_pass_fare: s.weekly_pass_fare, isPeak
    };
  }).filter(Boolean);
  res.json(results);
});

app.get('/api/trips/:id/seats', (req, res) => {
  const booked = db.prepare("SELECT seat_number FROM bookings WHERE trip_id=? AND status='confirmed' AND payment_status='paid'").all(req.params.id).map(x => x.seat_number);
  const locked = db.prepare("SELECT seat_number,user_id FROM seat_locks WHERE trip_id=? AND locked_at > datetime('now','-5 minutes')").all(req.params.id);
  const trip   = db.prepare('SELECT passenger_count, capacity FROM trips WHERE id=?').get(req.params.id);
  res.json({ booked, locked: locked.map(l => l.seat_number), trip });
});

/* ══════════════════════════════════════════════════════
   PASSENGER: BOOKINGS + PAYMENT
══════════════════════════════════════════════════════ */
app.post('/api/bookings/lock-seat', auth(['passenger']), (req, res) => {
  const { trip_id, seat_number } = req.body;
  db.prepare("DELETE FROM seat_locks WHERE trip_id=? AND user_id=?").run(trip_id, req.user.id);
  const taken = db.prepare("SELECT id FROM bookings WHERE trip_id=? AND seat_number=? AND status='confirmed' AND payment_status='paid'").get(trip_id, seat_number);
  if (taken) return res.status(409).json({ error: 'Seat already booked' });
  const lock = db.prepare("SELECT user_id FROM seat_locks WHERE trip_id=? AND seat_number=? AND locked_at > datetime('now','-5 minutes')").get(trip_id, seat_number);
  if (lock && lock.user_id !== req.user.id) return res.status(409).json({ error: 'Seat held by another user' });
  db.prepare("INSERT OR REPLACE INTO seat_locks VALUES (?,?,?,datetime('now'))").run(trip_id, seat_number, req.user.id);
  res.json({ ok: true, locked_until: new Date(Date.now() + 5*60000).toISOString() });
});

app.post('/api/bookings/create-order', auth(['passenger']), async (req, res) => {
  const { trip_id, seat_number, from_stop, to_stop, passengers, fare, payment_method } = req.body;
  const qrCode = crypto.randomBytes(12).toString('hex').toUpperCase();
  const bookingId = uuidv4();
  const route_id = db.prepare('SELECT route_id FROM trips WHERE id=?').get(trip_id)?.route_id;

  // Queue token
  const queueCount = db.prepare("SELECT COUNT(*) as c FROM queue_tokens WHERE trip_id=? AND status='waiting'").get(trip_id).c;
  const tokenNum = queueCount + 1;

  if (payment_method === 'wallet') {
    const user = db.prepare('SELECT wallet FROM users WHERE id=?').get(req.user.id);
    if ((user?.wallet || 0) < fare) return res.status(400).json({ error: `Insufficient wallet balance. Have ₹${user?.wallet}, need ₹${fare}` });
    const newBal = walletTx(req.user.id, 'debit', -fare, `Booking seat ${seat_number}`, bookingId);
    db.prepare('INSERT INTO bookings(id,user_id,trip_id,route_id,from_stop,to_stop,seat_number,passengers,fare,payment_status,payment_method,qr_code,status,queue_token,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\'))').run(
      bookingId, req.user.id, trip_id, route_id, from_stop, to_stop, seat_number, passengers, fare, 'paid', 'wallet', qrCode, 'confirmed', tokenNum);
    db.prepare('DELETE FROM seat_locks WHERE trip_id=? AND seat_number=?').run(trip_id, seat_number);
    db.prepare('UPDATE trips SET passenger_count=passenger_count+? WHERE id=?').run(passengers, trip_id);
    db.prepare('UPDATE users SET trip_count=trip_count+1 WHERE id=?').run(req.user.id);
    db.prepare('INSERT INTO queue_tokens VALUES (?,?,?,?,\'confirmed\',datetime(\'now\'))').run(uuidv4(), trip_id, req.user.id, tokenNum);
    notify(req.user.id, 'booking_confirmed', '🎉 Booking Confirmed!', `Seat ${seat_number} via Wallet. QR ready.`, null);
    io.to(`trip_${trip_id}`).emit('seat_booked', { seat: seat_number });
    return res.json({ success: true, booking_id: bookingId, qr_code: qrCode, payment_method: 'wallet', wallet_balance: newBal });
  }

  // Razorpay
  let orderId, demoMode = false;
  try {
    const order = await razorpay.orders.create({ amount: Math.round(fare * 100), currency: 'INR', receipt: `bq_${Date.now()}` });
    orderId = order.id;
  } catch { orderId = 'order_demo_' + Date.now(); demoMode = true; }

  db.prepare('INSERT INTO bookings(id,user_id,trip_id,route_id,from_stop,to_stop,seat_number,passengers,fare,payment_status,payment_method,order_id,qr_code,status,queue_token,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\'))').run(
    bookingId, req.user.id, trip_id, route_id, from_stop, to_stop, seat_number, passengers, fare, 'pending', 'razorpay', orderId, qrCode, 'pending', tokenNum);
  db.prepare('INSERT INTO queue_tokens VALUES (?,?,?,?,\'waiting\',datetime(\'now\'))').run(uuidv4(), trip_id, req.user.id, tokenNum);
  res.json({ order_id: orderId, booking_id: bookingId, key_id: RZP_KEY_ID, amount: Math.round(fare * 100), qr_code: qrCode, demo_mode: demoMode, queue_token: tokenNum });
});

app.post('/api/bookings/verify-payment', auth(['passenger']), (req, res) => {
  const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, demo_mode } = req.body;
  let ok = demo_mode;
  if (!demo_mode) {
    const sig = crypto.createHmac('sha256', RZP_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    ok = sig === razorpay_signature;
  }
  if (!ok) return res.status(400).json({ error: 'Payment verification failed' });
  const bk = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get(booking_id, req.user.id);
  if (!bk) return res.status(404).json({ error: 'Booking not found' });
  const payId = razorpay_payment_id || 'pay_demo_' + Date.now();
  db.prepare("UPDATE bookings SET payment_status='paid',payment_id=?,status='confirmed' WHERE id=?").run(payId, booking_id);
  db.prepare('DELETE FROM seat_locks WHERE trip_id=? AND seat_number=?').run(bk.trip_id, bk.seat_number);
  db.prepare('UPDATE trips SET passenger_count=passenger_count+? WHERE id=?').run(bk.passengers, bk.trip_id);
  db.prepare('UPDATE users SET trip_count=trip_count+1 WHERE id=?').run(req.user.id);
  db.prepare("UPDATE queue_tokens SET status='confirmed' WHERE trip_id=? AND user_id=?").run(bk.trip_id, req.user.id);
  db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?,datetime(\'now\'))').run(
    uuidv4(), booking_id, req.user.id, bk.fare, 'INR', 'razorpay', razorpay_order_id, payId, razorpay_signature||null, 'captured');
  notify(req.user.id, 'booking_confirmed', '🎉 Booking Confirmed!', `Seat ${bk.seat_number} confirmed. Show QR to conductor.`, null);
  io.to(`trip_${bk.trip_id}`).emit('seat_booked', { seat: bk.seat_number });
  const full = db.prepare('SELECT b.*,r.name as route_name FROM bookings b LEFT JOIN routes r ON b.route_id=r.id WHERE b.id=?').get(booking_id);
  res.json({ success: true, booking: full });
});

app.get('/api/bookings/my', auth(['passenger']), (req, res) => {
  res.json(db.prepare(`SELECT b.*,r.name as route_name,bu.bus_number,s.departure,s.arrival FROM bookings b LEFT JOIN routes r ON b.route_id=r.id LEFT JOIN trips t ON b.trip_id=t.id LEFT JOIN buses bu ON t.bus_id=bu.id LEFT JOIN schedules s ON t.schedule_id=s.id WHERE b.user_id=? ORDER BY b.created_at DESC`).all(req.user.id));
});

app.post('/api/bookings/:id/cancel', auth(['passenger']), (req, res) => {
  const bk = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!bk) return res.status(404).json({ error: 'Not found' });
  if (bk.boarded) return res.status(400).json({ error: 'Already boarded' });
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(req.params.id);
  const refund = parseFloat(bk.fare) * 0.75;
  const newBal = walletTx(req.user.id, 'credit', refund, `Refund for cancelled booking`, req.params.id);
  db.prepare('UPDATE trips SET passenger_count=MAX(0,passenger_count-?) WHERE id=?').run(bk.passengers, bk.trip_id);
  notify(req.user.id, 'refund', '💰 Refund Credited', `₹${refund.toFixed(2)} refunded to wallet.`, null);
  res.json({ ok: true, refund, wallet_balance: newBal });
});

// Auto-refund if delay > 15 min
app.post('/api/bookings/check-auto-refund', auth(), (req, res) => {
  const delayed = db.prepare(`SELECT b.* FROM bookings b JOIN trips t ON b.trip_id=t.id WHERE b.user_id=? AND b.payment_status='paid' AND b.auto_refunded=0 AND b.boarded=0 AND t.delay_minutes>=15 AND b.status='confirmed'`).all(req.user.id);
  delayed.forEach(bk => {
    db.prepare('UPDATE bookings SET auto_refunded=1 WHERE id=?').run(bk.id);
    const refund = parseFloat(bk.fare);
    walletTx(req.user.id, 'credit', refund, `Auto-refund: bus delayed >15min`, bk.id);
    notify(req.user.id, 'auto_refund', '💰 Auto-Refund!', `Bus delayed >15 min. ₹${refund} refunded to wallet.`, null);
  });
  res.json({ refunded: delayed.length });
});

// Queue token
app.get('/api/queue/:trip_id', auth(['passenger']), (req, res) => {
  const token = db.prepare("SELECT * FROM queue_tokens WHERE trip_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1").get(req.params.trip_id, req.user.id);
  const ahead = token ? db.prepare("SELECT COUNT(*) as c FROM queue_tokens WHERE trip_id=? AND token_number<? AND status='waiting'").get(req.params.trip_id, token.token_number).c : 0;
  res.json({ token, ahead });
});

// Weekly pass purchase
app.post('/api/pass/buy', auth(['passenger']), async (req, res) => {
  const { route_id } = req.body;
  const route = db.prepare('SELECT * FROM routes WHERE id=?').get(route_id);
  if (!route) return res.status(404).json({ error: 'Route not found' });
  const user = db.prepare('SELECT wallet FROM users WHERE id=?').get(req.user.id);
  if ((user?.wallet||0) < route.weekly_pass_fare)
    return res.status(400).json({ error: `Need ₹${route.weekly_pass_fare}. Wallet: ₹${user.wallet}` });
  const expiry = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];
  walletTx(req.user.id, 'debit', -route.weekly_pass_fare, `Weekly pass: ${route.name}`, route_id);
  db.prepare('UPDATE users SET weekly_pass_expiry=? WHERE id=?').run(expiry, req.user.id);
  notify(req.user.id, 'pass', '🎟 Weekly Pass Active!', `Valid till ${expiry}. Save 25% on daily fares!`, null);
  res.json({ ok: true, expiry, saving: Math.round(route.base_fare * 5 * 0.25) });
});

/* ══════════════════════════════════════════════════════
   WALLET
══════════════════════════════════════════════════════ */
app.get('/api/wallet', auth(), (req, res) => {
  const user = db.prepare('SELECT wallet FROM users WHERE id=?').get(req.user.id);
  const txns = db.prepare('SELECT * FROM wallet_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  res.json({ balance: user?.wallet || 0, transactions: txns });
});

app.post('/api/wallet/topup', auth(), async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 10) return res.status(400).json({ error: 'Minimum topup is ₹10' });
  let orderId, demoMode = false;
  try {
    const order = await razorpay.orders.create({ amount: amount*100, currency:'INR', receipt:'wallet_'+Date.now() });
    orderId = order.id;
  } catch { orderId = 'wallet_demo_'+Date.now(); demoMode = true; }
  res.json({ order_id: orderId, key_id: RZP_KEY_ID, amount: amount*100, demo_mode: demoMode });
});

app.post('/api/wallet/topup/confirm', auth(), (req, res) => {
  const { amount, order_id, payment_id, signature, demo_mode } = req.body;
  let ok = demo_mode;
  if (!demo_mode) {
    const sig = crypto.createHmac('sha256', RZP_SECRET).update(order_id+'|'+payment_id).digest('hex');
    ok = sig === signature;
  }
  if (!ok) return res.status(400).json({ error: 'Payment verification failed' });
  const newBal = walletTx(req.user.id, 'credit', amount, 'Wallet top-up via Razorpay', order_id);
  notify(req.user.id, 'wallet', '💰 Wallet Topped Up', `₹${amount} added. Balance: ₹${newBal}`, null);
  res.json({ balance: newBal });
});

/* ══════════════════════════════════════════════════════
   TRAFFIC ALERTS (crowd-sourced)
══════════════════════════════════════════════════════ */
app.get('/api/alerts', (req, res) => {
  const alerts = db.prepare(`SELECT a.*,u.name as reporter FROM traffic_alerts a JOIN users u ON a.user_id=u.id WHERE a.expires_at > datetime('now') ORDER BY a.upvotes DESC LIMIT 20`).all();
  res.json(alerts);
});

app.post('/api/alerts', auth(), (req, res) => {
  const { lat, lng, alert_type, description } = req.body;
  const id = uuidv4();
  const expires = new Date(Date.now() + 2*60*60*1000).toISOString();
  db.prepare('INSERT INTO traffic_alerts VALUES (?,?,?,?,?,?,0,0,?,datetime(\'now\'))').run(id, req.user.id, lat, lng, alert_type, description, expires);
  io.emit('traffic_alert', { id, lat, lng, alert_type, description, reporter: req.user.name });
  res.json({ id });
});

app.post('/api/alerts/:id/upvote', auth(), (req, res) => {
  db.prepare('UPDATE traffic_alerts SET upvotes=upvotes+1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════
   CONDUCTOR
══════════════════════════════════════════════════════ */
app.get('/api/conductor/schedules', auth(['conductor']), (req, res) => {
  const bus = db.prepare('SELECT id FROM buses WHERE conductor_id=?').get(req.user.id);
  if (!bus) return res.json([]);
  const today = new Date().toISOString().split('T')[0];
  res.json(db.prepare('SELECT s.*,r.name as route_name,r.origin,r.destination FROM schedules s JOIN routes r ON s.route_id=r.id WHERE s.bus_id=? AND s.date=? ORDER BY s.departure').all(bus.id, today));
});

app.get('/api/conductor/trip', auth(['conductor']), (req, res) => {
  const t = db.prepare(`SELECT t.*,b.bus_number,b.capacity,r.name as route_name,r.stops,r.stop_coords,r.origin,r.destination,s.departure,s.arrival FROM trips t JOIN buses b ON t.bus_id=b.id JOIN routes r ON t.route_id=r.id LEFT JOIN schedules s ON t.schedule_id=s.id WHERE t.conductor_id=? AND t.status='in_progress'`).get(req.user.id);
  res.json(t ? {...t, stops: JSON.parse(t.stops), stop_coords: t.stop_coords ? JSON.parse(t.stop_coords) : []} : null);
});

app.post('/api/conductor/trip/start', auth(['conductor']), (req, res) => {
  const { schedule_id } = req.body;
  const sch = db.prepare('SELECT * FROM schedules WHERE id=?').get(schedule_id);
  if (!sch) return res.status(404).json({ error: 'Schedule not found' });
  const ex = db.prepare("SELECT id FROM trips WHERE schedule_id=? AND status='in_progress'").get(schedule_id);
  if (ex) return res.json({ trip_id: ex.id });
  const tid = uuidv4();
  const cid = db.prepare('SELECT conductor_id FROM buses WHERE id=?').get(sch.bus_id)?.conductor_id;
  db.prepare("INSERT INTO trips(id,schedule_id,bus_id,conductor_id,route_id,started_at,status) VALUES (?,?,?,?,?,datetime('now'),'in_progress')").run(tid, schedule_id, sch.bus_id, cid, sch.route_id);
  db.prepare("UPDATE schedules SET status='started' WHERE id=?").run(schedule_id);
  io.emit('trip_started', { trip_id: tid });
  res.json({ trip_id: tid });
});

app.post('/api/conductor/location', auth(['conductor']), (req, res) => {
  const { trip_id, lat, lng, speed=0, heading=0 } = req.body;
  db.prepare('UPDATE trips SET lat=?,lng=?,speed=?,heading=? WHERE id=? AND conductor_id=?').run(lat, lng, speed, heading, trip_id, req.user.id);
  // Route deviation check (simple: if > 1km from any stop)
  const trip = db.prepare('SELECT route_id,current_stop_idx FROM trips WHERE id=?').get(trip_id);
  if (trip) {
    const route = db.prepare('SELECT stop_coords FROM routes WHERE id=?').get(trip.route_id);
    if (route?.stop_coords) {
      const coords = JSON.parse(route.stop_coords);
      const nextCoord = coords[trip.current_stop_idx];
      if (nextCoord) {
        const dist = haversine(lat, lng, nextCoord[0], nextCoord[1]);
        if (dist > 1.5) {
          db.prepare('UPDATE trips SET deviation_alert=1 WHERE id=?').run(trip_id);
          io.emit('route_deviation', { trip_id, dist_km: dist.toFixed(2) });
        }
      }
    }
  }
  io.emit('bus_location', { trip_id, lat, lng, speed, heading, ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/conductor/delay', auth(['conductor']), (req, res) => {
  const { trip_id, delay_minutes, reason } = req.body;
  db.prepare('UPDATE trips SET delay_minutes=? WHERE id=? AND conductor_id=?').run(delay_minutes, trip_id, req.user.id);
  const passengers = db.prepare("SELECT DISTINCT user_id FROM bookings WHERE trip_id=? AND status='confirmed'").all(trip_id);
  const stmt = db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,0,?,datetime(\'now\'))');
  passengers.forEach(p => stmt.run(uuidv4(), p.user_id, 'delay_alert', '⚠️ Bus Delay', `Bus delayed ${delay_minutes} min. Reason: ${reason||'Traffic'}`, null));
  if (delay_minutes >= 15) {
    // Auto-refund eligible passengers
    const eligible = db.prepare("SELECT * FROM bookings WHERE trip_id=? AND payment_status='paid' AND auto_refunded=0 AND boarded=0 AND status='confirmed'").all(trip_id);
    eligible.forEach(bk => {
      db.prepare('UPDATE bookings SET auto_refunded=1 WHERE id=?').run(bk.id);
      walletTx(bk.user_id, 'credit', bk.fare, `Auto-refund: delay >15min`, bk.id);
      notify(bk.user_id, 'auto_refund', '💰 Auto-Refund!', `Delay >15min. ₹${bk.fare} refunded to wallet.`, null);
    });
    if (eligible.length > 0) io.emit('auto_refund_issued', { trip_id, count: eligible.length });
  }
  io.emit('delay_alert', { trip_id, delay_minutes, reason });
  res.json({ ok: true });
});

app.post('/api/conductor/scan', auth(['conductor']), (req, res) => {
  const { qr_code, trip_id } = req.body;
  const bk = db.prepare('SELECT b.*,u.name as pname,u.phone FROM bookings b JOIN users u ON b.user_id=u.id WHERE b.qr_code=?').get(qr_code);
  if (!bk) return res.status(404).json({ error: 'Invalid QR code' });
  if (bk.trip_id !== trip_id) return res.status(400).json({ error: 'QR is for a different trip' });
  if (bk.boarded) return res.status(400).json({ error: 'Already boarded' });
  if (bk.payment_status !== 'paid' && bk.status !== 'confirmed') return res.status(400).json({ error: 'Payment not completed' });
  db.prepare("UPDATE bookings SET boarded=1,boarded_at=datetime('now') WHERE id=?").run(bk.id);
  io.emit('passenger_boarded', { trip_id, seat: bk.seat_number });
  res.json({ ok: true, passenger: bk.pname, phone: bk.phone, seat: bk.seat_number, from: bk.from_stop, to: bk.to_stop });
});

// Cash/UPI offline collection
app.post('/api/conductor/collect', auth(['conductor']), (req, res) => {
  const { trip_id, from_stop, to_stop, amount, method, passenger_name } = req.body;
  const bookingId = uuidv4();
  const qrCode = crypto.randomBytes(8).toString('hex').toUpperCase();
  const route_id = db.prepare('SELECT route_id FROM trips WHERE id=?').get(trip_id)?.route_id;
  db.prepare("INSERT INTO bookings(id,trip_id,route_id,from_stop,to_stop,seat_number,fare,payment_status,payment_method,qr_code,boarded,boarded_at,status,created_at) VALUES (?,?,?,?,?,'WALK-IN',?,?,?,?,1,datetime('now'),?,datetime('now'))").run(
    bookingId, trip_id, route_id, from_stop, to_stop, amount, 'paid', method||'cash', qrCode, 'confirmed');
  db.prepare('UPDATE trips SET passenger_count=passenger_count+1, fare_collected=fare_collected+? WHERE id=?').run(amount, trip_id);
  res.json({ ok: true, booking_id: bookingId, receipt: qrCode });
});

app.post('/api/conductor/sos', auth(['conductor']), (req, res) => {
  const { trip_id, lat, lng, message } = req.body;
  db.prepare('UPDATE trips SET sos_active=1 WHERE id=? AND conductor_id=?').run(trip_id, req.user.id);
  const conductor = db.prepare('SELECT name,phone FROM users WHERE id=?').get(req.user.id);
  io.emit('sos_alert', { trip_id, lat, lng, message, conductor: conductor?.name, phone: conductor?.phone, ts: Date.now() });
  // Notify all admins
  const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
  admins.forEach(a => notify(a.id, 'sos', '🚨 SOS ALERT!', `Conductor ${conductor?.name} needs help on trip ${trip_id}. Location: ${lat},${lng}`, null));
  res.json({ ok: true });
});

app.post('/api/conductor/stop/advance', auth(['conductor']), (req, res) => {
  const { trip_id } = req.body;
  db.prepare('UPDATE trips SET current_stop_idx=current_stop_idx+1 WHERE id=?').run(trip_id);
  const trip = db.prepare('SELECT current_stop_idx,route_id FROM trips WHERE id=?').get(trip_id);
  const route = db.prepare('SELECT stops FROM routes WHERE id=?').get(trip.route_id);
  const stops = JSON.parse(route.stops);
  const stop = stops[trip.current_stop_idx];
  io.emit('stop_reached', { trip_id, stop, idx: trip.current_stop_idx });
  // Notify passengers alighting here
  const alighting = db.prepare("SELECT b.id,b.user_id FROM bookings b WHERE b.trip_id=? AND b.to_stop=? AND b.boarded=1 AND b.alighted=0 AND b.status='confirmed'").all(trip_id, stop);
  alighting.forEach(bk => {
    db.prepare("UPDATE bookings SET alighted=1,alighted_at=datetime('now') WHERE id=?").run(bk.id);
    notify(bk.user_id, 'stop', '📍 Your Stop!', `Bus has arrived at ${stop}. Please alight.`, null);
  });
  res.json({ stop, idx: trip.current_stop_idx });
});

app.get('/api/conductor/trip/:id/passengers', auth(['conductor']), (req, res) => {
  res.json(db.prepare(`SELECT b.seat_number,b.from_stop,b.to_stop,b.boarded,b.alighted,b.passengers,b.payment_method,b.fare,u.name,u.phone FROM bookings b LEFT JOIN users u ON b.user_id=u.id WHERE b.trip_id=? AND b.status='confirmed' AND b.payment_status='paid' ORDER BY b.boarded DESC,b.seat_number`).all(req.params.id));
});

app.post('/api/conductor/trip/complete', auth(['conductor']), (req, res) => {
  const { trip_id } = req.body;
  const trip = db.prepare('SELECT * FROM trips WHERE id=? AND conductor_id=?').get(trip_id, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  db.prepare("UPDATE trips SET status='completed',ended_at=datetime('now') WHERE id=?").run(trip_id);
  // Update conductor metrics
  const today = new Date().toISOString().split('T')[0];
  const existing = db.prepare('SELECT id FROM conductor_metrics WHERE conductor_id=? AND date=?').get(req.user.id, today);
  if (existing) {
    db.prepare('UPDATE conductor_metrics SET trips_completed=trips_completed+1,passengers_served=passengers_served+?,revenue_collected=revenue_collected+? WHERE id=?').run(trip.passenger_count, trip.fare_collected, existing.id);
  } else {
    db.prepare('INSERT INTO conductor_metrics VALUES (?,?,?,1,?,?,0,0,5.0)').run(uuidv4(), req.user.id, today, trip.passenger_count, trip.fare_collected);
  }
  io.emit('trip_completed', { trip_id });
  res.json({ ok: true });
});


/* ══════════════════════════════════════════════════════
   SDG FEATURES
══════════════════════════════════════════════════════ */
app.get('/api/trips/:id/carbon-saved', auth(), (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const route = db.prepare('SELECT distance_km FROM routes WHERE id=?').get(trip.route_id);
  if (!route) return res.status(404).json({ error: 'Route not found' });
  const carbonSaved = route.distance_km * (CARBON_PER_KM_CAR - CARBON_PER_KM_BUS);
  res.json({
    carbon_saved_kg: parseFloat(carbonSaved.toFixed(3)),
    equivalent_tree_minutes: Math.round((carbonSaved * 1000) / 12.5)
  });
});

app.get('/api/trips/women-only', auth(), (req, res) => {
  const trips = db.prepare(`SELECT t.*, b.bus_number, r.name as route_name FROM trips t 
    JOIN buses b ON t.bus_id=b.id JOIN routes r ON t.route_id=r.id 
    WHERE t.status='in_progress' AND (b.bus_number LIKE '%-W%' OR r.name LIKE '%Women%')`).all();
  res.json(trips);
});

app.post('/api/subsidized-fare/verify', auth(['passenger']), (req, res) => {
  const { type, document_number } = req.body;
  if (Math.random() > 0.3) {
    db.prepare('UPDATE users SET subsidized_type=?, subsidized_verified=1 WHERE id=?').run(type, req.user.id);
    notify(req.user.id, 'subsidy', '🎉 Subsidy Approved!', `Verified for ${type} discount.`, null);
    res.json({ verified: true, type });
  } else res.status(400).json({ error: 'Verification failed' });
});

app.get('/api/incidents', auth(['admin']), (req, res) => {
  res.json(db.prepare('SELECT i.*, u.name as reporter_name FROM incidents i JOIN users u ON i.reporter_id=u.id ORDER BY i.created_at DESC').all());
});

app.post('/api/incidents/report', auth(), (req, res) => {
  const { incident_type, description, trip_id } = req.body;
  db.prepare('INSERT INTO incidents(id,reporter_id,incident_type,description,trip_id) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, incident_type, description, trip_id||null);
  res.json({ ok:true });
});

app.patch('/api/incidents/:id/status', auth(['admin']), (req, res) => {
  db.prepare('UPDATE incidents SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok:true });
});

app.get('/api/admin/ev-stations', auth(['admin']), (req, res) => {
  res.json(db.prepare('SELECT * FROM ev_charging_stations ORDER BY created_at DESC').all());
});

app.post('/api/admin/ev-stations', auth(['admin']), (req, res) => {
  const { name, location_lat, location_lng, address, power_kw } = req.body;
  db.prepare('INSERT INTO ev_charging_stations(id,name,location_lat,location_lng,address,power_kw) VALUES (?,?,?,?,?,?)').run(uuidv4(), name, location_lat, location_lng, address, power_kw);
  res.json({ ok:true });
});

app.delete('/api/admin/ev-stations/:id', auth(['admin']), (req, res) => {
  db.prepare('DELETE FROM ev_charging_stations WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

/* ══════════════════════════════════════════════════════
   ADMIN
══════════════════════════════════════════════════════ */
app.get('/api/admin/stats', auth(['admin']), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const total = db.prepare(`SELECT COUNT(*) as c FROM trips WHERE DATE(started_at)=?`).get(today).c;
  const delayed = db.prepare(`SELECT COUNT(*) as c FROM trips WHERE DATE(started_at)=? AND delay_minutes>5`).get(today).c;
  res.json({
    total_passengers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='passenger'").get().c,
    total_conductors: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='conductor'").get().c,
    active_buses: db.prepare("SELECT COUNT(*) as c FROM trips WHERE status='in_progress'").get().c,
    bookings_today: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at)=? AND payment_status='paid'").get(today).c,
    revenue_today: db.prepare("SELECT COALESCE(SUM(fare),0) as s FROM bookings WHERE DATE(created_at)=? AND payment_status='paid'").get(today).s,
    wallet_revenue: db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM wallet_transactions WHERE type='credit' AND DATE(created_at)=?").get(today).s,
    total_routes: db.prepare("SELECT COUNT(*) as c FROM routes WHERE is_active=1").get().c,
    total_buses: db.prepare("SELECT COUNT(*) as c FROM buses WHERE is_active=1").get().c,
    delayed_trips: delayed,
    on_time_rate: total > 0 ? Math.round(((total - delayed) / total) * 100) : 100,
    sos_active: db.prepare("SELECT COUNT(*) as c FROM trips WHERE sos_active=1 AND status='in_progress'").get().c,
    auto_refunds_today: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE DATE(created_at)=? AND auto_refunded=1").get(today).c,
    total_carbon_saved: db.prepare("SELECT COALESCE(SUM(r.distance_km * (0.12 - 0.03)),0) as s FROM bookings b JOIN routes r ON b.route_id=r.id WHERE b.payment_status='paid'").get().s,
    total_paper_saved: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE payment_status='paid'").get().c,
    active_subsidies: db.prepare("SELECT COUNT(*) as c FROM users WHERE subsidized_verified=1").get().c
  });
});

app.get('/api/admin/fleet', auth(['admin']), (req, res) => {
  res.json(db.prepare(`SELECT b.*,r.name as route_name,u.name as conductor_name,u.phone as conductor_phone,t.status as trip_status,t.lat,t.lng,t.speed,t.passenger_count,t.delay_minutes,t.sos_active,t.fare_collected,t.id as trip_id FROM buses b LEFT JOIN routes r ON b.route_id=r.id LEFT JOIN users u ON b.conductor_id=u.id LEFT JOIN trips t ON t.bus_id=b.id AND t.status='in_progress' WHERE b.is_active=1`).all());
});

// ADMIN: Add Bus
app.post('/api/admin/buses', auth(['admin']), (req, res) => {
  const { bus_number, route_id, conductor_id, capacity, model, reg_number } = req.body;
  if (!bus_number) return res.status(400).json({ error: 'Bus number required' });
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO buses(id,bus_number,route_id,conductor_id,capacity,model,reg_number,is_active,created_at) VALUES (?,?,?,?,?,?,?,1,datetime(\'now\'))').run(id, bus_number, route_id||null, conductor_id||null, capacity||50, model||null, reg_number||null);
    res.json({ id, bus_number });
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Bus number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/buses/:id', auth(['admin']), (req, res) => {
  const { route_id, conductor_id, capacity, model, is_active } = req.body;
  db.prepare('UPDATE buses SET route_id=?,conductor_id=?,capacity=?,model=?,is_active=? WHERE id=?').run(route_id, conductor_id, capacity, model, is_active ?? 1, req.params.id);
  // If conductor changed, notify new conductor
  if (conductor_id) notify(conductor_id, 'assignment', '🚌 Bus Assigned', `You have been assigned to bus ${req.params.id}`, null);
  res.json({ ok: true });
});

app.delete('/api/admin/buses/:id', auth(['admin']), (req, res) => {
  db.prepare('UPDATE buses SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/buses', auth(['admin']), (req, res) => {
  res.json(db.prepare('SELECT b.*,r.name as route_name,u.name as conductor_name FROM buses b LEFT JOIN routes r ON b.route_id=r.id LEFT JOIN users u ON b.conductor_id=u.id ORDER BY b.created_at DESC').all());
});

// ADMIN: Add Route
app.post('/api/admin/routes', auth(['admin']), (req, res) => {
  const { route_number, name, origin, destination, stops, stop_coords, distance_km, duration_min, base_fare, fare_per_km, weekly_pass_fare } = req.body;
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO routes(id,route_number,name,origin,destination,stops,stop_coords,distance_km,duration_min,base_fare,fare_per_km,weekly_pass_fare,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,datetime(\'now\'))').run(
      id, route_number, name, origin, destination, JSON.stringify(stops||[]),
      stop_coords ? JSON.stringify(stop_coords) : null,
      distance_km||0, duration_min||0, base_fare||10, fare_per_km||1.5, weekly_pass_fare||150);
    res.json({ id });
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Route number exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/routes/:id', auth(['admin']), (req, res) => {
  const { name, base_fare, surge_multiplier, is_active } = req.body;
  db.prepare('UPDATE routes SET name=?,base_fare=?,surge_multiplier=?,is_active=? WHERE id=?').run(name, base_fare, surge_multiplier||1.0, is_active??1, req.params.id);
  res.json({ ok: true });
});

// ADMIN: Users
app.get('/api/admin/users', auth(['admin']), (req, res) => {
  const { role } = req.query;
  const q = role ? 'SELECT id,name,email,phone,role,wallet,is_active,trip_count,home_stop,created_at FROM users WHERE role=? ORDER BY created_at DESC' : 'SELECT id,name,email,phone,role,wallet,is_active,trip_count,created_at FROM users ORDER BY created_at DESC';
  res.json(role ? db.prepare(q).all(role) : db.prepare(q).all());
});

app.post('/api/admin/users', auth(['admin']), (req, res) => {
  const { name, email, phone, password, role } = req.body;
  const id = uuidv4();
  try {
    db.prepare("INSERT INTO users(id,name,email,phone,password,role,wallet,is_active,created_at) VALUES (?,?,?,?,?,?,0,1,datetime('now'))").run(id, name, email, phone, bcrypt.hashSync(password||'password123',10), role);
    res.json({ id, name, email, role });
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email/phone exists' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:id', auth(['admin']), (req, res) => {
  const { is_active } = req.body;
  db.prepare('UPDATE users SET is_active=? WHERE id=?').run(is_active, req.params.id);
  res.json({ ok: true });
});

// ADMIN: Conductor assignment to bus
app.post('/api/admin/assign', auth(['admin']), (req, res) => {
  const { bus_id, conductor_id, route_id } = req.body;
  db.prepare('UPDATE buses SET conductor_id=?,route_id=? WHERE id=?').run(conductor_id, route_id, bus_id);
  const bus = db.prepare('SELECT bus_number FROM buses WHERE id=?').get(bus_id);
  const route = db.prepare('SELECT name FROM routes WHERE id=?').get(route_id);
  notify(conductor_id, 'assignment', '🚌 Assignment Updated', `Assigned to Bus ${bus?.bus_number} on route ${route?.name}`, null);
  res.json({ ok: true });
});

// ADMIN: Schedules
app.post('/api/admin/schedules', auth(['admin']), (req, res) => {
  const { bus_id, route_id, departure, arrival, date } = req.body;
  const id = uuidv4();
  db.prepare("INSERT INTO schedules VALUES (?,?,?,?,?,?,'scheduled')").run(id, bus_id, route_id, departure, arrival, date);
  res.json({ id });
});

app.get('/api/admin/schedules', auth(['admin']), (req, res) => {
  const { date } = req.query;
  const d = date || new Date().toISOString().split('T')[0];
  res.json(db.prepare('SELECT s.*,r.name as route_name,b.bus_number,u.name as conductor_name FROM schedules s JOIN routes r ON s.route_id=r.id JOIN buses b ON s.bus_id=b.id LEFT JOIN users u ON b.conductor_id=u.id WHERE s.date=? ORDER BY s.departure').all(d));
});

// ADMIN: Revenue analytics
app.get('/api/admin/revenue', auth(['admin']), (req, res) => {
  const daily = db.prepare("SELECT DATE(created_at) as date,SUM(fare) as total,COUNT(*) as count,SUM(CASE WHEN payment_method='wallet' THEN fare ELSE 0 END) as wallet_rev,SUM(CASE WHEN payment_method='razorpay' THEN fare ELSE 0 END) as razorpay_rev FROM bookings WHERE payment_status='paid' GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30").all();
  const byRoute = db.prepare("SELECT r.name,COUNT(*) as bookings,SUM(b.fare) as revenue FROM bookings b JOIN routes r ON b.route_id=r.id WHERE b.payment_status='paid' GROUP BY b.route_id ORDER BY revenue DESC").all();
  const hourly = db.prepare("SELECT CAST(strftime('%H',created_at) AS INT) as hour,COUNT(*) as count FROM bookings WHERE payment_status='paid' AND DATE(created_at)=DATE('now') GROUP BY hour ORDER BY hour").all();
  res.json({ daily, byRoute, hourly });
});

// ADMIN: Conductor metrics
app.get('/api/admin/conductor-metrics', auth(['admin']), (req, res) => {
  res.json(db.prepare("SELECT u.name,u.email,cm.* FROM conductor_metrics cm JOIN users u ON cm.conductor_id=u.id ORDER BY cm.date DESC LIMIT 50").all());
});

// ADMIN: Demand heatmap
app.get('/api/admin/heatmap', auth(['admin']), (req, res) => {
  // Generate from booking data
  const data = db.prepare("SELECT b.from_stop as stop,CAST(strftime('%H',b.created_at) AS INT) as hour,COUNT(*) as demand FROM bookings b WHERE b.payment_status='paid' GROUP BY b.from_stop,hour ORDER BY demand DESC LIMIT 100").all();
  res.json(data);
});

// ADMIN: Surge pricing control
app.post('/api/admin/routes/:id/surge', auth(['admin']), (req, res) => {
  const { multiplier } = req.body;
  db.prepare('UPDATE routes SET surge_multiplier=? WHERE id=?').run(multiplier, req.params.id);
  io.emit('surge_updated', { route_id: req.params.id, multiplier });
  res.json({ ok: true });
});

// ADMIN: Bookings
app.get('/api/admin/bookings', auth(['admin']), (req, res) => {
  res.json(db.prepare(`SELECT b.*,u.name as user_name,r.name as route_name,bu.bus_number FROM bookings b LEFT JOIN users u ON b.user_id=u.id LEFT JOIN routes r ON b.route_id=r.id LEFT JOIN trips t ON b.trip_id=t.id LEFT JOIN buses bu ON t.bus_id=bu.id ORDER BY b.created_at DESC LIMIT 200`).all());
});

// ADMIN: Broadcast
app.post('/api/admin/broadcast', auth(['admin']), (req, res) => {
  const { title, message, type, target_role } = req.body;
  const role = target_role || 'passenger';
  const users = db.prepare('SELECT id FROM users WHERE role=?').all(role);
  users.forEach(u => notify(u.id, type||'admin', title, message, null));
  io.emit('broadcast', { title, message, target_role: role });
  res.json({ sent: users.length });
});

/* ══════════════════════════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════════════════════════ */
app.get('/api/notifications', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id));
});
app.patch('/api/notifications/read-all', auth(), (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════
   WEBSOCKET
══════════════════════════════════════════════════════ */
io.on('connection', socket => {
  socket.on('join_trip', id => socket.join(`trip_${id}`));
  socket.on('leave_trip', id => socket.leave(`trip_${id}`));
  socket.on('join_admin', () => socket.join('admin'));
});

/* ══════════════════════════════════════════════════════
   SPA FALLBACK
══════════════════════════════════════════════════════ */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

server.listen(PORT, () => console.log(`\n🚌 BusIQ v2 → http://localhost:${PORT}\n`));
