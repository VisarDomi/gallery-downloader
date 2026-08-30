import fs from "fs";
import path from "path";
import url from "url";

const PACKAGE_JSON = "package.json";

export function findProjectRoot(): string {
    const __filename = url.fileURLToPath(import.meta.url);
    let currentDir = path.dirname(__filename);
    while (true) {
        const packageJsonPath = path.join(currentDir, PACKAGE_JSON);
        if (fs.existsSync(packageJsonPath)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            throw new Error(`Could not find project root containing ${PACKAGE_JSON}`);
        }
        currentDir = parentDir;
    }
}

export function stripAnsi(str: string): string {
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export function getUniqueItems(newItems: string[], activeItem: string | null): string[] {
    const uniqueInput = [...new Set(newItems)];
    return uniqueInput.filter(u => u !== activeItem);
}
