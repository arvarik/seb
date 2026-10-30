import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SECTION_TEXT_LIMIT = 2_400;
const STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in',
  'is', 'it', 'me', 'my', 'of', 'on', 'or', 'seb', 'tell', 'the', 'to', 'use', 'what', 'when',
  'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

export interface SebDocSection {
  file: string;
  heading: string;
  text: string;
}

let sections: Promise<SebDocSection[]> | undefined;

/** Searches the README and docs that ship with Seb, so answers about Seb come from its own documentation. */
export async function searchSebDocs(query: string, limit = 3): Promise<SebDocSection[]> {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/gu) ?? [])]
    .filter((term) => !STOP_WORDS.has(term));
  if (terms.length === 0) return [];
  sections ??= loadSections();
  return (await sections)
    .map((section) => ({ score: sectionScore(section, terms), section }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ section }) => ({ ...section, text: section.text.slice(0, SECTION_TEXT_LIMIT) }));
}

export function formatDocSearch(query: string, results: readonly SebDocSection[]): string {
  if (results.length === 0) {
    return `Seb found no documentation section for "${query}". Run \`/about\` to list the topics.`;
  }
  return [
    `## Seb documentation: "${query}"`,
    '',
    ...results.flatMap((result) => [`### ${result.heading || result.file} (\`${result.file}\`)`, '', result.text, '']),
  ].join('\n').trimEnd();
}

async function loadSections(): Promise<SebDocSection[]> {
  const docs = join(PACKAGE_ROOT, 'docs');
  const names = await readdir(docs, { recursive: true }).catch(() => []);
  const files = [
    join(PACKAGE_ROOT, 'README.md'),
    ...names.filter((name) => name.endsWith('.md')).sort().map((name) => join(docs, name)),
  ];
  const found: SebDocSection[] = [];
  for (const file of files) {
    const markdown = await readFile(file, 'utf8').catch(() => '');
    let heading = '';
    let lines: string[] = [];
    let fenced = false;
    const flush = () => {
      const text = lines.join('\n').trim();
      if (text) found.push({ file: relative(PACKAGE_ROOT, file), heading, text });
    };
    for (const line of markdown.split('\n')) {
      if (line.trimStart().startsWith('```')) fenced = !fenced;
      const match = fenced ? null : /^#{1,4}\s+(.+)$/u.exec(line);
      if (match?.[1]) {
        flush();
        heading = match[1].trim();
        lines = [];
      } else {
        lines.push(line);
      }
    }
    flush();
  }
  return found;
}

// A heading match counts more than body text. A capped body count keeps long sections from winning on length alone.
function sectionScore(section: SebDocSection, terms: readonly string[]): number {
  const heading = section.heading.toLowerCase();
  const text = section.text.toLowerCase();
  return terms.reduce((score, term) =>
    score + (heading.includes(term) ? 4 : 0) + Math.min(5, text.split(term).length - 1), 0);
}
