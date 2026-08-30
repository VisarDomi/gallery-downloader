import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hitomi, imhentai, type Source, type SourceId } from 'gallery-sources';
import { CONFIG } from './config.js';
import { durableUnlinkSync } from './durable-file.js';

const SOURCES: Record<SourceId, Source> = { hitomi, imhentai };

export interface DeletionResult {
    deleted: number[];
    skipped: { id: number; reason: string }[];
}

export interface DeleteGalleryOptions {
    workingDir?: string;
    komgaLibraryRoot?: string;
}

function fsyncDirectory(directory: string): void {
    const fd = fs.openSync(directory, 'r');
    try {
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function removeDirectoryDurably(directory: string): void {
    try {
        fs.rmSync(directory, { recursive: true, force: true });
        fsyncDirectory(path.dirname(directory));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

export function cleanupRetiredGalleryDirectories(galleryRoot: string): void {
    try {
        for (const name of fs.readdirSync(galleryRoot)) {
            if (/^\.deleting-\d+$/.test(name)) removeDirectoryDurably(path.join(galleryRoot, name));
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

export function findPublishedGalleryIds(
    provider: SourceId,
    komgaLibraryRoot: string = CONFIG.KOMGA_LIBRARY_ROOT,
): number[] {
    const prefix = `${provider}-`;
    const cbzRoot = path.join(komgaLibraryRoot, '_oneshots');
    try {
        return fs.readdirSync(cbzRoot)
            .filter(name => name.startsWith(prefix) && name.endsWith('.cbz'))
            .map(name => Number(name.slice(prefix.length, -'.cbz'.length)))
            .filter(Number.isSafeInteger)
            .sort((a, b) => a - b);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

export function deleteGalleries(
    provider: SourceId,
    ids: number[],
    options: DeleteGalleryOptions = {},
): DeletionResult {
    const source = SOURCES[provider];
    const workingDir = options.workingDir ?? CONFIG.WORKING_DIR;
    const komgaLibraryRoot = options.komgaLibraryRoot ?? CONFIG.KOMGA_LIBRARY_ROOT;
    const galleryRoot = path.join(workingDir, source.gallerySubdir);
    const archivePath = source.download.archivePath(workingDir);
    const cbzRoot = path.join(komgaLibraryRoot, '_oneshots');
    const deleted: number[] = [];
    const skipped: { id: number; reason: string }[] = [];

    cleanupRetiredGalleryDirectories(galleryRoot);

    let archiveDb: Database.Database | null = null;
    try {
        if (provider === 'hitomi' && fs.existsSync(archivePath)) archiveDb = new Database(archivePath);
        const deleteArchiveEntries = archiveDb?.prepare('DELETE FROM archive WHERE entry LIKE ?');

        for (const id of ids) {
            const marker = path.join(galleryRoot, source.downloadingMarker(String(id)));
            if (fs.existsSync(marker)) {
                skipped.push({ id, reason: 'currently downloading' });
                continue;
            }

            try {
                // The archive record is removed first. A crash after this point can leave
                // harmless extra files, but can never make gallery-dl skip missing pages.
                deleteArchiveEntries?.run(`hitomi${id}_%`);

                const galleryDirectory = path.join(galleryRoot, String(id));
                const retiredDirectory = path.join(galleryRoot, `.deleting-${id}`);
                removeDirectoryDurably(retiredDirectory);
                if (fs.existsSync(galleryDirectory)) {
                    fs.renameSync(galleryDirectory, retiredDirectory);
                    fsyncDirectory(galleryRoot);
                }

                durableUnlinkSync(path.join(cbzRoot, `${provider}-${id}.cbz`));
                removeDirectoryDurably(retiredDirectory);
                deleted.push(id);
            } catch (error) {
                skipped.push({ id, reason: String((error as Error)?.message ?? error) });
            }
        }
    } finally {
        archiveDb?.close();
    }

    return { deleted, skipped };
}
