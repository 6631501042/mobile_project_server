const express = require('express');
const argon2 = require('@node-rs/argon2');
const con = require('./db');


const app = express();
app.use(express.json());


//========================== Users ======================================
//------------------- Get user's expenses --------------
app.get("/api/user/expense/:uid", (req, res) => {
    const uid = req.params.uid;
    const sql = "SELECT * FROM expense WHERE user_id = ?";
    con.query(sql, [uid], function (err, result) {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database server error");
        }
        res.json(result);
    });
});


//------------------- Delete user's expense --------------
app.delete("/api/user/expense/:itemID",(req, res) => {
    const itemID = req.params.itemID;
    const sql = "DELETE FROM expense WHERE id = ?";
    con.query(sql, [itemID], function (err, result) {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database server error");
        }
        if(result.affectedRows != 1) {
            console.error('Deleted row is not 1');
            return res.status(500).send("Database server error");
        }
        res.send('Expense deleted');
    });
});


//------------------- Add new expense --------------
app.post("/api/user/expense", (req, res) => {
    const {uid, item, paid} = req.body;
    const sql = "INSERT INTO expense(user_id, item, paid, date) VALUES (?, ?, ?, NOW())";
    con.query(sql, [uid, item, paid], function (err, result) {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database server error");
        }
        if(result.affectedRows != 1) {
            console.error('Inserted row is not 1');
            return res.status(500).send("Database server error");
        }
        res.send('Expense added');
    });
});


//------------------- Edit expense --------------
app.put("/api/user/expense/:itemID", (req, res) => {
    const itemID = req.params.itemID;
    const {item, paid} = req.body;
    const sql = "UPDATE expense SET item = ?, paid =? WHERE id = ?";
    con.query(sql, [item, paid, itemID], function (err, result) {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database server error");
        }
        if(result.affectedRows != 1) {
            console.error('Updated row is not 1');
            return res.status(500).send("Database server error");
        }
        res.send('Expense updated');
    });
});


//========================== Admin ======================================
//-------------------------- Get all users ------------------------
app.get("/api/admin/users",(_req, res) => {
    const sql = "SELECT id, username FROM users WHERE role = 'user'";
    con.query(sql, (err, result) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database server error");
        }
        res.json(result);
    });
});


//========================== Common APIs =================================
//-------------------------- password generator ------------------------
app.get('/api/password/:raw', (req, res) => {
   const raw = req.params.raw;
   const hash = argon2.hashSync(raw);
    // console.log(hash.length);
    // 97 characters
   res.send(hash);
});


//-------------------------- login ------------------------
app.post('/api/login', (req, res) => {
    const {username, password} = req.body;
    const sql = "SELECT id, password, role FROM users WHERE username = ?";
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
            return res.json({"uid": results[0].id, "username": username, "role": results[0].role});
        }
        return res.status(401).send("Wrong password");
    })
});


//=================== Starting server =======================
const port = 3000;
app.listen(port, () => {
    console.log('Server is running at ' + port);
});
