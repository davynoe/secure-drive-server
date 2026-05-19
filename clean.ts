import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import path from 'path';

const dbPath = path.resolve(__dirname, '../db/app.db');
const syncStorageDir = path.resolve(__dirname, '../sync-storage');

async function cleanSyncStorage(): Promise<void> {
    let entries: string[] = [];
    try {
        entries = await fs.readdir(syncStorageDir);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') return;
        throw error;
    }

    await Promise.all(
        entries.map((entry) =>
            fs.rm(path.join(syncStorageDir, entry), { recursive: true, force: true })
        )
    );
}

function cleanDatabase(): void {
    const db = new Database(dbPath);
    try {
        const deleteChanges = db.prepare('DELETE FROM FileChanges');
        const deleteMetadata = db.prepare('DELETE FROM FileMetadata');
        const deleteConnections = db.prepare('DELETE FROM Connections');

        const txn = db.transaction(() => {
            deleteChanges.run();
            deleteMetadata.run();
            deleteConnections.run();
        });

        txn();
    } finally {
        db.close();
    }
}

async function main(): Promise<void> {
    cleanDatabase();
    await cleanSyncStorage();
    console.log('Cleanup complete.');
}

main().catch((error) => {
    console.error('Cleanup failed:', error);
    process.exitCode = 1;
});
