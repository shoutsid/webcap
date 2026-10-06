/**
 * The README says "All environment variables are documented in .env.example" —
 * a claim an agent reads as a contract, and one that had drifted: nine
 * variables the config layer reads (audit/video prices, spend caps, watch AI
 * budgets, the Glama claim token, the artifact HMAC secret) plus the capture
 * proxy, the video concurrency cap and the stdio MCP base URL were all absent
 * from the template.
 *
 * This guards the claim. It scans real env reads in src/ and fails when one is
 * not documented. Values inside template/HTML literals are skipped: the pages
 * and agent surfaces embed example snippets like `process.env.PAYER_KEY` that a
 * *caller* sets in their own app, not variables this server reads.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Names that appear only inside served example code, never read by the server. */
const EXAMPLE_ONLY = new Set(['PAYER_KEY', 'WALLET_KEY']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Env names the server reads, mapped to the file that reads them first. */
export function readEnvNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of sourceFiles(resolve(process.cwd(), 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:process\.env|env)\.([A-Z][A-Z0-9_]{2,})/g)) {
      const name = match[1] as string;
      if (!names.has(name)) names.set(name, file.replace(`${process.cwd()}/`, ''));
    }
  }
  return names;
}

/** Env names documented in .env.example (as `NAME=` or a commented `# NAME=`). */
export function documentedEnvNames(): Set<string> {
  const text = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) names.add(match[1] as string);
  return names;
}

describe('.env.example', () => {
  it('documents every environment variable the server reads', () => {
    const documented = documentedEnvNames();
    const missing = [...readEnvNames()]
      .filter(([name]) => !EXAMPLE_ONLY.has(name) && !documented.has(name))
      .map(([name, file]) => `${name} (read by ${file})`)
      .sort();
    expect(missing, `undocumented in .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents the config layer even if reads move around', () => {
    const documented = documentedEnvNames();
    // The parser must find something, or it would report a clean bill of health
    // while checking nothing.
    expect(documented.size).toBeGreaterThan(20);
    expect([...documented]).toContain('WEBCAP_CHAIN');
    expect([...documented]).toContain('WEBCAP_PUBLIC_BASE_URL');
  });
});
