import express, { Request, Response } from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { scryptSync, randomBytes } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database('../db/app.db');

const PASSWORD_KEYLEN = 64;
const PASSWORD_PEPPER = 'soujuryou';

function hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password + PASSWORD_PEPPER, salt, PASSWORD_KEYLEN).toString("hex");

    return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedPassword: string): boolean {
    const [salt, originalHash] = storedPassword.split(":");
    const hash = scryptSync(password + PASSWORD_PEPPER, salt, PASSWORD_KEYLEN).toString("hex");
    return hash === originalHash;
}

app.get('/allusers/:handle', (req: Request, res: Response) => {
    const { handle } = req.params;
    const stmt = db.prepare('SELECT * FROM Users WHERE handle != ?');
    const users = stmt.all(handle);
    res.json(users);
});

app.get('/checkhandle/:handle', (req: Request, res: Response) => {
    const { handle } = req.params;
    
    const stmt = db.prepare('SELECT handle FROM Users WHERE handle = ?');
    const user = stmt.get(handle);

    if (user) {
        res.json({ status: 'NO', message: 'Handle is already taken.' });
    } else {
        res.json({ status: 'OK', message: 'Handle is available.' });
    }
});

app.post('/adduser', (req: Request, res: Response) => {
    const { name, handle, password, email } = req.body;

    try {
        const hashedPassword = hashPassword(password);
        const stmt = db.prepare('INSERT INTO Users (name, handle, password, email) VALUES (?, ?, ?, ?)');
        const info = stmt.run(name, handle, hashedPassword, email);
        
        res.json({ status: 'success', userId: info.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Failed to create user.' });
    }
});

app.post('/checkpassword', (req: Request, res: Response) => {
    const { handle, password } = req.body;

    const stmt = db.prepare('SELECT password FROM Users WHERE handle = ?');
    const user = stmt.get(handle) as { password?: string } | undefined;

    if (!user) {
        res.status(404).json({ status: 'error', message: 'User not found.' });
        return;
    }

    if (typeof user.password === 'string' && verifyPassword(password, user.password)) {
        res.json({ status: 'OK', message: 'Password matches.' });
    } else {
        res.json({ status: 'NO', message: 'Incorrect password.' });
    }
});

app.delete('/deleteuser/:handle', (req: Request, res: Response) => {
    const { handle } = req.params;

    try {
        const stmt = db.prepare('DELETE FROM Users WHERE handle = ?');
        const info = stmt.run(handle);

        if (info.changes > 0) {
            res.json({ status: 'success', message: 'User deleted.' });
        } else {
            res.status(404).json({ status: 'error', message: 'User not found.' });
        }
    } catch (error) {
        console.error("SQLITE ERROR:", error); // <-- Add this line!
        res.status(500).json({ status: 'error', message: error });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
