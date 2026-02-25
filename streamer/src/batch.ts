import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { CONFIG } from './config.js';

export const handleBatchRequest = (req: Request, res: Response) => {
    const { files } = req.body; // Expects string[]

    if (!files || !Array.isArray(files)) {
        return res.status(400).json({ error: "Invalid input. Expected 'files' array." });
    }

    const results: Record<string, string | null> = {};

    for (const relativePath of files) {
        try {
            const fullPath = path.join(CONFIG.MEDIA_ROOT, relativePath);
            if (fs.existsSync(fullPath)) {
                const bitmap = fs.readFileSync(fullPath);
                // Simple extension extraction
                const mime = path.extname(fullPath).toLowerCase().replace('.', '');
                results[relativePath] = `data:image/${mime};base64,${bitmap.toString('base64')}`;
            } else {
                results[relativePath] = null;
            }
        } catch (e) {
            console.error(`Error processing file: ${relativePath}`, e);
            results[relativePath] = null;
        }
    }

    res.json(results);
};