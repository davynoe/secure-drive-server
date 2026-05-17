import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
    insertUser,
    deleteUser,
    getUserByHandle,
    checkPassword,
    getAllUsersExcept,
    createFriendRequest,
    getFriendRequestsForUser,
    getFriendsForUser,
    acceptFriendRequest,
    rejectFriendRequest,
    cancelFriendRequest,
    createConnectionRequest,
    getConnectionRequestsForUser,
    acceptConnectionRequest,
    rejectConnectionRequest,
    cancelConnectionRequest,
    UserWithPassword,
    FileMetadata,
    FileChange,
    upsertFileMetadata,
    getFileMetadataByConnectionPath,
    deleteFileMetadata,
    updateFileMetadataLocation,
    appendFileChange,
    getChangesSince,
    listFilesForConnection,
    getConnectionById,
} from './db';

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

const STORAGE_ROOT = path.resolve('../sync-storage');
// Max allowed chunk size in bytes for upload-chunk (keep reasonably small to avoid JSON/body buffering)
const CHUNK_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB

function sanitizeRelativePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/').filter(Boolean);

    if (segments.length === 0) {
        throw new Error('Relative path is required.');
    }

    if (segments.some((segment) => segment === '..')) {
        throw new Error('Invalid relative path.');
    }

    return segments.join('/');
}

function getConnectionStoragePath(connectionId: number): string {
    return path.join(STORAGE_ROOT, String(connectionId));
}

function getAbsoluteSyncPath(connectionId: number, relativePath: string): string {
    return path.join(getConnectionStoragePath(connectionId), ...sanitizeRelativePath(relativePath).split('/'));
}

function ensureConnectionStorage(connectionId: number): void {
    fs.mkdirSync(getConnectionStoragePath(connectionId), { recursive: true });
}

function ensureParentDirectories(connectionId: number, relativePath: string, actorUserId: number): void {
    const sanitized = sanitizeRelativePath(relativePath);
    const parts = sanitized.split('/');

    if (parts.length < 2) {
        return;
    }

    let currentRelativePath = '';

    for (let index = 0; index < parts.length - 1; index += 1) {
        currentRelativePath = currentRelativePath ? `${currentRelativePath}/${parts[index]}` : parts[index];
        const absolutePath = getAbsoluteSyncPath(connectionId, currentRelativePath);
        fs.mkdirSync(absolutePath, { recursive: true });
        upsertFileMetadata(connectionId, currentRelativePath, parts[index], 1, null, null, 0, actorUserId);
    }
}

function writeFileContent(connectionId: number, relativePath: string, contentBase64?: string, contentText?: string): void {
    const absolutePath = getAbsoluteSyncPath(connectionId, relativePath);
    ensureConnectionStorage(connectionId);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

    if (typeof contentBase64 === 'string') {
        fs.writeFileSync(absolutePath, Buffer.from(contentBase64, 'base64'));
        return;
    }

    if (typeof contentText === 'string') {
        fs.writeFileSync(absolutePath, contentText, 'utf8');
        return;
    }

    throw new Error('File content is required.');
}

function readFileContent(connectionId: number, relativePath: string): Buffer {
    const absolutePath = getAbsoluteSyncPath(connectionId, relativePath);
    return fs.readFileSync(absolutePath);
}

function deleteFileContent(connectionId: number, relativePath: string): void {
    const absolutePath = getAbsoluteSyncPath(connectionId, relativePath);
    fs.rmSync(absolutePath, { recursive: true, force: true });
}

function getUploadTempPath(connectionId: number, uploadId: string): string {
    return path.join(getConnectionStoragePath(connectionId), '.uploads', uploadId);
}

function ensureUploadDirs(connectionId: number, uploadId: string): void {
    const uploadPath = getUploadTempPath(connectionId, uploadId);
    fs.mkdirSync(path.join(uploadPath, 'chunks'), { recursive: true });
}

function writeChunkToTemp(connectionId: number, uploadId: string, chunkIndex: number, buffer: Buffer): void {
    ensureUploadDirs(connectionId, uploadId);
    const chunkPath = path.join(getUploadTempPath(connectionId, uploadId), 'chunks', `${chunkIndex}.chunk`);
    fs.writeFileSync(chunkPath, buffer);
}

function assembleChunksToFile(connectionId: number, uploadId: string, totalChunks: number, destRelativePath: string): { size: number; hash: string } {
    const uploadPath = getUploadTempPath(connectionId, uploadId);
    const chunksDir = path.join(uploadPath, 'chunks');
    const destAbsolute = getAbsoluteSyncPath(connectionId, destRelativePath);
    fs.mkdirSync(path.dirname(destAbsolute), { recursive: true });

    const writeStream = fs.createWriteStream(destAbsolute, { flags: 'w' });
    const hash = createHash('sha256');
    let totalWritten = 0;

    for (let i = 0; i < totalChunks; i += 1) {
        const chunkFile = path.join(chunksDir, `${i}.chunk`);
        if (!fs.existsSync(chunkFile)) {
            writeStream.close();
            throw new Error(`Missing chunk ${i}`);
        }

        const data = fs.readFileSync(chunkFile);
        writeStream.write(data);
        hash.update(data);
        totalWritten += data.length;
    }

    writeStream.close();
    return { size: totalWritten, hash: hash.digest('hex') };
}

function removeUploadTemp(connectionId: number, uploadId: string): void {
    const uploadPath = getUploadTempPath(connectionId, uploadId);
    fs.rmSync(uploadPath, { recursive: true, force: true });
}

function deleteMetadataTree(connectionId: number, relativePath: string): void {
    const sanitizedPath = sanitizeRelativePath(relativePath);
    const prefix = `${sanitizedPath}/`;
    const entries = listFilesForConnection(connectionId)
        .filter((entry) => entry.relative_path === sanitizedPath || entry.relative_path.startsWith(prefix))
        .sort((left, right) => right.relative_path.length - left.relative_path.length);

    for (const entry of entries) {
        deleteFileMetadata(entry.id);
    }
}

function hashContent(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

function getConnectionOr404(connectionId: number, userId: number, res: Response): ReturnType<typeof getConnectionById> {
    const connection = getConnectionById(connectionId);

    if (!connection) {
        res.status(404).json({ status: 'error', message: 'Connection not found.' });
        return null;
    }

    if (connection.requester_id !== userId && connection.receiver_id !== userId) {
        res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        return null;
    }

    return connection;
}


app.get('/allusers/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const userid = Number(id);
    const users = getAllUsersExcept(userid);
    res.json(users);
});

app.post('/signup', (req: Request, res: Response) => {
    const { name, handle, password, email } = req.body as UserWithPassword;
    const existingUser = getUserByHandle(handle);

    if (existingUser) {
        return res.status(400).json({ status: 'error', message: 'Handle already exists.' });
    }

    try {
        const user = insertUser(name, handle, password, email);
        res.json({ status: 'success', id: user.id, name: user.name, handle: user.handle, email: user.email });
    } catch (error) {
        console.error("SQLITE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'Failed to create user.' });
    }
});

app.post('/login', (req: Request, res: Response) => {
    const { handle, password } = req.body as { handle: string; password: string };
    const user = getUserByHandle(handle);
    
    if (!user) {
        return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    if (checkPassword(user.id, password)) {
        res.json({ status: 'success', id: user.id, name: user.name, handle: user.handle, email: user.email });
    } else {
        res.status(401).json({ status: 'error', message: 'Invalid password.' });
    }
});

app.delete('/deleteuser/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const userid = Number(id);

    try {
        const result = deleteUser(userid);

        if (result) {
            res.json({ status: 'success', message: 'User deleted.' });
        } else {
            res.status(404).json({ status: 'error', message: 'User not found.' });
        }
    } catch (error) {
        console.error("SQLITE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'Failed to delete user.' });
    }
});

app.post('/friend-requests', (req: Request, res: Response) => {
    const { requesterId, receiverId } = req.body as { requesterId: number; receiverId: number };

    const friendRequest = createFriendRequest(requesterId, receiverId);

    if (!friendRequest) {
        return res.status(400).json({
            status: 'error',
            message: 'Unable to create friend request. It may already exist, point to self, or the users may already be friends.',
        });
    }

    res.json({ status: 'success', friendRequest });
});

app.get('/friend-requests/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const userid = Number(id);
    const friendRequests = getFriendRequestsForUser(userid);
    res.json(friendRequests);
});

app.get('/friends/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const userid = Number(id);
    const friends = getFriendsForUser(userid);
    res.json(friends);
});

app.post('/friend-requests/:requestId/accept', (req: Request, res: Response) => {
    const { requestId } = req.params as { requestId: string };
    const { userId } = req.body as { userId: number };
    const ok = acceptFriendRequest(Number(requestId), userId);

    if (!ok) {
        return res.status(400).json({ status: 'error', message: 'Unable to accept friend request.' });
    }

    res.json({ status: 'success', message: 'Friend request accepted.' });
});

app.post('/friend-requests/:requestId/reject', (req: Request, res: Response) => {
    const { requestId } = req.params as { requestId: string };
    const { userId } = req.body as { userId: number };
    const ok = rejectFriendRequest(Number(requestId), userId);

    if (!ok) {
        return res.status(400).json({ status: 'error', message: 'Unable to reject friend request.' });
    }

    res.json({ status: 'success', message: 'Friend request rejected.' });
});

app.post('/friend-requests/:requestId/cancel', (req: Request, res: Response) => {
    const { requestId } = req.params as { requestId: string };
    const { userId } = req.body as { userId: number };
    const ok = cancelFriendRequest(Number(requestId), userId);

    if (!ok) {
        return res.status(400).json({ status: 'error', message: 'Unable to cancel friend request.' });
    }

    res.json({ status: 'success', message: 'Friend request canceled.' });
});

app.post('/connection-requests', (req: Request, res: Response) => {
    const { requesterId, receiverId, title, description, initialBaseId } = req.body as { requesterId: number; receiverId: number; title: string; description: string; initialBaseId: number };
    const connectionRequest = createConnectionRequest(requesterId, receiverId, title, description, initialBaseId);

    if (!connectionRequest) {
        return res.status(400).json({
            status: 'error',
            message: 'Unable to create connection request. The users must already be friends and no pending connection request or connection may exist.',
        });
    }

    res.json({ status: 'success', connectionId: connectionRequest.id, connectionRequest });
});

app.get('/connection-requests/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const userid = Number(id);
    const connectionRequests = getConnectionRequestsForUser(userid);
    res.json(connectionRequests);
});

app.post('/connection-requests/:requestId/accept', (req: Request, res: Response) => {
  const { requestId } = req.params as { requestId: string };
  const { userId } = req.body as { userId: number };

  const connectionId = acceptConnectionRequest(Number(requestId), userId);

  if (typeof connectionId !== 'number') {
    return res.status(400).json({ status: 'error', message: 'Unable to accept connection request.' });
  }

  return res.json({
    status: 'success',
    message: 'Connection request accepted.',
    connectionId,
  });
});

app.post('/connection-requests/:requestId/reject', (req: Request, res: Response) => {
    const { requestId } = req.params as { requestId: string };
    const { userId } = req.body as { userId: number };
    const ok = rejectConnectionRequest(Number(requestId), userId);

    if (!ok) {
        return res.status(400).json({ status: 'error', message: 'Unable to reject connection request.' });
    }

    res.json({ status: 'success', message: 'Connection request rejected.' });
});

app.post('/connection-requests/:requestId/cancel', (req: Request, res: Response) => {
    const { requestId } = req.params as { requestId: string };
    const { userId } = req.body as { userId: number };
    const ok = cancelConnectionRequest(Number(requestId), userId);

    if (!ok) {
        return res.status(400).json({ status: 'error', message: 'Unable to cancel connection request.' });
    }

    res.json({ status: 'success', message: 'Connection request canceled.' });
});

// File sync endpoints
app.get('/sync/:connectionId/files', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const userId = Number(req.query.userId);

    if (!userId) {
        return res.status(400).json({ status: 'error', message: 'userId is required.' });
    }

    const connection = getConnectionOr404(connectionId, userId, res);
    if (!connection) return;

    res.json({ status: 'success', files: listFilesForConnection(connectionId) });
});

app.get('/sync/:connectionId/file', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const userId = Number(req.query.userId);
    const relativePath = String(req.query.path || '');

    if (!userId) {
        return res.status(400).json({ status: 'error', message: 'userId is required.' });
    }

    if (!relativePath) {
        return res.status(400).json({ status: 'error', message: 'path is required.' });
    }

    const connection = getConnectionOr404(connectionId, userId, res);
    if (!connection) return;

    try {
        const metadata = getFileMetadataByConnectionPath(connectionId, sanitizeRelativePath(relativePath));
        if (!metadata || metadata.deleted || metadata.is_directory) {
            return res.status(404).json({ status: 'error', message: 'File not found.' });
        }

        const absolutePath = getAbsoluteSyncPath(connectionId, metadata.relative_path);
        if (!fs.existsSync(absolutePath)) {
            return res.status(404).json({ status: 'error', message: 'File not found on disk.' });
        }

        const stat = fs.statSync(absolutePath);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('X-File-Name', metadata.filename);

        const stream = fs.createReadStream(absolutePath);
        stream.on('error', (err) => {
            console.error('STREAM ERROR:', err);
            if (!res.headersSent) res.status(500).end();
        });
        stream.pipe(res);
    } catch (err) {
        console.error('DOWNLOAD ERROR:', err);
        res.status(404).json({ status: 'error', message: 'File not found.' });
    }
});

app.post('/sync/:connectionId/file', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const {
        actorUserId,
        relativePath,
        filename,
        isDirectory,
        size,
        contentHash,
        deleted,
        contentBase64,
        contentText,
    } = req.body as {
        actorUserId: number;
        relativePath: string;
        filename: string;
        isDirectory: number;
        size?: number | null;
        contentHash?: string | null;
        deleted?: number;
        contentBase64?: string;
        contentText?: string;
    };

    try {
        const connection = getConnectionById(connectionId);
        if (!connection) {
            return res.status(404).json({ status: 'error', message: 'Connection not found.' });
        }

        if (connection.requester_id !== actorUserId && connection.receiver_id !== actorUserId) {
            return res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        }

        const sanitizedPath = sanitizeRelativePath(relativePath);
        const existing = getFileMetadataByConnectionPath(connectionId, sanitizedPath);

        if (deleted) {
            if (!existing) {
                return res.status(404).json({ status: 'error', message: 'File not found.' });
            }

            deleteFileContent(connectionId, sanitizedPath);
            const metadata = upsertFileMetadata(connectionId, sanitizedPath, existing.filename, existing.is_directory, existing.size ?? null, existing.content_hash ?? null, 1, actorUserId);
            const change = appendFileChange(connectionId, metadata.id, actorUserId, 'delete', sanitizedPath, null, metadata.content_hash ?? null);
            return res.json({ status: 'success', metadata, changeId: change.id });
        }

        ensureConnectionStorage(connectionId);

        if (isDirectory) {
            const absoluteDirectoryPath = getAbsoluteSyncPath(connectionId, sanitizedPath);
            fs.mkdirSync(absoluteDirectoryPath, { recursive: true });
            ensureParentDirectories(connectionId, sanitizedPath, actorUserId);
            const metadata = upsertFileMetadata(connectionId, sanitizedPath, filename, 1, null, null, 0, actorUserId);
            const change = appendFileChange(connectionId, metadata.id, actorUserId, existing ? 'update' : 'create', existing?.relative_path ?? null, sanitizedPath, null);
            return res.json({ status: 'success', metadata, changeId: change.id });
        }

        ensureParentDirectories(connectionId, sanitizedPath, actorUserId);

        const fileBuffer = typeof contentBase64 === 'string'
            ? Buffer.from(contentBase64, 'base64')
            : typeof contentText === 'string'
                ? Buffer.from(contentText, 'utf8')
                : null;

        if (!fileBuffer) {
            return res.status(400).json({ status: 'error', message: 'File content is required.' });
        }

        writeFileContent(connectionId, sanitizedPath, contentBase64, contentText);

        const computedHash = contentHash ?? hashContent(fileBuffer);
        const metadata = upsertFileMetadata(connectionId, sanitizedPath, filename, 0, fileBuffer.length, computedHash, 0, actorUserId);
        const change = appendFileChange(connectionId, metadata.id, actorUserId, existing ? 'update' : 'create', existing?.relative_path ?? null, sanitizedPath, computedHash);

        res.json({ status: 'success', metadata, changeId: change.id });
    } catch (err) {
        console.error('SYNC ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to upsert file content.' });
    }
});

app.post('/sync/:connectionId/directory', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const { actorUserId, relativePath } = req.body as { actorUserId: number; relativePath: string };

    try {
        const connection = getConnectionById(connectionId);
        if (!connection) {
            return res.status(404).json({ status: 'error', message: 'Connection not found.' });
        }

        if (connection.requester_id !== actorUserId && connection.receiver_id !== actorUserId) {
            return res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        }

        const sanitizedPath = sanitizeRelativePath(relativePath);
        ensureConnectionStorage(connectionId);
        fs.mkdirSync(getAbsoluteSyncPath(connectionId, sanitizedPath), { recursive: true });
        ensureParentDirectories(connectionId, sanitizedPath, actorUserId);

        const existing = getFileMetadataByConnectionPath(connectionId, sanitizedPath);
        const metadata = upsertFileMetadata(connectionId, sanitizedPath, path.posix.basename(sanitizedPath), 1, null, null, 0, actorUserId);
        const change = appendFileChange(connectionId, metadata.id, actorUserId, existing ? 'update' : 'create', existing?.relative_path ?? null, sanitizedPath, null);

        res.json({ status: 'success', metadata, changeId: change.id });
    } catch (err) {
        console.error('DIRECTORY ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to create directory.' });
    }
});

// Chunked upload: init, upload-chunk, complete
app.post('/sync/:connectionId/upload-init', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const { actorUserId } = req.body as { actorUserId: number };

    try {
        const connection = getConnectionById(connectionId);
        if (!connection) return res.status(404).json({ status: 'error', message: 'Connection not found.' });
        if (connection.requester_id !== actorUserId && connection.receiver_id !== actorUserId) {
            return res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        }

        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        ensureUploadDirs(connectionId, uploadId);
        res.json({ status: 'success', uploadId });
    } catch (err) {
        console.error('UPLOAD INIT ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to initialize upload.' });
    }
});

app.post('/sync/:connectionId/upload-chunk', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const { actorUserId, uploadId, chunkIndex, contentBase64 } = req.body as { actorUserId: number; uploadId: string; chunkIndex: number; contentBase64: string };

    if (!uploadId || typeof chunkIndex !== 'number' || !contentBase64) {
        return res.status(400).json({ status: 'error', message: 'uploadId, chunkIndex and contentBase64 are required.' });
    }

    try {
        const connection = getConnectionById(connectionId);
        if (!connection) return res.status(404).json({ status: 'error', message: 'Connection not found.' });
        if (connection.requester_id !== actorUserId && connection.receiver_id !== actorUserId) {
            return res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        }

        const buffer = Buffer.from(contentBase64, 'base64');
        if (buffer.length > CHUNK_SIZE_LIMIT) {
            return res.status(413).json({ status: 'error', message: `Chunk too large. Max ${CHUNK_SIZE_LIMIT} bytes.` });
        }
        writeChunkToTemp(connectionId, uploadId, chunkIndex, buffer);
        res.json({ status: 'success', uploaded: chunkIndex });
    } catch (err) {
        console.error('UPLOAD CHUNK ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to write chunk.' });
    }
});

app.post('/sync/:connectionId/upload-complete', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const { actorUserId, uploadId, totalChunks, relativePath, filename, contentHash } = req.body as { actorUserId: number; uploadId: string; totalChunks: number; relativePath: string; filename: string; contentHash?: string };

    if (!uploadId || typeof totalChunks !== 'number' || !relativePath || !filename) {
        return res.status(400).json({ status: 'error', message: 'uploadId, totalChunks, relativePath and filename are required.' });
    }

    try {
        const connection = getConnectionById(connectionId);
        if (!connection) return res.status(404).json({ status: 'error', message: 'Connection not found.' });
        if (connection.requester_id !== actorUserId && connection.receiver_id !== actorUserId) {
            return res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        }

        const sanitizedPath = sanitizeRelativePath(relativePath);
        ensureConnectionStorage(connectionId);

        const assembled = assembleChunksToFile(connectionId, uploadId, totalChunks, sanitizedPath);
        const computedHash = contentHash ?? assembled.hash;
        const metadata = upsertFileMetadata(connectionId, sanitizedPath, filename, 0, assembled.size, computedHash, 0, actorUserId);
        const change = appendFileChange(connectionId, metadata.id, actorUserId, 'create', null, sanitizedPath, computedHash);
        removeUploadTemp(connectionId, uploadId);

        res.json({ status: 'success', metadata, changeId: change.id });
    } catch (err) {
        console.error('UPLOAD COMPLETE ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to complete upload.' });
    }
});

app.post('/sync/:connectionId/rename', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const { actorUserId, pathBefore, pathAfter, filenameAfter } = req.body as {
        actorUserId: number;
        pathBefore: string;
        pathAfter: string;
        filenameAfter: string;
    };

    try {
        const connection = getConnectionById(connectionId);
        if (!connection) {
            return res.status(404).json({ status: 'error', message: 'Connection not found.' });
        }

        if (connection.requester_id !== actorUserId && connection.receiver_id !== actorUserId) {
            return res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        }

        const sanitizedBefore = sanitizeRelativePath(pathBefore);
        const sanitizedAfter = sanitizeRelativePath(pathAfter);
        const existing = getFileMetadataByConnectionPath(connectionId, sanitizedBefore);

        if (!existing) {
            return res.status(404).json({ status: 'error', message: 'File not found.' });
        }

        ensureConnectionStorage(connectionId);
        const oldAbsolutePath = getAbsoluteSyncPath(connectionId, sanitizedBefore);
        const newAbsolutePath = getAbsoluteSyncPath(connectionId, sanitizedAfter);
        fs.mkdirSync(path.dirname(newAbsolutePath), { recursive: true });
        fs.renameSync(oldAbsolutePath, newAbsolutePath);

        const updatedRoot = updateFileMetadataLocation(existing.id, sanitizedAfter, filenameAfter);
        if (!updatedRoot) {
            return res.status(500).json({ status: 'error', message: 'Failed to update metadata.' });
        }

        if (existing.is_directory) {
            const oldPrefix = `${sanitizedBefore}/`;
            const newPrefix = `${sanitizedAfter}/`;
            const descendants = listFilesForConnection(connectionId)
                .filter((entry) => entry.relative_path.startsWith(oldPrefix))
                .sort((left, right) => left.relative_path.length - right.relative_path.length);

            for (const descendant of descendants) {
                const suffix = descendant.relative_path.slice(oldPrefix.length);
                const nextRelativePath = `${newPrefix}${suffix}`;
                updateFileMetadataLocation(descendant.id, nextRelativePath, path.posix.basename(nextRelativePath));
            }
        }

        const change = appendFileChange(connectionId, updatedRoot.id, actorUserId, 'rename', sanitizedBefore, sanitizedAfter, updatedRoot.content_hash ?? null);
        res.json({ status: 'success', metadata: updatedRoot, changeId: change.id });
    } catch (err) {
        console.error('RENAME ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to rename file.' });
    }
});

app.delete('/sync/:connectionId/file', (req: Request, res: Response) => {
    const connectionId = Number((req.params as { connectionId: string }).connectionId);
    const { actorUserId, relativePath } = req.body as { actorUserId: number; relativePath: string };

    try {
        const connection = getConnectionById(connectionId);
        if (!connection) {
            return res.status(404).json({ status: 'error', message: 'Connection not found.' });
        }

        if (connection.requester_id !== actorUserId && connection.receiver_id !== actorUserId) {
            return res.status(403).json({ status: 'error', message: 'Not authorized for this connection.' });
        }

        const sanitizedPath = sanitizeRelativePath(relativePath);
        const existing = getFileMetadataByConnectionPath(connectionId, sanitizedPath);

        if (!existing) {
            return res.status(404).json({ status: 'error', message: 'File not found.' });
        }

        const change = appendFileChange(connectionId, existing.id, actorUserId, 'delete', sanitizedPath, null, existing.content_hash ?? null);
        deleteFileContent(connectionId, sanitizedPath);

        if (existing.is_directory) {
            deleteMetadataTree(connectionId, sanitizedPath);
        } else {
            deleteFileMetadata(existing.id);
        }

        res.json({ status: 'success', changeId: change.id });
    } catch (err) {
        console.error('DELETE ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to delete file.' });
    }
});

app.get('/sync/:connectionId/changes', (req: Request, res: Response) => {
    const { connectionId } = req.params as { connectionId: string };
    const cursor = Number(req.query.cursor || 0);
    const limit = Number(req.query.limit || 100);

    try {
        const changes = getChangesSince(Number(connectionId), cursor, limit);
        res.json({ status: 'success', changes });
    } catch (err) {
        console.error('FETCH CHANGES ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to fetch changes.' });
    }
});


const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
