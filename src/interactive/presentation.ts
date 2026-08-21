import {
  sourceEvidenceBadge,
  type DataSourceRecord,
} from '../sources.js';
import { paint, symbol, type SebTheme } from './theme.js';

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;
const UNTRUSTED_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_])|\x1b/gu;
const UNTRUSTED_CONTROL_PATTERN = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/gu;
const INLINE_LINK_PATTERN = /(!?)\[([^\]]+)\]\((?:<([^>\s]+)>|(https?:\/\/[^)\s]+))\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>\x1b]+)/gu;
const TERMINAL_LINK_PATTERN = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/gu;
const TERMINAL_CONTROL_PATTERN = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/u;

type TableAlignment = 'center' | 'left' | 'right';

interface MarkdownTable {
  alignments: TableAlignment[];
  headers: string[];
  rows: string[][];
}

export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

export function friendlyToolName(toolName: string): string {
  const descriptions: Record<string, string> = {
    analyzeLeague: 'Analyze the league',
    comparePlayerTrends: 'Compare player usage',
    findPlayers: 'Find Sleeper players',
    getDefenseVsPosition: 'Measure defense by position',
    getGameEnvironment: 'Analyze the game environment',
    getGameWeather: 'Assess kickoff weather',
    getLeagueMatchups: 'Read league matchups',
    getLeagueOverview: 'Read the league',
    getLeagueTransactions: 'Read league transactions',
    getNflSchedule: 'Read the nflverse schedule',
    getNflState: 'Read the current NFL state',
    getPlayerWeeklyStats: 'Read nflverse weekly statistics',
    getRosterPlayers: 'Read roster players',
    getStadiumForecast: 'Read the stadium forecast',
    getTeamPerformance: 'Analyze NFL team performance',
    getTrendingPlayers: 'Read player trends',
    getUserLeagues: 'Read user leagues',
    getWeekWeather: 'Screen weekly weather risk',
    predictMatchup: 'Estimate the matchup',
    projectPlayer: 'Build a scoring-aware projection',
    rankWaiverTargets: 'Rank waiver and FAAB targets',
    analyzeTradeImpact: 'Compare trade impact',
    readNewsUrl: 'Read the supplied web page',
    searchCurrentNews: 'Search current news',
  };
  return descriptions[toolName] ?? humanize(toolName);
}

export function sourceBadge(source: DataSourceRecord, now = new Date()): string {
  return sourceEvidenceBadge(source, now);
}

export function renderAnalysisText(
  text: string,
  theme: SebTheme,
  width = 100,
): string {
  const enhanced = text
    .replace(/^(Confidence:\s*)(?:low|medium|high)?\s*\(?([0-9]{1,3})%\)?\.?$/gimu,
      (_match, label: string, score: string) => `${label}${score}% ${bar(Number(score), 10, theme)}`)
    .replace(/^(Win probability:\s*)([0-9]{1,3})%\.?$/gimu,
      (_match, label: string, score: string) => `${label}${score}% ${bar(Number(score), 20, theme)}`)
    .replace(/^(Weekly points|Usage trend|Schedule difficulty):\s*((?:-?\d+(?:\.\d+)?\s*,\s*)*-?\d+(?:\.\d+)?)$/gimu,
      (_match, label: string, values: string) => `${label}: ${sparkline(values.split(',').map(Number), theme)}`);
  return renderTerminalMarkdown(enhanced, theme, width);
}

export function renderTerminalMarkdown(
  text: string,
  theme: SebTheme,
  width = 100,
): string {
  const maximumWidth = Math.max(20, width);
  const input = sanitizeTerminalText(text).split('\n');
  const output: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const line = input[index] ?? '';
    const fence = line.match(/^```\s*([\w-]*)\s*$/u);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < input.length && !/^```\s*$/u.test(input[index] ?? '')) {
        code.push(input[index] ?? '');
        index += 1;
      }
      output.push(...renderCodeBlock(code, fence[1] ?? '', theme, maximumWidth));
      continue;
    }

    const headers = parseTableRow(line);
    const alignments = headers ? parseTableSeparator(input[index + 1] ?? '') : null;
    if (headers && alignments && headers.length === alignments.length) {
      const rows: string[][] = [];
      index += 2;
      while (index < input.length) {
        const row = parseTableRow(input[index] ?? '');
        if (!row || row.length !== headers.length) break;
        rows.push(row);
        index += 1;
      }
      index -= 1;
      output.push(...renderTable({ alignments, headers, rows }, theme, maximumWidth));
      continue;
    }

    output.push(...renderMarkdownLine(line, theme, maximumWidth));
  }
  return output.join('\n');
}

function renderMarkdownLine(
  line: string,
  theme: SebTheme,
  width: number,
): string[] {
  if (!line.trim()) return [''];
  const heading = line.match(/^(#{1,6})\s+(.+)$/u);
  if (heading) {
    const level = heading[1]?.length ?? 1;
    const marker = theme.iconMode === 'unicode'
      ? level <= 2 ? '━━' : level <= 4 ? '◆' : '›'
      : level <= 2 ? '==' : level <= 4 ? '#' : '>';
    const title = inlineMarkup(
      (heading[2] ?? '').replace(/\s+#+\s*$/u, ''),
      theme,
      level <= 2 ? (value) => value.toUpperCase() : undefined,
    );
    return wrapTerminalLine(`${marker} ${title}`, width).map((value) =>
      paint(theme, level <= 4 ? 'accent' : 'source', value));
  }

  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
    return [paint(theme, 'dim', (theme.iconMode === 'unicode' ? '─' : '-').repeat(width))];
  }

  const list = line.match(/^(\s*)([-*+•]|\d+[.)])\s+(.+)$/u);
  if (list) {
    const depth = Math.min(3, Math.floor((list[1]?.length ?? 0) / 2));
    const listMarker = /^\d/u.test(list[2] ?? '')
      ? list[2] ?? ''
      : symbol(theme, 'bullet');
    const prefix = `${'  '.repeat(depth + 1)}${listMarker} `;
    const contentWidth = Math.max(10, width - visibleLength(prefix));
    const parts = wrapTerminalLine(
      inlineLabeledMarkup(list[3] ?? '', theme),
      contentWidth,
    );
    return parts.map((part, index) =>
      `${index === 0 ? prefix : ' '.repeat(visibleLength(prefix))}${part}`);
  }

  const quote = line.match(/^\s*>\s?(.*)$/u);
  if (quote) {
    const prefix = theme.iconMode === 'unicode' ? '│ ' : '| ';
    return wrapTerminalLine(
      inlineMarkup(quote[1] ?? '', theme),
      Math.max(10, width - 2),
    ).map((part) => `${paint(theme, 'dim', prefix)}${part}`);
  }

  const decisionField = line.match(
    /^(Recommendation|Confidence|Key drivers|Risks|Win probability):\s*(.*)$/iu,
  );
  if (decisionField) {
    return renderLabeledValue(
      decisionField[1] ?? '',
      decisionField[2] ?? '',
      theme,
      width,
      false,
    );
  }

  const labeledValue = line.match(/^([A-Za-z][A-Za-z0-9 /&+-]{1,24}):\s+(.+)$/u);
  if (labeledValue) {
    return renderLabeledValue(
      labeledValue[1] ?? '',
      labeledValue[2] ?? '',
      theme,
      width,
      true,
    );
  }

  return wrapTerminalLine(inlineMarkup(line, theme), width);
}

function renderLabeledValue(
  label: string,
  value: string,
  theme: SebTheme,
  width: number,
  uppercase: boolean,
): string[] {
  const renderedLabel = uppercase ? label.toUpperCase() : `${label}:`;
  const prefix = `${paint(theme, 'source', renderedLabel)}  `;
  const firstWidth = Math.max(10, width - visibleLength(prefix));
  const parts = wrapTerminalLine(inlineMarkup(value, theme), firstWidth);
  return parts.map((part, index) =>
    `${index === 0 ? prefix : ' '.repeat(visibleLength(prefix))}${part}`);
}

function inlineLabeledMarkup(value: string, theme: SebTheme): string {
  const match = value.match(/^([A-Za-z][A-Za-z0-9 /&+-]{1,20}):\s+(.+)$/u);
  if (!match) return inlineMarkup(value, theme);
  return `${paint(theme, 'source', (match[1] ?? '').toUpperCase())}  ${inlineMarkup(match[2] ?? '', theme)}`;
}

function renderCodeBlock(
  code: readonly string[],
  language: string,
  theme: SebTheme,
  width: number,
): string[] {
  const unicode = theme.iconMode === 'unicode';
  const top = `${unicode ? '┌─' : '+-'} CODE${language ? ` · ${language}` : ''}`;
  const side = unicode ? '│ ' : '| ';
  const bottom = unicode ? '└─' : '+-';
  return [
    paint(theme, 'dim', top),
    ...code.flatMap((line) =>
      hardWrap(line, Math.max(1, width - 2)).map((part) =>
        `${paint(theme, 'dim', side)}${paint(theme, 'source', part)}`)),
    paint(theme, 'dim', bottom),
  ];
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const value = trimmed.replace(/^\|/u, '').replace(/\|$/u, '');
  const cells: string[] = [];
  let cell = '';
  let code = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') {
      code = !code;
      cell += character;
      continue;
    }
    if (character === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells.length > 1 ? cells : null;
}

function parseTableSeparator(line: string): TableAlignment[] | null {
  const cells = parseTableRow(line);
  if (!cells || cells.some((cell) => !/^:?-{3,}:?$/u.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });
}

function renderTable(
  original: MarkdownTable,
  theme: SebTheme,
  width: number,
): string[] {
  const originalWidth = naturalTableWidth(original, theme);
  const compact = originalWidth > width ? compactSportsTable(original) : null;
  const table = compact ?? original;
  const canUseGrid = naturalTableWidth(table, theme) <= width ||
    table.headers.length <= 3 ||
    (table.headers.length <= 5 && width >= 48);
  return canUseGrid
    ? renderGridTable(table, theme, width)
    : renderTableCards(table, theme, width);
}

function renderGridTable(
  table: MarkdownTable,
  theme: SebTheme,
  width: number,
): string[] {
  const widths = fitColumnWidths(table, theme, width);
  if (!widths) return renderTableCards(table, theme, width);
  const border = tableBorderCharacters(theme);
  const line = (left: string, middle: string, right: string) =>
    paint(theme, 'dim', `${left}${widths.map((cellWidth) => border.horizontal.repeat(cellWidth + 2)).join(middle)}${right}`);
  const output = [line(border.topLeft, border.topMiddle, border.topRight)];
  output.push(...renderGridRow(
    table.headers.map((header) => header.toUpperCase()),
    widths,
    table.alignments,
    theme,
    true,
    border.vertical,
  ));
  output.push(line(border.middleLeft, border.middle, border.middleRight));
  for (const row of table.rows) {
    output.push(...renderGridRow(
      row,
      widths,
      inferredAlignments(table, row),
      theme,
      false,
      border.vertical,
    ));
  }
  output.push(line(border.bottomLeft, border.bottomMiddle, border.bottomRight));
  return output;
}

function renderGridRow(
  cells: readonly string[],
  widths: readonly number[],
  alignments: readonly TableAlignment[],
  theme: SebTheme,
  header: boolean,
  vertical: string,
): string[] {
  const wrapped = cells.map((cell, index) =>
    wrapTerminalLine(inlineMarkup(cell, theme), widths[index] ?? 3));
  const height = Math.max(1, ...wrapped.map((parts) => parts.length));
  return Array.from({ length: height }, (_, lineIndex) => {
    const rendered = widths.map((cellWidth, columnIndex) => {
      const raw = wrapped[columnIndex]?.[lineIndex] ?? '';
      const value = header ? paint(theme, 'source', raw) : raw;
      return ` ${alignVisible(value, cellWidth, alignments[columnIndex] ?? 'left')} `;
    });
    return `${paint(theme, 'dim', vertical)}${rendered.join(paint(theme, 'dim', vertical))}${paint(theme, 'dim', vertical)}`;
  });
}

function renderTableCards(
  table: MarkdownTable,
  theme: SebTheme,
  width: number,
): string[] {
  const unicode = theme.iconMode === 'unicode';
  const top = unicode ? '╭─' : '+-';
  const side = unicode ? '│ ' : '| ';
  const bottom = unicode ? '╰─' : '+-';
  const identityCount = table.headers.length > 4 ? 2 : 1;
  const output: string[] = [];
  for (const row of table.rows) {
    const identity = table.headers.slice(0, identityCount).map((header, index) => {
      const label = inlineMarkup(header, theme, (value) => value.toUpperCase());
      const value = inlineMarkup(row[index] ?? '—', theme);
      return `${label} ${value}`;
    }).join(' · ');
    const identityLines = wrapTerminalLine(identity, Math.max(10, width - 3));
    output.push(`${paint(theme, 'dim', top)} ${paint(theme, 'assistant', identityLines[0] ?? '')}`);
    for (const continuation of identityLines.slice(1)) {
      output.push(`${paint(theme, 'dim', side)}${paint(theme, 'assistant', continuation)}`);
    }
    const fields = table.headers.slice(identityCount).map((header, index) => {
      const value = row[index + identityCount] ?? '—';
      const label = inlineMarkup(header, theme, (text) => text.toUpperCase());
      return `${paint(theme, 'source', label)} ${inlineMarkup(value, theme)}`;
    });
    for (const packed of packVisible(fields, Math.max(10, width - 2))) {
      output.push(`${paint(theme, 'dim', side)}${packed}`);
    }
    output.push(paint(theme, 'dim', bottom));
  }
  return output;
}

function compactSportsTable(table: MarkdownTable): MarkdownTable | null {
  const identities: number[] = [];
  const groups = new Map<string, Array<{ index: number; label: string }>>();
  for (const [index, header] of table.headers.entries()) {
    const key = normalizeTableHeader(header);
    if (['date', 'game', 'opponent', 'opp', 'player', 'team', 'week'].includes(key)) {
      identities.push(index);
      continue;
    }
    const descriptor = statDescriptor(key);
    if (!descriptor) return null;
    const entries = groups.get(descriptor.group) ?? [];
    entries.push({ index, label: descriptor.label });
    groups.set(descriptor.group, entries);
  }
  const groupedColumnCount = [...groups.values()].reduce((total, entries) => total + entries.length, 0);
  if (identities.length === 0 || groupedColumnCount < 3 || groups.size < 1) return null;
  const groupEntries = [...groups.entries()];
  return {
    headers: [
      ...identities.map((index) => table.headers[index] ?? ''),
      ...groupEntries.map(([group]) => group),
    ],
    alignments: [
      ...identities.map((index) => table.alignments[index] ?? 'left'),
      ...groupEntries.map(() => 'left' as const),
    ],
    rows: table.rows.map((row) => [
      ...identities.map((index) => row[index] ?? ''),
      ...groupEntries.map(([, entries]) => entries.map(({ index, label }) =>
        formatStatValue(row[index] ?? '', label)).join(' · ')),
    ]),
  };
}

function statDescriptor(key: string): { group: string; label: string } | null {
  const descriptions: Record<string, { group: string; label: string }> = {
    carries: { group: 'Rushing', label: 'car' },
    compatt: { group: 'Passing', label: '' },
    completionsattempts: { group: 'Passing', label: '' },
    fantasypts: { group: 'Fantasy', label: 'pts' },
    int: { group: 'Passing', label: 'INT' },
    interceptions: { group: 'Passing', label: 'INT' },
    passtd: { group: 'Passing', label: 'TD' },
    passingtouchdowns: { group: 'Passing', label: 'TD' },
    passingyards: { group: 'Passing', label: 'yd' },
    passyds: { group: 'Passing', label: 'yd' },
    receptions: { group: 'Receiving', label: 'rec' },
    rec: { group: 'Receiving', label: 'rec' },
    receivingtouchdowns: { group: 'Receiving', label: 'TD' },
    receivingyards: { group: 'Receiving', label: 'yd' },
    rectd: { group: 'Receiving', label: 'TD' },
    recyds: { group: 'Receiving', label: 'yd' },
    rushatt: { group: 'Rushing', label: 'car' },
    rushtd: { group: 'Rushing', label: 'TD' },
    rushingtouchdowns: { group: 'Rushing', label: 'TD' },
    rushingyards: { group: 'Rushing', label: 'yd' },
    rushyds: { group: 'Rushing', label: 'yd' },
    targets: { group: 'Receiving', label: 'tgt' },
  };
  return descriptions[key] ?? null;
}

function formatStatValue(value: string, label: string): string {
  if (!value) return '—';
  return label ? `${value} ${label}` : value;
}

function normalizeTableHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

function naturalTableWidth(table: MarkdownTable, theme: SebTheme): number {
  const widths = table.headers.map((header, index) => Math.max(
    visibleLength(inlineMarkup(header, theme)),
    ...table.rows.map((row) => visibleLength(inlineMarkup(row[index] ?? '', theme))),
  ));
  return widths.reduce((total, value) => total + value, 0) + (3 * widths.length) + 1;
}

function fitColumnWidths(
  table: MarkdownTable,
  theme: SebTheme,
  width: number,
): number[] | null {
  const available = width - (3 * table.headers.length) - 1;
  if (available < table.headers.length * 3) return null;
  const natural = table.headers.map((header, index) => Math.max(
    visibleLength(inlineMarkup(header, theme)),
    ...table.rows.map((row) => visibleLength(inlineMarkup(row[index] ?? '', theme))),
  ));
  const minimum = natural.map((value, index) => Math.min(
    value,
    Math.max(3, Math.min(10, visibleLength(inlineMarkup(table.headers[index] ?? '', theme)))),
  ));
  if (minimum.reduce((total, value) => total + value, 0) > available) {
    return null;
  }
  const fitted = [...natural];
  while (fitted.reduce((total, value) => total + value, 0) > available) {
    let widest = -1;
    let slack = 0;
    for (const [index, value] of fitted.entries()) {
      const candidateSlack = value - (minimum[index] ?? 3);
      if (candidateSlack > slack) {
        widest = index;
        slack = candidateSlack;
      }
    }
    if (widest < 0) return null;
    fitted[widest] = (fitted[widest] ?? 3) - 1;
  }
  return fitted;
}

function inferredAlignments(
  table: MarkdownTable,
  row: readonly string[],
): TableAlignment[] {
  return table.headers.map((_header, index) => {
    const configured = table.alignments[index] ?? 'left';
    if (configured !== 'left') return configured;
    const column = table.rows.map((candidate) => candidate[index] ?? '').filter(Boolean);
    const numeric = column.length > 0 && column.every((value) =>
      /^-?[\d,.]+%?$/u.test(value.trim()));
    return numeric && /^-?[\d,.]+%?$/u.test((row[index] ?? '').trim()) ? 'right' : 'left';
  });
}

function alignVisible(
  value: string,
  width: number,
  alignment: TableAlignment,
): string {
  const padding = Math.max(0, width - visibleLength(value));
  if (alignment === 'right') return `${' '.repeat(padding)}${value}`;
  if (alignment === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${value}${' '.repeat(padding - left)}`;
  }
  return `${value}${' '.repeat(padding)}`;
}

function tableBorderCharacters(theme: SebTheme) {
  if (theme.iconMode === 'ascii') {
    return {
      bottomLeft: '+', bottomMiddle: '+', bottomRight: '+', horizontal: '-',
      middle: '+', middleLeft: '+', middleRight: '+',
      topLeft: '+', topMiddle: '+', topRight: '+', vertical: '|',
    };
  }
  return {
    bottomLeft: '└', bottomMiddle: '┴', bottomRight: '┘', horizontal: '─',
    middle: '┼', middleLeft: '├', middleRight: '┤',
    topLeft: '┌', topMiddle: '┬', topRight: '┐', vertical: '│',
  };
}

function packVisible(values: readonly string[], width: number): string[] {
  const separator = '  ·  ';
  const lines: string[] = [];
  let line = '';
  const safeValues = values.flatMap((value) =>
    visibleLength(value) > width ? wrapTerminalLine(value, width) : [value]);
  for (const value of safeValues) {
    if (!line || visibleLength(line) + visibleLength(separator) + visibleLength(value) <= width) {
      line = line ? `${line}${separator}${value}` : value;
      continue;
    }
    lines.push(line);
    line = value;
  }
  if (line) lines.push(line);
  return lines;
}

function hardWrap(value: string, width: number): string[] {
  if (!value) return [''];
  const characters = [...value];
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += width) {
    chunks.push(characters.slice(index, index + width).join(''));
  }
  return chunks;
}

export function terminalLink(label: string, url: string, enabled = true): string {
  if (!isSafeTerminalUrl(url)) return label;
  return enabled ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : `${label} <${url}>`;
}

export function osc52(text: string): string {
  const safe = text.slice(0, 100 * 1024);
  return `\x1b]52;c;${Buffer.from(safe, 'utf8').toString('base64')}\x07`;
}

export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(UNTRUSTED_ESCAPE_PATTERN, '')
    .replace(UNTRUSTED_CONTROL_PATTERN, '');
}

export function wrapTerminalLine(value: string, width: number): string[] {
  if (width <= 1 || visibleLength(value) <= width) return [value];
  const links: string[] = [];
  const protectedValue = value.replace(TERMINAL_LINK_PATTERN, (link) => {
    const index = links.push(link) - 1;
    return `\u{e000}${index}\u{e001}`;
  });
  const words = protectedValue.split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const protectedWord of words) {
    if (!protectedWord) continue;
    const word = protectedWord.replace(/\u{e000}(\d+)\u{e001}/gu,
      (_match, index: string) => links[Number(index)] ?? '');
    const parts = visibleLength(word) > width
      ? splitLongTerminalWord(word, width)
      : [word];
    for (const part of parts) {
      if (line && visibleLength(line) + visibleLength(part) + 1 > width) {
        lines.push(line);
        line = part;
      } else {
        line = line ? `${line} ${part}` : part;
      }
    }
  }
  if (line) lines.push(line);
  return stabilizeTerminalStyles(lines.length > 0 ? lines : ['']);
}

function inlineMarkup(
  value: string,
  theme: SebTheme,
  transform: (value: string) => string = (text) => text,
): string {
  const tokens: string[] = [];
  const protect = (text: string): string => {
    const index = tokens.push(text) - 1;
    return `\u{e100}${index}\u{e101}`;
  };
  let output = value.replace(/\\([\\`*_[\]{}()#+.!~>|-])/gu,
    (_match, character: string) => protect(character));
  output = protectCodeSpans(output, theme, protect);
  output = output.replace(INLINE_LINK_PATTERN,
    (
      _match,
      image: string | undefined,
      label: string | undefined,
      angleUrl: string | undefined,
      markdownUrl: string | undefined,
      autolinkUrl: string | undefined,
      bareUrl: string | undefined,
    ) => {
      const candidate = angleUrl ?? markdownUrl ?? autolinkUrl ?? bareUrl ?? '';
      const { trailing, url } = bareUrl ? trimBareUrl(candidate) : { trailing: '', url: candidate };
      const display = label
        ? applyInlineStyles(transform(label), theme, protect)
        : url;
      const prefix = label
        ? `${symbol(theme, 'source')} ${image ? 'Image: ' : ''}`
        : '';
      const link = !theme.links && !label ? url : terminalLink(display, url, theme.links);
      return protect(`${prefix}${link}${trailing}`);
    });
  output = applyInlineStyles(transform(output), theme, protect);
  return restoreInlineTokens(output, tokens);
}

function protectCodeSpans(
  value: string,
  theme: SebTheme,
  protect: (value: string) => string,
): string {
  return value.replace(/(`+)([\s\S]*?)\1/gu, (_match, _delimiter: string, content: string) => {
    const normalized = content.replace(/\s+/gu, ' ');
    const code = normalized.startsWith(' ') && normalized.endsWith(' ') && normalized.trim()
      ? normalized.slice(1, -1)
      : normalized;
    return protect(inlineCode(theme, code));
  });
}

function applyInlineStyles(
  value: string,
  theme: SebTheme,
  protect: (value: string) => string,
): string {
  const styled = (
    content: string,
    style: 'emphasis' | 'strike' | 'strong' | 'strong-emphasis',
  ) => protect(inlineStyle(
    theme,
    applyInlineStyles(content, theme, protect),
    style,
  ));
  let output = value;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const previous = output;
    output = output
      .replace(/\*{3}(\S(?:[^*\n]*?\S)?)\*{3}/gu,
        (_match, content: string) => styled(content, 'strong-emphasis'))
      .replace(/(^|[^\w_])_{3}(\S(?:[^_\n]*?\S)?)_{3}(?!\w)/gu,
        (_match, prefix: string, content: string) =>
          `${prefix}${styled(content, 'strong-emphasis')}`)
      .replace(/\*{2}(\S(?:[^*\n]*?\S)?)\*{2}/gu,
        (_match, content: string) => styled(content, 'strong'))
      .replace(/(^|[^\w_])_{2}(\S(?:[^_\n]*?\S)?)_{2}(?!\w)/gu,
        (_match, prefix: string, content: string) =>
          `${prefix}${styled(content, 'strong')}`)
      .replace(/~~(\S(?:[^~\n]*?\S)?)~~/gu,
        (_match, content: string) => styled(content, 'strike'))
      .replace(/(^|[^\w*])\*(?!\*)(\S(?:[^*\n]*?\S)?)\*(?=\*{2}|[^*]|$)/gu,
        (_match, prefix: string, content: string) =>
          `${prefix}${styled(content, 'emphasis')}`)
      .replace(/(^|[^\w_])_(?!_)(\S(?:[^_\n]*?\S)?)_(?=_{2}|[^\w_]|$)/gu,
        (_match, prefix: string, content: string) =>
          `${prefix}${styled(content, 'emphasis')}`);
    if (output === previous) break;
  }
  return output;
}

function inlineStyle(
  theme: SebTheme,
  value: string,
  style: 'emphasis' | 'strike' | 'strong' | 'strong-emphasis',
): string {
  if (!theme.color) return value;
  if (style === 'emphasis') return `\x1b[3m${value}\x1b[23m`;
  if (style === 'strike') return `\x1b[9m${value}\x1b[29m`;
  if (style === 'strong-emphasis') return `\x1b[1;3m${value}\x1b[22;23m`;
  return `\x1b[1m${value}\x1b[22m`;
}

function inlineCode(theme: SebTheme, value: string): string {
  const color = theme.palette.source;
  return color ? `${color}${value}\x1b[39m` : value;
}

function restoreInlineTokens(value: string, tokens: readonly string[]): string {
  let output = value;
  for (let iteration = 0; iteration <= tokens.length; iteration += 1) {
    const restored = output.replace(/\u{e100}(\d+)\u{e101}/gu,
      (_match, index: string) => tokens[Number(index)] ?? '');
    if (restored === output) return restored;
    output = restored;
  }
  return output;
}

function isSafeTerminalUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function trimBareUrl(value: string): { trailing: string; url: string } {
  let url = value;
  let trailing = '';
  while (/[.,;:!?]$/u.test(url)) {
    trailing = `${url.at(-1) ?? ''}${trailing}`;
    url = url.slice(0, -1);
  }
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (url.endsWith(close) && count(url, close) > count(url, open)) {
      trailing = `${close}${trailing}`;
      url = url.slice(0, -1);
    }
  }
  return { trailing, url };
}

function count(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}

function stabilizeTerminalStyles(lines: readonly string[]): string[] {
  const activeStyles = new Map<string, string>();
  return lines.map((line) => {
    const prefix = [...activeStyles.values()].join('');
    for (const match of line.matchAll(/\x1b\[([0-9;]*)m/gu)) {
      updateActiveStyles(activeStyles, match[1] ?? '');
    }
    return `${prefix}${line}${activeStyles.size > 0 ? '\x1b[0m' : ''}`;
  });
}

function updateActiveStyles(styles: Map<string, string>, parameters: string): void {
  const codes = parameters ? parameters.split(';').map(Number) : [0];
  for (const code of codes) {
    if (code === 0) styles.clear();
    else if (code === 1 || code === 2) styles.set('intensity', `\x1b[${code}m`);
    else if (code === 3) styles.set('emphasis', '\x1b[3m');
    else if (code === 9) styles.set('strike', '\x1b[9m');
    else if (code === 22) styles.delete('intensity');
    else if (code === 23) styles.delete('emphasis');
    else if (code === 29) styles.delete('strike');
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      styles.set('foreground', `\x1b[${code}m`);
    } else if (code === 39) styles.delete('foreground');
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      styles.set('background', `\x1b[${code}m`);
    } else if (code === 49) styles.delete('background');
  }
}

function splitLongTerminalWord(value: string, width: number): string[] {
  const link = value.match(/^\x1b\]8;;([^\x07\x1b]*)\x07([\s\S]*?)\x1b\]8;;\x07(.*)$/u);
  if (link) {
    const url = link[1] ?? '';
    const label = link[2] ?? '';
    const suffix = link[3] ?? '';
    const chunks = label.includes('\x1b')
      ? hardWrapTerminalText(label, width)
      : hardWrap(label, width);
    return chunks.map((chunk, index) =>
      `${terminalLink(chunk, url)}${index === chunks.length - 1 ? suffix : ''}`);
  }
  return value.includes('\x1b') ? hardWrapTerminalText(value, width) : hardWrap(value, width);
}

function hardWrapTerminalText(value: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let length = 0;
  for (let index = 0; index < value.length;) {
    const control = value.slice(index).match(TERMINAL_CONTROL_PATTERN)?.[0];
    if (control) {
      chunk += control;
      index += control.length;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    chunk += character;
    length += 1;
    index += character.length;
    if (length === width) {
      chunks.push(chunk);
      chunk = '';
      length = 0;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.length > 0 ? chunks : [''];
}

function bar(score: number, width: number, theme: SebTheme): string {
  const value = Math.max(0, Math.min(100, score));
  const filled = Math.round((value / 100) * width);
  const on = theme.iconMode === 'unicode' ? '█' : '#';
  const off = theme.iconMode === 'unicode' ? '░' : '-';
  return paint(theme, value >= 70 ? 'success' : value >= 45 ? 'warning' : 'danger',
    `${on.repeat(filled)}${off.repeat(width - filled)}`);
}

function sparkline(values: number[], theme: SebTheme): string {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return 'no data';
  if (theme.iconMode === 'ascii') return values.map((value) => String(value)).join(' -> ');
  const levels = '▁▂▃▄▅▆▇█';
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return values.map((value) => {
    const index = maximum === minimum ? 3 : Math.round(((value - minimum) / (maximum - minimum)) * 7);
    return levels[index] ?? '▄';
  }).join('');
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
