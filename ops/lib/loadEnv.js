// Load .env into process.env (side-effect import). Real environment variables
// (e.g. set by Coolify) always win — .env only fills what's missing.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from ops/lib to the repository root, because this tree is vendored inside
// the Design Studio and the .env sits beside that app's server.js, not beside ops/.
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = [path.join(here, '..', '.env'), path.join(here, '..', '..', '.env')]
  .find((p) => existsSync(p)) || path.join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    if (line.trim().startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
