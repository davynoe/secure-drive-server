import Database from 'better-sqlite3';
import { scryptSync, randomBytes } from 'crypto';

const db = new Database('../db/app.db');
const PASSWORD_KEYLEN = 64;
const PASSWORD_PEPPER = 'soujuryou';

export interface User {
    id: number;
    name: string;
    handle: string;
    password: string;
    email: string;
}

export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password + PASSWORD_PEPPER, salt, PASSWORD_KEYLEN).toString('hex');
    return `${salt}:${hash}`;
}

export function getUserByHandle(handle: string): User | null {
    const stmt = db.prepare('SELECT * FROM Users WHERE handle = ?');
    const row = stmt.get(handle) as User | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function getUserById(userid: number): User | null {
    const stmt = db.prepare('SELECT * FROM Users WHERE id = ?');
    const row = stmt.get(userid) as User | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function checkPassword(userid: number, password: string): boolean {
    const stmt = db.prepare('SELECT password FROM Users WHERE id = ?');
    const user = stmt.get(userid) as { password?: string } | undefined;

    if (!user || typeof user.password !== 'string') return false;

    const [salt, originalHash] = user.password.split(':');
    const hash = scryptSync(password + PASSWORD_PEPPER, salt, PASSWORD_KEYLEN).toString('hex');
    return hash === originalHash;
}

export function getAllUsersExcept(userid: number): User[] {
    const stmt = db.prepare('SELECT * FROM Users WHERE id != ?');
    return stmt.all(userid) as User[];
}

export function insertUser(name: string, handle: string, password: string, email: string): User {
    const hashedPassword = hashPassword(password);
    const stmt = db.prepare('INSERT INTO Users (name, handle, password, email) VALUES (?, ?, ?, ?)');
    const info = stmt.run(name, handle, hashedPassword, email);
    return { id: info.lastInsertRowid, name, handle, password: hashedPassword, email } as User;
}

export function deleteUser(userid: number): boolean {
    const stmt = db.prepare('DELETE FROM Users WHERE id = ?');
    const info = stmt.run(userid);
    return info.changes > 0;
}