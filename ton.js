// server.js
const express = require('express');
const cors = require('cors');
const argon2 = require('@node-rs/argon2');
const con = require('./db');

const app = express();
console.log('>>> RUNNING FROM:', __filename);

app.use(cors());
app.use(express.json());

// วางไว้ใต้ app.use(express.json())
app.use((req,res,next)=>{
  console.log('> IN:', req.method, req.url);
  next();
});

// วางไว้เหนือทุก route หรือจะวางท้าย ๆ ก็ได้
app.get('/__routes', (_req,res)=>{
  res.json([
    'GET  /__health',
    'POST /api/student/reserve',
    'GET  /api/student/status/:roleID',
    'GET  /api/approver/pending'
  ]);
});

// ─────────────────────────── Health ───────────────────────────
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
app.get('/api/student/status/:roleID', (req, res) => {
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