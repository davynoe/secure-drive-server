import Database from 'better-sqlite3';
import { scryptSync, randomBytes } from 'crypto';

const db = new Database('../db/app.db');
const PASSWORD_KEYLEN = 64;
const PASSWORD_PEPPER = 'soujuryou';

export interface User {
    id: number;
    name: string;
    handle: string;
    email: string;
}

export interface UserWithPassword extends User {
    password: string;
}

export interface FriendRequest {
    id: number;
    requester_id: number;
    receiver_id: number;
    created_at?: string;
}

export interface Friendship {
    id: number;
    user1_id: number;
    user2_id: number;
}

export interface Connection {
    id: number;
    title: string;
    description: string;
    requester_id: number;
    receiver_id: number;
    initial_base_id: number;
    created_at?: string;
    last_modified?: string;
}

export interface FileMetadata {
    id: number;
    connection_id: number;
    relative_path: string;
    filename: string;
    is_directory: number;
    size?: number | null;
    content_hash?: string | null;
    deleted: number;
    version: number;
    created_at?: string;
    updated_at?: string;
}

export interface FileChange {
    id: number;
    connection_id: number;
    file_metadata_id?: number | null;
    actor_user_id: number;
    op: string; // create, update, rename, delete
    path_before?: string | null;
    path_after?: string | null;
    content_hash?: string | null;
    created_at?: string;
}

export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password + PASSWORD_PEPPER, salt, PASSWORD_KEYLEN).toString('hex');
    return `${salt}:${hash}`;
}

export function getUserByHandle(handle: string): User | null {
    const stmt = db.prepare('SELECT id,name,handle,email FROM Users WHERE handle = ?');
    const row = stmt.get(handle) as User | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function getUserById(userid: number): User | null {
    const stmt = db.prepare('SELECT id,name,handle,email FROM Users WHERE id = ?');
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
    const stmt = db.prepare('SELECT id,name,handle,email FROM Users WHERE id != ?');
    return stmt.all(userid) as User[];
}

export function insertUser(name: string, handle: string, password: string, email: string): User {
    const hashedPassword = hashPassword(password);
    const stmt = db.prepare('INSERT INTO Users (name, handle, password, email) VALUES (?, ?, ?, ?)');
    const info = stmt.run(name, handle, hashedPassword, email);
    return { id: info.lastInsertRowid, name, handle, email } as User;
}

export function deleteUser(userid: number): boolean {
    const stmt = db.prepare('DELETE FROM Users WHERE id = ?');
    const info = stmt.run(userid);
    return info.changes > 0;
}

function normalizeFriendPair(userA: number, userB: number): [number, number] {
    return userA < userB ? [userA, userB] : [userB, userA];
}

export function getFriendRequestById(requestId: number): FriendRequest | null {
    const stmt = db.prepare("SELECT * FROM FriendRequests WHERE id = ? ");
    const row = stmt.get(requestId) as FriendRequest | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function getFriendRequestsForUser(userid: number): FriendRequest[] {
    const stmt = db.prepare(
        "SELECT * FROM FriendRequests WHERE(requester_id = ? OR receiver_id = ?) ORDER BY id DESC"
    );
    return stmt.all(userid, userid) as FriendRequest[];
}

export function getConnectionById(connectionId: number): Connection | null {
    const stmt = db.prepare('SELECT * FROM Connections WHERE id = ?');
    const row = stmt.get(connectionId) as Connection | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function getConnectionRequestsForUser(userid: number): Connection[] {
    const stmt = db.prepare(
        `SELECT * FROM Connections WHERE (requester_id = ? OR receiver_id = ?) AND last_modified IS NULL ORDER BY id DESC`
    );
    return stmt.all(userid, userid) as Connection[];
}

export function getFriendshipByUsers(userA: number, userB: number): Friendship | null {
    const [user1Id, user2Id] = normalizeFriendPair(userA, userB);
    const stmt = db.prepare('SELECT * FROM Friendships WHERE user1_id = ? AND user2_id = ?');
    const row = stmt.get(user1Id, user2Id) as Friendship | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function getFriendshipById(friendshipId: number): Friendship | null {
    const stmt = db.prepare('SELECT * FROM Friendships WHERE id = ?');
    const row = stmt.get(friendshipId) as Friendship | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function getFriendsForUser(userid: number): User[] {
    const stmt = db.prepare(
        `SELECT u.id, u.name, u.handle, u.email
         FROM Users u
         INNER JOIN Friendships f ON (f.user1_id = u.id AND f.user2_id = ?)
            OR (f.user2_id = u.id AND f.user1_id = ?)
         ORDER BY u.name ASC`
    );
    return stmt.all(userid, userid) as User[];
}

export function createFriendRequest(requesterId: number, receiverId: number): FriendRequest | null {
    if (requesterId === receiverId) return null;

    if (getFriendshipByUsers(requesterId, receiverId)) return null;

    const existingRequestStmt = db.prepare(
        `SELECT id FROM FriendRequests WHERE ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?))`
    );
    const existingRequest = existingRequestStmt.get(requesterId, receiverId, receiverId, requesterId);
    if (existingRequest) return null;
    const stmt = db.prepare("INSERT INTO FriendRequests (requester_id, receiver_id) VALUES (?, ?)");
    const info = stmt.run(requesterId, receiverId);
    return getFriendRequestById(Number(info.lastInsertRowid));
}

export function createConnectionRequest(
    requesterId: number,
    receiverId: number,
    title: string,
    description: string,
    initialBaseId: number,
): Connection | null {
    if (requesterId === receiverId) return null;

    if (initialBaseId !== requesterId && initialBaseId !== receiverId) return null;

    if (!getUserById(requesterId) || !getUserById(receiverId) || !getUserById(initialBaseId)) {
        return null;
    }

    const friendship = getFriendshipByUsers(requesterId, receiverId);
    if (!friendship) return null;

    const existingRequestStmt = db.prepare(
        'SELECT id FROM Connections WHERE ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?))',
    );
    const existingRequest = existingRequestStmt.get(requesterId, receiverId, receiverId, requesterId);
    if (existingRequest) return null;

    const stmt = db.prepare(
        'INSERT INTO Connections (title, description, requester_id, receiver_id, initial_base_id, last_modified) VALUES (?, ?, ?, ?, ?, NULL)',
    );
    const info = stmt.run(title, description, requesterId, receiverId, initialBaseId);
    return getConnectionById(Number(info.lastInsertRowid));
}

export function acceptFriendRequest(requestId: number, receiverId: number): boolean {
    const tx = db.transaction((friendRequestId: number, actingUserId: number) => {
        const request = getFriendRequestById(friendRequestId);
        if (!request || request.receiver_id !== actingUserId) {
            throw new Error('Friend request not found.');
        }

        const [user1Id, user2Id] = normalizeFriendPair(request.requester_id, request.receiver_id);
        const friendshipExists = getFriendshipByUsers(user1Id, user2Id);

        if (!friendshipExists) {
            const insertFriendshipStmt = db.prepare('INSERT INTO Friendships (user1_id, user2_id) VALUES (?, ?)');
            insertFriendshipStmt.run(user1Id, user2Id);
        }

        const deleteRequestStmt = db.prepare("DELETE FROM FriendRequests WHERE id = ?");
        deleteRequestStmt.run(friendRequestId);
    });

    try {
        tx(requestId, receiverId);
        return true;
    } catch {
        return false;
    }
}

export function rejectFriendRequest(requestId: number, receiverId: number): boolean {
    const request = getFriendRequestById(requestId);
    if (!request || request.receiver_id !== receiverId) return false;

    const stmt = db.prepare("DELETE FROM FriendRequests WHERE id = ? ");
    const info = stmt.run(requestId);
    return info.changes > 0;
}

export function cancelFriendRequest(requestId: number, requesterId: number): boolean {
    const request = getFriendRequestById(requestId);
    if (!request || request.requester_id !== requesterId) return false;

    const stmt = db.prepare("DELETE FROM FriendRequests WHERE id = ? ");
    const info = stmt.run(requestId);
    return info.changes > 0;
}

export function acceptConnectionRequest(requestId: number, userId: number): number | null {
    const tx = db.transaction((connectionId: number, actingUserId: number) => {
        const request = getConnectionById(connectionId);
    if (!request) throw new Error('Connection request not found.');
    if (request.receiver_id !== actingUserId) throw new Error('Not authorized.');

        db.prepare('UPDATE Connections SET last_modified = CURRENT_TIMESTAMP WHERE id = ?').run(connectionId);

        return connectionId;
  });

  try {
    return tx(requestId, userId) as number;
  } catch {
    return null;
  }
}

export function rejectConnectionRequest(requestId: number, userId: number): boolean {
    const request = getConnectionById(requestId);
    if (!request) return false;

    if (request.receiver_id !== userId) return false;

    const stmt = db.prepare('DELETE FROM Connections WHERE id = ?');
    const info = stmt.run(requestId);
    return info.changes > 0;
}

export function cancelConnectionRequest(requestId: number, userId: number): boolean {
    const request = getConnectionById(requestId);
    if (!request) return false;

    if (request.requester_id !== userId) return false;

    const stmt = db.prepare('DELETE FROM Connections WHERE id = ?');
    const info = stmt.run(requestId);
    return info.changes > 0;
}

// FileMetadata helpers
export function getFileMetadataByConnectionPath(connectionId: number, relativePath: string): FileMetadata | null {
    const stmt = db.prepare('SELECT * FROM FileMetadata WHERE connection_id = ? AND relative_path = ?');
    const row = stmt.get(connectionId, relativePath) as FileMetadata | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function getFileMetadataById(id: number): FileMetadata | null {
    const stmt = db.prepare('SELECT * FROM FileMetadata WHERE id = ?');
    const row = stmt.get(id) as FileMetadata | undefined;
    return typeof row?.id === 'number' ? row : null;
}

export function listFilesForConnection(connectionId: number): FileMetadata[] {
    const stmt = db.prepare('SELECT * FROM FileMetadata WHERE connection_id = ? ORDER BY relative_path ASC');
    return stmt.all(connectionId) as FileMetadata[];
}

export function upsertFileMetadata(
    connectionId: number,
    relativePath: string,
    filename: string,
    isDirectory: number,
    size: number | null,
    contentHash: string | null,
    deleted: number,
    actorUserId: number,
): FileMetadata {
    const existing = getFileMetadataByConnectionPath(connectionId, relativePath);

    if (existing) {
        const newVersion = (existing.version || 1) + 1;
        const stmt = db.prepare(
            'UPDATE FileMetadata SET filename = ?, is_directory = ?, size = ?, content_hash = ?, deleted = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        );
        stmt.run(filename, isDirectory, size, contentHash, deleted, newVersion, existing.id);
        return getFileMetadataById(existing.id) as FileMetadata;
    }

    const insertStmt = db.prepare(
        'INSERT INTO FileMetadata (connection_id, relative_path, filename, is_directory, size, content_hash, deleted, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const info = insertStmt.run(connectionId, relativePath, filename, isDirectory, size, contentHash, deleted, 1);
    return getFileMetadataById(Number(info.lastInsertRowid)) as FileMetadata;
}

export function deleteFileMetadata(id: number): boolean {
    const stmt = db.prepare('DELETE FROM FileMetadata WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
}

// FileChanges helpers
export function appendFileChange(
    connectionId: number,
    fileMetadataId: number | null,
    actorUserId: number,
    op: string,
    pathBefore: string | null,
    pathAfter: string | null,
    contentHash: string | null,
): FileChange {
    const stmt = db.prepare(
        'INSERT INTO FileChanges (connection_id, file_metadata_id, actor_user_id, op, path_before, path_after, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const info = stmt.run(connectionId, fileMetadataId, actorUserId, op, pathBefore, pathAfter, contentHash);
    const row = db.prepare('SELECT * FROM FileChanges WHERE id = ?').get(Number(info.lastInsertRowid)) as FileChange;
    return row;
}

export function getChangesSince(connectionId: number, sinceId: number, limit = 100): FileChange[] {
    const stmt = db.prepare('SELECT * FROM FileChanges WHERE connection_id = ? AND id > ? ORDER BY id ASC LIMIT ?');
    return stmt.all(connectionId, sinceId, limit) as FileChange[];
}