import express, { Request, Response } from 'express';
import cors from 'cors';
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
    appendFileChange,
    getChangesSince,
} from './db';

const app = express();
app.use(cors());
app.use(express.json());


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
app.post('/sync/:connectionId/file', (req: Request, res: Response) => {
    const { connectionId } = req.params as { connectionId: string };
    const {
        actorUserId,
        relativePath,
        filename,
        isDirectory,
        size,
        contentHash,
        deleted,
    } = req.body as {
        actorUserId: number;
        relativePath: string;
        filename: string;
        isDirectory: number;
        size?: number | null;
        contentHash?: string | null;
        deleted?: number;
    };

    try {
        const metadata = upsertFileMetadata(Number(connectionId), relativePath, filename, isDirectory, size ?? null, contentHash ?? null, deleted ?? 0, actorUserId);
        const change = appendFileChange(Number(connectionId), metadata.id, actorUserId, deleted ? 'delete' : 'update', null, relativePath, contentHash ?? null);
        res.json({ status: 'success', metadata, changeId: change.id });
    } catch (err) {
        console.error('SYNC ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to upsert file metadata.' });
    }
});

app.post('/sync/:connectionId/rename', (req: Request, res: Response) => {
    const { connectionId } = req.params as { connectionId: string };
    const { actorUserId, pathBefore, pathAfter, filenameAfter } = req.body as { actorUserId: number; pathBefore: string; pathAfter: string; filenameAfter: string };

    try {
        const existing = getFileMetadataByConnectionPath(Number(connectionId), pathBefore);
        if (!existing) return res.status(404).json({ status: 'error', message: 'File not found.' });

        // update metadata to new path/name
        const metadata = upsertFileMetadata(Number(connectionId), pathAfter, filenameAfter, existing.is_directory, existing.size ?? null, existing.content_hash ?? null, 0, actorUserId);
        // remove old metadata row
        if (existing.id !== metadata.id) {
            deleteFileMetadata(existing.id);
        }

        const change = appendFileChange(Number(connectionId), metadata.id, actorUserId, 'rename', pathBefore, pathAfter, metadata.content_hash ?? null);
        res.json({ status: 'success', metadata, changeId: change.id });
    } catch (err) {
        console.error('RENAME ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Failed to rename file.' });
    }
});

app.delete('/sync/:connectionId/file', (req: Request, res: Response) => {
    const { connectionId } = req.params as { connectionId: string };
    const { actorUserId, relativePath } = req.body as { actorUserId: number; relativePath: string };

    try {
        const existing = getFileMetadataByConnectionPath(Number(connectionId), relativePath);
        if (!existing) return res.status(404).json({ status: 'error', message: 'File not found.' });

        const metadata = upsertFileMetadata(Number(connectionId), relativePath, existing.filename, existing.is_directory, existing.size ?? null, existing.content_hash ?? null, 1, actorUserId);
        const change = appendFileChange(Number(connectionId), metadata.id, actorUserId, 'delete', relativePath, null, metadata.content_hash ?? null);
        res.json({ status: 'success', metadata, changeId: change.id });
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
