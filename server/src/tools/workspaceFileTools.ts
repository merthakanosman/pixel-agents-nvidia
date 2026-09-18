import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 200;

export interface WorkspaceListEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface WorkspaceWriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isDeniedRelativePath(relativePath: string): boolean {
  if (!relativePath) return false;

  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts.some((part) => part === '.git' || part === 'node_modules')) {
    return true;
  }

  const base = parts.at(-1)?.toLowerCase() ?? '';
  if (
    base === '.env' ||
    (base.startsWith('.env.') &&
      base !== '.env.example' &&
      base !== '.env.sample' &&
      base !== '.env.template') ||
    base === '.npmrc' ||
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    base.endsWith('.pem') ||
    base.endsWith('.key')
  ) {
    return true;
  }

  return false;
}

export class WorkspaceFileTools {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot) {
      throw new Error('Workspace root is required.');
    }
    this.root = fs.realpathSync(path.resolve(workspaceRoot));
  }

  getRoot(): string {
    return this.root;
  }

  list(relativePath = '.'): WorkspaceListEntry[] {
    const { absolutePath, relativePath: safeRelativePath } = this.resolveSafe(relativePath);
    const realPath = fs.realpathSync(absolutePath);
    this.assertInsideRoot(realPath);

    const stat = fs.statSync(realPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${safeRelativePath || '.'}`);
    }

    const entries: WorkspaceListEntry[] = [];
    for (const entry of fs.readdirSync(realPath, { withFileTypes: true })) {
      if (entries.length >= MAX_LIST_ENTRIES) break;

      const childRelative = path.join(safeRelativePath, entry.name);
      if (isDeniedRelativePath(childRelative)) continue;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile() && !entry.isDirectory()) continue;

      const childAbsolute = path.join(realPath, entry.name);
      const childRealPath = fs.realpathSync(childAbsolute);
      this.assertInsideRoot(childRealPath);

      const childStat = fs.statSync(childRealPath);
      entries.push({
        name: entry.name,
        path: toPosix(childRelative || entry.name),
        type: entry.isDirectory() ? 'directory' : 'file',
        ...(entry.isFile() ? { size: childStat.size } : {}),
      });
    }

    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  read(relativePath: string): { path: string; content: string; bytes: number } {
    const { absolutePath, relativePath: safeRelativePath } = this.resolveSafe(relativePath);
    const realPath = fs.realpathSync(absolutePath);
    this.assertInsideRoot(realPath);

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${safeRelativePath}`);
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(
        `File is too large to read: ${safeRelativePath} (${stat.size} bytes, max ${MAX_READ_BYTES}).`,
      );
    }

    const data = fs.readFileSync(realPath);
    if (data.includes(0)) {
      throw new Error(`Binary files cannot be read: ${safeRelativePath}`);
    }

    return {
      path: toPosix(safeRelativePath),
      content: data.toString('utf8'),
      bytes: data.length,
    };
  }

  write(relativePath: string, content: string): WorkspaceWriteResult {
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      throw new Error(`Write is too large (max ${MAX_WRITE_BYTES} bytes).`);
    }

    const { absolutePath, relativePath: safeRelativePath } = this.resolveSafe(relativePath);
    if (!safeRelativePath) {
      throw new Error('A file path is required for write.');
    }

    const existed = fs.existsSync(absolutePath);
    if (existed) {
      const realPath = fs.realpathSync(absolutePath);
      this.assertInsideRoot(realPath);
      if (!fs.statSync(realPath).isFile()) {
        throw new Error(`Not a file: ${safeRelativePath}`);
      }
    } else {
      this.assertExistingAncestorInsideRoot(path.dirname(absolutePath));
    }

    const parent = path.dirname(absolutePath);
    fs.mkdirSync(parent, { recursive: true });
    this.assertExistingAncestorInsideRoot(parent);

    fs.writeFileSync(absolutePath, content, 'utf8');

    return {
      path: toPosix(safeRelativePath),
      bytes: Buffer.byteLength(content, 'utf8'),
      created: !existed,
    };
  }

  private resolveSafe(inputPath: string): { absolutePath: string; relativePath: string } {
    if (inputPath.includes('\0')) {
      throw new Error('Invalid path.');
    }

    if (path.isAbsolute(inputPath)) {
      throw new Error('Absolute paths are not allowed.');
    }

    const absolutePath = path.resolve(this.root, inputPath || '.');
    const relativePath = path.relative(this.root, absolutePath);

    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Path escapes the workspace.');
    }

    if (isDeniedRelativePath(relativePath)) {
      throw new Error('Access to this path is blocked by workspace safety rules.');
    }

    return { absolutePath, relativePath };
  }

  private assertInsideRoot(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Resolved path escapes the workspace.');
    }
  }

  private assertExistingAncestorInsideRoot(startPath: string): void {
    let current = startPath;

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error('Could not resolve a safe workspace parent.');
      }
      current = parent;
    }

    const realAncestor = fs.realpathSync(current);
    this.assertInsideRoot(realAncestor);
  }
}
