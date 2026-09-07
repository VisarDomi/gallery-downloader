import fs from 'node:fs';
import path from 'node:path';

function syncDirectory(directory: string): void {
    const descriptor = fs.openSync(directory, 'r');
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

/** Write, fsync, rename, and fsync the parent directory. */
export function durableAtomicWriteFileSync(filePath: string, data: string | NodeJS.ArrayBufferView, mode = 0o664): void {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', mode);
        fs.writeFileSync(descriptor, data);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;
        fs.renameSync(temporaryPath, filePath);
        syncDirectory(directory);
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporaryPath); } catch { /* renamed or never created */ }
    }
}

export function durableUnlinkSync(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
        syncDirectory(path.dirname(filePath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}
