import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import { hitomi } from 'gallery-sources';
import { CONFIG } from './config.js';

const GALLERY_ROOT = path.join(CONFIG.MEDIA_ROOT, hitomi.gallerySubdir);
const ARCHIVE_DB_PATH = hitomi.download.archivePath(CONFIG.MEDIA_ROOT);
const INDEX_DB_PATH = path.join(CONFIG.MEDIA_ROOT, 'gallery-dl', 'gallery-index.db');

interface SkippedEntry {
    id: number;
    reason: string;
}

function findGalleryDir(galleryId: number): string | null {
    const fullPath = path.join(GALLERY_ROOT, String(galleryId));
    try {
        fs.statSync(fullPath);
        return fullPath;
    } catch { /* dir not found */ }
    return null;
}

export const handleDeleteRequest = async (req: Request, res: Response) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids must be a non-empty array' });
    }

    if (!ids.every((id: unknown) => typeof id === 'number' && Number.isInteger(id))) {
        return res.status(400).json({ error: 'all ids must be integers' });
    }

    const deleted: number[] = [];
    const skipped: SkippedEntry[] = [];

    // Check for active downloads first
    for (const id of ids) {
        const markerPath = path.join(GALLERY_ROOT, hitomi.downloadingMarker(String(id)));
        if (fs.existsSync(markerPath)) {
            skipped.push({ id, reason: 'currently downloading' });
        }
    }

    const idsToDelete = ids.filter((id: number) => !skipped.some(s => s.id === id));

    if (idsToDelete.length === 0) {
        return res.json({ deleted, skipped });
    }

    // Open DBs for deletion
    let archiveDb: Database.Database | null = null;
    let indexDb: Database.Database | null = null;

    try {
        if (fs.existsSync(ARCHIVE_DB_PATH)) {
            archiveDb = new Database(ARCHIVE_DB_PATH);
        }
        if (fs.existsSync(INDEX_DB_PATH)) {
            indexDb = new Database(INDEX_DB_PATH);
            indexDb.pragma('foreign_keys = ON');
        }

        const archiveStmt = archiveDb?.prepare('DELETE FROM archive WHERE entry LIKE ?');
        const indexStmt = indexDb?.prepare('DELETE FROM galleries WHERE gallery_id = ?');

        for (const id of idsToDelete) {
            try {
                // 1. Remove directory
                const dir = findGalleryDir(id);
                if (dir) {
                    fs.rmSync(dir, { recursive: true, force: true });
                }

                // 2. Clean archive DB
                archiveStmt?.run(`hitomi${id}_%`);

                // 3. Clean indexer DB (cascades to tags + files)
                indexStmt?.run(id);

                // 4. Remove marker file if it exists (defensive)
                const markerPath = path.join(GALLERY_ROOT, hitomi.downloadingMarker(String(id)));
                try { fs.unlinkSync(markerPath); } catch { /* doesn't exist */ }

                deleted.push(id);
            } catch (e) {
                skipped.push({ id, reason: String(e) });
            }
        }
    } catch (e) {
        return res.status(500).json({ error: `DB error: ${e}` });
    } finally {
        archiveDb?.close();
        indexDb?.close();
    }

    console.log(`[delete] deleted ${deleted.length}, skipped ${skipped.length}`);
    res.json({ deleted, skipped });
};
