const express = require('express');
const multer = require('multer');  
const argon2 = require('@node-rs/argon2');
const con = require('./db');
const app = express();
const path = require('path'); 
app.use('/uploads', express.static('uploads'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const cors = require('cors');

app.use(cors()); // ton
console.log('>>> RUNNING FROM:', __filename); // ton

// วางไว้ใต้ app.use(express.json()) // ton
app.use((req,res,next)=>{
  console.log('> IN:', req.method, req.url);
  next();
});

// วางไว้เหนือทุก route หรือจะวางท้าย ๆ ก็ได้ // ton
app.get('/__routes', (_req,res)=>{
  res.json([
    'GET  /__health',
    'POST /api/student/reserve',
    'GET  /api/student/statuss/:roleID',
    'GET  /api/approver/pending'
  ]);
});

// ─────────────────────────── Health ─────────────────────────── // ton
app.get('/__health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), from: __filename.replaceAll('\\','/') });
});

// ─────────────────────── Student: reserve ─────────────────────
// จองห้อง → อัปเดต rooms เป็น pending และเพิ่มแถวเข้า history
// body: { role_id, room_id, reserved_date:"YYYY-MM-DD" }
app.post('/api/student/reserve', (req, res) => {
  const { role_id, room_id, reserved_date } = req.body || {};
  if (!role_id || !room_id || !reserved_date) {
    return res.status(400).send('Missing role_id, room_id, reserved_date');
  }

  // 1) ตรวจห้องก่อน
  const sqlCheck = 'SELECT status FROM rooms WHERE id = ?';
  con.query(sqlCheck, [room_id], (err, rows) => {
    if (err) return res.status(500).send('DB error(check room)');
    if (rows.length !== 1) return res.status(400).send('Room not found');

    const cur = rows[0].status;
    if (cur !== 'free') {
      // ถ้าจะให้จองได้แม้ไม่ free ก็ตัดเงื่อนไขนี้ทิ้ง
      return res.status(400).send(`Room is not free (current=${cur})`);
    }

    // 2) อัปเดตห้องเป็น pending + ผูก role_id
    const sqlUpdate =
      `UPDATE rooms SET role_id = ?, status = 'pending' WHERE id = ?`;
    con.query(sqlUpdate, [role_id, room_id], (err2, r2) => {
      if (err2) return res.status(500).send('DB error(update room)');
      if (r2.affectedRows !== 1) return res.status(400).send('Update room failed');

      // 3) insert history เป็น pending
      const sqlHis = `
        INSERT INTO history(role_id, room_id, approver_id, reserved_date, status, reason)
        VALUES (?, ?, NULL, ?, 'pending', '')
      `;
      con.query(sqlHis, [role_id, room_id, reserved_date], (err3, r3) => {
        if (err3) return res.status(500).send('DB error(insert history)');
        res.json({ ok: true, history_id: r3.insertId });
      });
    });
  });
});

// ───────────── Student: สถานะของ user (pending เท่านั้น) ─────────────
app.get('/api/student/statuss/:roleID', (req, res) => {
  const roleID = req.params.roleID;

  const sql = `
    SELECT
      LPAD(h.id, 6, '0')                       AS req_id_padded,
      r.username                                AS username,
      rm.roomname                               AS roomCode,
      DATE_FORMAT(h.reserved_date, '%d %b %Y')  AS dateText,
      rm.timeslot                               AS timeText,
      CASE WHEN h.status = 'approved' THEN 'Approved'
           WHEN h.status = 'rejected' THEN 'Rejected'
           ELSE 'Pending' END                   AS statusText,
      h.reason                                  AS rejectReason,
      a.username                                AS approverName
    FROM history h
    JOIN roles r  ON r.id  = h.role_id
    JOIN rooms rm ON rm.id = h.room_id
    LEFT JOIN roles a ON a.id = h.approver_id
    WHERE h.role_id = ?
      AND h.status IN ('pending')   -- ใช้ตัวพิมพ์เล็กให้ตรง enum
    ORDER BY h.reserved_date DESC, rm.timeslot ASC
  `;

  con.query(sql, [roleID], (err, rows) => {
    if (err) return res.status(500).send('Database server error');

    const payload = rows.map(row => ({
      reqIdAndUser: `${row.req_id_padded}/${row.username}`,
      roomCode: row.roomCode,
      date: row.dateText,
      time: row.timeText,
      status: row.statusText,
      approverName: row.approverName || '—',
      rejectReason: row.rejectReason || ''
    }));

    res.json(payload);
  });
});

// ───────────── Approver: รายการที่รออนุมัติ (pending) ─────────────
app.get('/api/approver/pending', (_req, res) => {
  const sql = `
    SELECT 
      h.id                                     AS history_id,
      r.username                               AS requesterName,
      rm.roomname                              AS roomCode,
      DATE_FORMAT(h.reserved_date, '%Y-%m-%d') AS date,
      rm.timeslot                              AS timeslot,
      h.status                                 AS status
    FROM history h
    JOIN roles  r  ON r.id  = h.role_id
    JOIN rooms  rm ON rm.id = h.room_id
    WHERE h.status = 'pending'
    ORDER BY h.reserved_date DESC, rm.timeslot ASC
  `;
  con.query(sql, [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    res.json(rows);
  });
});

// ───────────── Approver: APPROVE ─────────────
// body: { history_id, approver_id }
app.post('/api/approver/approve', (req, res) => {
  const { history_id, approver_id } = req.body || {};
  if (!history_id || !approver_id) {
    return res.status(400).send('Missing history_id or approver_id');
  }

  // 1) เปลี่ยน history -> approved (เฉพาะที่ยัง pending)
  const sqlHis = `
    UPDATE history
    SET status='approved', approver_id=?, reason=''
    WHERE id=? AND status='pending'
  `;
  con.query(sqlHis, [approver_id, history_id], (e1, r1) => {
    if (e1) return res.status(500).send('DB error(update history)');
    if (r1.affectedRows !== 1) return res.status(400).send('Not pending or not found');

    // 2) เปลี่ยนสถานะห้องให้เป็น reserved ตาม history แถวนี้
    const sqlRoom = `
      UPDATE rooms r
      JOIN history h ON h.room_id = r.id
      SET r.status = 'reserved', r.role_id = h.role_id
      WHERE h.id = ?
    `;
    con.query(sqlRoom, [history_id], (e2, r2) => {
      if (e2) return res.status(500).send('DB error(update room)');
      res.json({ ok: true, history_id });
    });
  });
});


// ───────────── Approver: REJECT ─────────────
// body: { history_id, approver_id, reason }
app.post('/api/approver/reject', (req, res) => {
  const { history_id, approver_id, reason } = req.body || {};
  if (!history_id || !approver_id) {
    return res.status(400).send('Missing history_id or approver_id');
  }

  // 1) เปลี่ยน history -> rejected (เฉพาะที่ยัง pending)
  const sqlHis = `
    UPDATE history
    SET status='rejected', approver_id=?, reason=?
    WHERE id=? AND status='pending'
  `;
  con.query(sqlHis, [approver_id, reason || '', history_id], (e1, r1) => {
    if (e1) return res.status(500).send('DB error(update history)');
    if (r1.affectedRows !== 1) return res.status(400).send('Not pending or not found');

    // 2) คืนห้อง: free + ตัด role_id ออก
    const sqlRoom = `
      UPDATE rooms r
      JOIN history h ON h.room_id = r.id
      SET r.status = 'free', r.role_id = NULL
      WHERE h.id = ?
    `;
    con.query(sqlRoom, [history_id], (e2, r2) => {
      if (e2) return res.status(500).send('DB error(update room)');
      res.json({ ok: true, history_id });
    });
  });
});

// GET /api/rooms/available?date=YYYY-MM-DD&timeslot=08.00-10.00&roomtype=smallroom
app.get('/api/rooms/available', (req, res) => {
  const { date, timeslot, roomtype } = req.query;

  // ต้องมี date กับ timeslot (roomtype เป็น option)
  if (!date || !timeslot) {
    return res.status(400).send('Missing date or timeslot');
  }

  // หมายเหตุ: โครงสร้างปัจจุบันเก็บสถานะห้องไว้ที่ตาราง rooms
  // - free     = ว่าง
  // - pending  = มีคำขอจองค้าง
  // - reserved = อนุมัติแล้ว
  // เพราะงั้น "ห้องว่าง" = status='free' + timeslot ตรงที่เลือก
  let sql = `
    SELECT id, roomname, roomtype, image, timeslot
    FROM rooms
    WHERE status = 'free' AND timeslot = ?
  `;
  const params = [timeslot];

  if (roomtype) {
    sql += ` AND roomtype = ?`;
    params.push(roomtype);
  }

  // หมายเหตุ: ตอนนี้เราไม่ได้ใช้ date ไป filter ใน rooms (เพราะ rooms ไม่มีคอลัมน์ date)
  // แต่ date ยังจำเป็นต่อ flow (ใช้ตอน insert ลง history) เลยบังคับส่งมาไว้ก่อน
  // ถ้าภายหลังอยากแยกสถานะตามวันจริง ๆ ค่อยย้าย logic ไปเช็คที่ตาราง history เพิ่มเติม

  con.query(sql, params, (err, rows) => {
    if (err) return res.status(500).send('DB error');
    res.json({ date, timeslot, rooms: rows });
  });
});

// ============================= ไว้ Upload รูป ====================================
// ตั้งค่าให้ multer อัปโหลดไฟล์
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // กำหนดโฟลเดอร์ที่จะเก็บไฟล์
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // ใช้ชื่อไฟล์เดิมของผู้ใช้
    cb(null, file.originalname);
  }
});
// เพื่อกันกรณีรัน server ครั้งแรกแล้วยังไม่มีโฟลเดอร์
const fs = require("fs");
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// สร้าง instance ของ multer
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
 fileFilter: (req, file, cb) => cb(null, true)
});
// กำหนด API สำหรับอัปโหลดไฟล์ภาพ
app.post('/api/uploadImage', upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const imagePath = `/uploads/${req.file.filename}`;
    res.status(200).json({ message: 'File uploaded successfully', imagePath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed.' });
  }
});
// ==============================================================================

// CORS ง่ายๆ เผื่อเรียกจากมือถือ/จำลอง
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health
app.get('/api/health', (_req, res) => res.send('ok'));

// ====== Common rooms endpoint (Flutter/Thunder ใช้ตัวนี้) ======
app.get('/api/rooms', (_req, res) => {
  const sql = 'SELECT * FROM rooms ORDER BY roomname, timeslot';
  con.query(sql, (err, rows) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send('Database server error');
    }
    res.json(rows);
  });
});

//========================== student ======================================
//------------------- Get specific room --------------
app.get("/api/role/rooms/:roomID", (req, res) => {
  const roomID = req.params.roomID;
  const sql = "SELECT * FROM rooms WHERE id = ?";
  con.query(sql, [roomID], function (err, result) {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Database server error");
    }
    res.json(result);
  });
});

//------------------- Reserve room (with extra rules) --------------
app.put('/api/student/rooms/:roomID', (req, res) => {
  const roomID = req.params.roomID;
  const { role_id } = req.body || {};
  if (!role_id) return res.status(400).send('Missing role_id');

  // 1) มี pending อยู่แล้วหรือยัง?
  const sqlHasPending = "SELECT id FROM rooms WHERE role_id = ? AND status = 'pending' LIMIT 1";
  con.query(sqlHasPending, [role_id], (err, rows) => {
    if (err) return res.status(500).send('Database server error');
    if (rows.length > 0) return res.status(409).send('You already have a pending reservation');

    // 2) ห้องนี้ disabled หรือไม่ free?
    const sqlCheckRoom = "SELECT status FROM rooms WHERE id = ? LIMIT 1";
    con.query(sqlCheckRoom, [roomID], (err2, r2) => {
      if (err2) return res.status(500).send('Database server error');
      if (r2.length === 0) return res.status(404).send('Room not found');

      const status = r2[0].status;
      if (status === 'disable') return res.status(403).send('This room is disabled and cannot be reserved');
      if (status !== 'free') return res.status(400).send('Room not available or already reserved');

      // 3) อัปเดตเป็น pending แบบ guard กันชนกัน
      const sqlUpdate = `
        UPDATE rooms SET role_id = ?, status = 'pending'
        WHERE id = ? AND status = 'free'
      `;
      con.query(sqlUpdate, [role_id, roomID], (err3, result) => {
        if (err3) return res.status(500).send('Database server error');
        if (result.affectedRows !== 1) return res.status(400).send('Room not available or already reserved');

        // 4) log ประวัติเป็น pending
        const logSql = `
          INSERT INTO history (role_id, room_id, reserved_date, status, reason)
          VALUES (?, ?, CURDATE(), 'pending', '')
        `;
        con.query(logSql, [role_id, roomID], (logErr) => {
          if (logErr) console.error('Failed to log history:', logErr.message);
        });

        res.send('Room reserved successfully');
      });
    });
  });
});

//------------------- History student --------------
app.get("/api/student/history/:roleID", (req, res) => {
  const roleID = req.params.roleID;
  const sql = `
    SELECT
      rm.roomname AS roomCode,
      DATE_FORMAT(h.reserved_date, '%d %b %Y') AS dateText,
      rm.timeslot AS timeText,
      CASE WHEN h.status='approved' THEN 'Approved' ELSE 'Rejected' END AS statusText,
      h.reason AS rejectReason,
      a.username AS approverName           -- 👈 add this
    FROM history h
    JOIN roles r ON r.id = h.role_id
    JOIN rooms rm ON rm.id = h.room_id
    LEFT JOIN roles a ON a.id = h.approver_id
    WHERE h.role_id = ?
      AND h.status IN ('approved','rejected')   -- hide pending
    ORDER BY h.reserved_date DESC, rm.timeslot ASC
  `;
  con.query(sql, [roleID], (err, rows) => {
    if (err) return res.status(500).send("Database server error");
    const payload = rows.map(row => ({
      // reqIdAndUser: `${row.req_id_padded}/${row.username}`, // comment because need not show req_id
      roomCode: row.roomCode,
      date: row.dateText,
      time: row.timeText,
      status: row.statusText,
      approverName: row.approverName || "—",    // 👈 now real approver (id=29 in your data)
      rejectReason: row.rejectReason || ""
    }));
    res.json(payload);
  });
});

//========================== status student history ======================================
app.get("/api/student/status/:roleId", (req, res) => {
  const roleId = req.params.roleId;

  const sql = `
    SELECT 
      h.id,
      r.roomname,
      r.roomtype,
      r.timeslot,
      h.reserved_date,
      h.status,
      h.reason,
      a.username AS approver_name
    FROM history h
    JOIN rooms r ON h.room_id = r.id
    LEFT JOIN roles a ON h.approver_id = a.id
    WHERE h.role_id = ?
    ORDER BY h.reserved_date DESC, h.id DESC
  `;

  con.query(sql, [roleId], (err, result) => {
    if (err) {
      console.error("Error fetching history:", err);
      res.status(500).send("Database error");
      return;
    }
    res.json(result);
  });
});

//========================== staff ======================================
//-------------------------- Get all students ------------------------
app.get("/api/staff/roles", (_req, res) => {
  const sql = "SELECT id, username FROM roles WHERE role = 'student'";
  con.query(sql, (err, result) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send("Database server error");
    }
    res.json(result);
  });
});

// Staff can view all history (approved + rejected)
app.get("/api/staff/history", (req, res) => {
  const sql = `
    SELECT
      LPAD(h.role_id, 4, '0') AS req_id_padded,
      r.username,
      rm.roomname AS roomCode,
      DATE_FORMAT(h.reserved_date, '%d %b %Y') AS dateText,
      rm.timeslot AS timeText,
      CASE WHEN h.status='approved' THEN 'Approved' ELSE 'Rejected' END AS statusText,
      h.reason AS rejectReason,
      a.username AS approverName
    FROM history h
    JOIN roles r ON r.id = h.role_id
    JOIN rooms rm ON rm.id = h.room_id
    LEFT JOIN roles a ON a.id = h.approver_id
    WHERE h.status IN ('approved','rejected')   -- only show approved/rejected
    ORDER BY h.reserved_date DESC, rm.timeslot ASC
  `;

  con.query(sql, (err, rows) => {
    if (err) return res.status(500).send("Database server error");
    const payload = rows.map(row => ({
      reqIdAndUser: `${row.req_id_padded}/${row.username}`,
      roomCode: row.roomCode,
      date: row.dateText,
      time: row.timeText,
      status: row.statusText,
      approverName: row.approverName || "—",
      rejectReason: row.rejectReason || ""
    }));
    res.json(payload);
  });
});


// -------------------------- dashboard summary status --------------------------
app.get('/api/rooms/status', (req, res) => {
  const sql = `
    SELECT 
      SUM(status = 'free') AS free,
      SUM(status = 'pending') AS pending,
      SUM(status = 'reserved') AS reserved,
      SUM(status = 'disable') AS disable
    FROM rooms
  `;
  con.query(sql, (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }
    res.json(results[0]);
  });
});

// -------------------------- Add room --------------------------
app.post('/api/addRoom', upload.single('image'), async (req, res) => {
  const { roomname, roomtype, image: imagePathFromBody } = req.body;
  const image = req.file 
      ? `/uploads/${req.file.filename}`
      : imagePathFromBody || null;  // 👈 เพิ่ม fallback จาก Flutter

  if (!roomname || !roomtype) {
    return res.status(400).json({ error: 'Room name and room type are required.' });
  }

  const timeSlots = ['08.00-10.00', '10.00-12.00', '13.00-15.00', '15.00-17.00'];

  try {
    for (const slot of timeSlots) {
      const query =
        'INSERT INTO rooms (roomname, roomtype, image, timeslot, status) VALUES (?, ?, ?, ?, ?)';
      const values = [roomname, roomtype, image, slot, 'free'];
      await new Promise((resolve, reject) => {
        con.query(query, values, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    }

    res.status(200).json({ message: 'Rooms added successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred while adding rooms.' });
  }
});

// -------------------------- Update room --------------------------
app.put('/api/updateRoom/:roomId', upload.single('image'), (req, res) => {
  const roomId = req.params.roomId;
  const { roomname, roomtype, status, image: imageFromBody } = req.body;
  let uploadedImagePath = null;

  if (!roomname || !roomtype || !status) {
    return res
      .status(400)
      .json({ error: 'Room name, type, and status are required.' });
  }

  // ✅ ถ้ามีการอัปโหลดไฟล์ใหม่
  if (req.file) {
    uploadedImagePath = `/uploads/${req.file.filename}`;
  }

  const finalImage = uploadedImagePath || imageFromBody || null;

  // ดึงข้อมูลเก่าก่อนอัปเดต
  const sqlGet = 'SELECT roomname, image FROM rooms WHERE id = ? LIMIT 1';
  con.query(sqlGet, [roomId], (err, rows) => {
    if (err) return res.status(500).send('Database error');
    if (rows.length === 0) return res.status(404).send('Room not found');

    const oldName = rows[0].roomname;
    const oldImage = rows[0].image;
    const imageToSave = finalImage || oldImage;

    // ✅ ถ้ามีการอัปโหลดภาพใหม่ ให้ลบของเก่าทิ้ง
    if (uploadedImagePath && oldImage) {
      const oldPath = path.join(__dirname, oldImage);
      if (fs.existsSync(oldPath)) {
        fs.unlink(oldPath, (unlinkErr) => {
          if (unlinkErr)
            console.error(`Failed to delete unused file: ${oldPath}`, unlinkErr);
          else console.log(`Deleted unused image: ${oldPath}`);
        });
      }
    }

    // ✅ อัปเดตข้อมูลใน DB
    const sqlUpdate = `
      UPDATE rooms
      SET roomname = ?, roomtype = ?, status = ?, image = ?
      WHERE roomname = ?;
    `;
    con.query(
      sqlUpdate,
      [roomname, roomtype, status, imageToSave, oldName],
      (err2) => {
        if (err2) {
          console.error(err2);
          return res.status(500).send('Error updating room');
        }

        // ✅ หลังจากอัปเดตเสร็จ ตรวจเพิ่ม ลบไฟล์ที่ไม่ได้ใช้งานจาก uploads/ อื่นๆ ออก
        cleanUnusedImages();

        res.json({
          message: 'Room updated successfully!',
          image: imageToSave,
        });
      }
    );
  });
});

//========================== approver ======================================
//------------------------- History approver --------------------------------

// Approver can view all history (approved + rejected)
app.get("/api/approver/history", (req, res) => {
  const sql = `
    SELECT
      LPAD(h.role_id, 4, '0') AS req_id_padded,
      r.username,
      rm.roomname AS roomCode,
      DATE_FORMAT(h.reserved_date, '%d %b %Y') AS dateText,
      rm.timeslot AS timeText,
      CASE WHEN h.status='approved' THEN 'Approved' ELSE 'Rejected' END AS statusText,
      h.reason AS rejectReason,
      a.username AS approverName
    FROM history h
    JOIN roles r ON r.id = h.role_id
    JOIN rooms rm ON rm.id = h.room_id
    LEFT JOIN roles a ON a.id = h.approver_id
    WHERE h.status IN ('approved','rejected')   -- only show approved/rejected
    ORDER BY h.reserved_date DESC, rm.timeslot ASC
  `;

  con.query(sql, (err, rows) => {
    if (err) return res.status(500).send("Database server error");
    const payload = rows.map(row => ({
      reqIdAndUser: `${row.req_id_padded}/${row.username}`,
      roomCode: row.roomCode,
      date: row.dateText,
      time: row.timeText,
      status: row.statusText,
      approverName: row.approverName || "—",
      rejectReason: row.rejectReason || ""
    }));
    res.json(payload);
  });
});


//========================== Common APIs =================================
//-------------------------- Get all students ------------------------
app.get("/api/staff/student",(_req, res) => {
    const sql = "SELECT id, username FROM roles WHERE role = 'student'";
    con.query(sql, (err, result) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database server error");
        }
        res.json(result);
    });
});
//-------------------------- Get all staffs ------------------------
app.get("/api/staff/staff",(_req, res) => {
    const sql = "SELECT id, username FROM roles WHERE role = 'staff'";
    con.query(sql, (err, result) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database server error");
        }
        res.json(result);
    });
});
//-------------------------- password generator ------------------------
app.get('/api/password/:raw', (req, res) => {
  const raw = req.params.raw;
  const hash = argon2.hashSync(raw);
  res.send(hash);
});

//-------------------------- login ------------------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const sql = "SELECT id, password, role FROM roles WHERE username = ?";
    con.query(sql, [username], function(err, results) {
        if(err) {
            return res.status(500).send("Database server error");
        }
        if(results.length != 1) {
            return res.status(401).send("Wrong username");
        }
        // compare passwords using argon2id
        const same = argon2.verifySync(results[0].password, password);
        if(same) {
            return res.json({"role_id": results[0].id, "username": username, "role": results[0].role});
        }
        return res.status(401).send("Wrong password");
    })
});

//------------------- Register Add new account --------------
app.post("/api/student/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).send("Missing username or password");
    // hash password
    const hashed = await argon2.hash(password);
    const sql = "INSERT INTO roles(username, password, role) VALUES (?, ?, 'student')";
    con.query(sql, [username, hashed], function (err, result) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Database server error");
      }
      if (result.affectedRows != 1) {
        return res.status(500).send("Failed to register");
      }
      res.send('Student registered successfully');
    });
  } catch (e) {
    console.error(e.message);
    res.status(500).send("Server error");
  }
});


//=================== Starting server =======================
const port = 3000;
app.listen(port, () => {
  console.log('Server is running at port ' + port);
});

function cleanUnusedImages() {
  const uploadDir = path.join(__dirname, "uploads");
  fs.readdir(uploadDir, (err, files) => {
    if (err) return console.error("Failed to read upload directory:", err);

    con.query('SELECT image FROM rooms WHERE image IS NOT NULL', (err2, rows) => {
      if (err2) return console.error("Failed to fetch image records from DB:", err2);

      const usedFiles = rows.map(r => path.basename(r.image));
      let deletedCount = 0;

      files.forEach((file) => {
        if (!usedFiles.includes(file)) {
          const fullPath = path.join(uploadDir, file);
          fs.unlink(fullPath, (unlinkErr) => {
            if (unlinkErr) {
              console.error(`Failed to delete unused file '${file}':`, unlinkErr);
            } else {
              deletedCount++;
              console.log(`Deleted unused image: ${file}`);
            }
          });
        }
      });

      if (deletedCount === 0)
        console.log("No unused images found in 'uploads/' folder.");
    });
  });
}