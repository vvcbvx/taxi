const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ قاعدة البيانات في الذاكرة ============
const users = new Map();      // جميع المستخدمين
const drivers = new Map();    // السائقين المتصلين
const rides = new Map();      // الرحلات
const pendingDrivers = new Map(); // سائقين بانتظار الموافقة

// ============ بيانات المسؤول الافتراضية ============
const adminPassword = bcrypt.hashSync('Admin@123', 10);
users.set('admin_1', {
  id: 'admin_1',
  name: 'مدير النظام',
  email: 'admin@taxiapp.com',
  phone: 'admin',
  password: adminPassword,
  role: 'admin',
  createdAt: new Date()
});

// ============ وظائف مساعدة ============
function generateId() {
  return Date.now().toString() + Math.random().toString(36).substr(2, 6);
}

function sendSMS(phone, code) {
  console.log(`📱 [SMS] إلى ${phone}: رمز التحقق ${code}`);
  return true;
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function calculatePrice(distanceMeters) {
  return Math.ceil(5 + (distanceMeters / 1000) * 2.5);
}

// ============ API Routes ============

// تسجيل الدخول (للمستخدمين والمسؤول)
app.post('/api/login', async (req, res) => {
  const { phone, password, role } = req.body;
  
  // البحث عن المستخدم
  let foundUser = null;
  for (let [id, user] of users) {
    if ((user.phone === phone || user.email === phone) && user.role === role) {
      foundUser = user;
      break;
    }
  }
  
  if (!foundUser) {
    return res.json({ success: false, message: 'بيانات الدخول غير صحيحة' });
  }
  
  // التحقق من كلمة المرور
  const isValid = role === 'admin' 
    ? bcrypt.compareSync(password, foundUser.password)
    : foundUser.password === password;
  
  if (!isValid) {
    return res.json({ success: false, message: 'كلمة المرور غير صحيحة' });
  }
  
  // التحقق من حالة السائق
  if (role === 'driver' && foundUser.status !== 'approved') {
    return res.json({ 
      success: false, 
      message: foundUser.status === 'pending' 
        ? 'حسابك قيد المراجعة من قبل الإدارة' 
        : 'تم تعليق حسابك، تواصل مع الإدارة'
    });
  }
  
  res.json({
    success: true,
    role: foundUser.role,
    user: {
      id: foundUser.id,
      name: foundUser.name,
      phone: foundUser.phone,
      role: foundUser.role
    }
  });
});

// تسجيل مستخدم جديد (فقط للركاب)
app.post('/api/register', async (req, res) => {
  const { name, phone, password, role } = req.body;
  
  // التحقق من أن رقم الهاتف غير مستخدم
  for (let [id, user] of users) {
    if (user.phone === phone) {
      return res.json({ success: false, message: 'رقم الهاتف مسجل بالفعل' });
    }
  }
  
  const userId = generateId();
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  
  // تخزين رمز التحقق مؤقتاً
  pendingDrivers.set(phone, {
    code: verificationCode,
    expiresAt: Date.now() + 5 * 60 * 1000,
    userData: { id: userId, name, phone, password, role, createdAt: new Date() }
  });
  
  sendSMS(phone, verificationCode);
  
  res.json({ 
    success: true, 
    message: 'تم إرسال رمز التحقق',
    testCode: verificationCode // للاختبار فقط
  });
});

// التحقق من الرمز وإنشاء الحساب
app.post('/api/verify', async (req, res) => {
  const { phone, code } = req.body;
  
  const pending = pendingDrivers.get(phone);
  if (!pending) {
    return res.json({ success: false, message: 'لم يتم طلب رمز تحقق' });
  }
  
  if (pending.expiresAt < Date.now()) {
    pendingDrivers.delete(phone);
    return res.json({ success: false, message: 'انتهت صلاحية الرمز' });
  }
  
  if (pending.code !== code) {
    return res.json({ success: false, message: 'رمز التحقق غير صحيح' });
  }
  
  // إنشاء الحساب
  const user = pending.userData;
  users.set(user.id, user);
  pendingDrivers.delete(phone);
  
  res.json({ success: true, message: 'تم إنشاء الحساب بنجاح', userId: user.id });
});

// ============ API للمسؤول (Admin Panel) ============

// الحصول على إحصائيات
app.get('/api/admin/stats', (req, res) => {
  let usersCount = 0, driversCount = 0, pendingCount = 0, activeDrivers = 0;
  
  for (let [id, user] of users) {
    if (user.role === 'user') usersCount++;
    if (user.role === 'driver') {
      driversCount++;
      if (user.status === 'pending') pendingCount++;
      if (user.status === 'approved') activeDrivers++;
    }
  }
  
  res.json({
    totalUsers: usersCount,
    totalDrivers: driversCount,
    pendingDrivers: pendingCount,
    activeDrivers: activeDrivers,
    totalRides: rides.size,
    onlineDrivers: drivers.size
  });
});

// الحصول على قائمة السائقين
app.get('/api/admin/drivers', (req, res) => {
  const driversList = [];
  for (let [id, user] of users) {
    if (user.role === 'driver') {
      driversList.push({
        id: user.id,
        name: user.name,
        phone: user.phone,
        vehicle: user.vehicle || '',
        plate: user.plate || '',
        status: user.status || 'pending',
        createdAt: user.createdAt,
        licenseNumber: user.licenseNumber || '',
        nationalId: user.nationalId || ''
      });
    }
  }
  res.json(driversList);
});

// إضافة سائق جديد (عن طريق الإدارة)
app.post('/api/admin/add-driver', async (req, res) => {
  const { name, phone, password, vehicle, plate, licenseNumber, nationalId } = req.body;
  
  // التحقق من عدم وجود الرقم
  for (let [id, user] of users) {
    if (user.phone === phone) {
      return res.json({ success: false, message: 'رقم الهاتف موجود مسبقاً' });
    }
  }
  
  const driverId = generateId();
  const hashedPassword = bcrypt.hashSync(password, 10);
  
  users.set(driverId, {
    id: driverId,
    name,
    phone,
    password: hashedPassword,
    role: 'driver',
    vehicle,
    plate,
    licenseNumber,
    nationalId,
    status: 'approved', // تتم الموافقة مباشرة عند الإضافة يدوياً
    createdAt: new Date(),
    createdBy: 'admin'
  });
  
  res.json({ success: true, message: 'تم إضافة السائق بنجاح', driverId });
});

// الموافقة على سائق
app.post('/api/admin/approve-driver', (req, res) => {
  const { driverId } = req.body;
  const driver = users.get(driverId);
  
  if (driver && driver.role === 'driver') {
    driver.status = 'approved';
    users.set(driverId, driver);
    res.json({ success: true, message: 'تم الموافقة على السائق' });
  } else {
    res.json({ success: false, message: 'السائق غير موجود' });
  }
});

// رفض سائق
app.post('/api/admin/reject-driver', (req, res) => {
  const { driverId } = req.body;
  const driver = users.get(driverId);
  
  if (driver && driver.role === 'driver') {
    driver.status = 'rejected';
    users.set(driverId, driver);
    res.json({ success: true, message: 'تم رفض السائق' });
  } else {
    res.json({ success: false, message: 'السائق غير موجود' });
  }
});

// حذف سائق
app.delete('/api/admin/delete-driver/:id', (req, res) => {
  const { id } = req.params;
  if (users.has(id) && users.get(id).role === 'driver') {
    users.delete(id);
    res.json({ success: true, message: 'تم حذف السائق' });
  } else {
    res.json({ success: false, message: 'السائق غير موجود' });
  }
});

// الحصول على قائمة الركاب
app.get('/api/admin/users', (req, res) => {
  const usersList = [];
  for (let [id, user] of users) {
    if (user.role === 'user') {
      usersList.push({
        id: user.id,
        name: user.name,
        phone: user.phone,
        createdAt: user.createdAt,
        ridesCount: 0 // يمكن حسابها من الرحلات
      });
    }
  }
  res.json(usersList);
});

// الحصول على الرحلات
app.get('/api/admin/rides', (req, res) => {
  const ridesList = [];
  for (let [id, ride] of rides) {
    const user = users.get(ride.userId);
    const driver = ride.driverId ? users.get(ride.driverId) : null;
    ridesList.push({
      id: ride.id,
      userName: user?.name || 'غير معروف',
      driverName: driver?.name || 'لم يعين بعد',
      status: ride.status,
      price: ride.price,
      createdAt: ride.createdAt
    });
  }
  res.json(ridesList);
});

// ============ صفحة لوحة التحكم ============
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ Socket.IO ============
io.on('connection', (socket) => {
  console.log('✅ عميل متصل:', socket.id);
  
  socket.on('driverOnline', (data) => {
    drivers.set(socket.id, {
      socketId: socket.id,
      userId: data.userId,
      lat: data.lat,
      lng: data.lng,
      name: data.name,
      available: true
    });
    io.emit('driversUpdate', Array.from(drivers.values()));
  });
  
  socket.on('updateLocation', (data) => {
    const driver = drivers.get(socket.id);
    if (driver) {
      driver.lat = data.lat;
      driver.lng = data.lng;
      driver.available = data.available;
      io.emit('driverLocationUpdate', driver);
    }
  });
  
  socket.on('disconnect', () => {
    drivers.delete(socket.id);
    io.emit('driverOffline', { socketId: socket.id });
  });
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     🚖 خادم تاكسي فوري - يعمل بنجاح                        ║
╠═══════════════════════════════════════════════════════════╣
║  📡 الخادم: http://localhost:${PORT}                         ║
║  👑 لوحة التحكم: http://localhost:${PORT}/admin             ║
╠═══════════════════════════════════════════════════════════╣
║  🔐 بيانات الدخول:                                         ║
║     👑 المسؤول: admin@taxiapp.com / Admin@123             ║
║     👤 مستخدم: سجل عبر التطبيق                             ║
║     🚗 سائق: يضاف عن طريق الإدارة فقط                       ║
╚═══════════════════════════════════════════════════════════╝
  `);
});