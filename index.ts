import express, { Request, Response } from 'express';
import cors from 'cors';
import { User, insertUser, deleteUser, getUserByHandle, checkPassword, getAllUsersExcept } from './db';

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
    const { name, handle, password, email } = req.body as User;
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
