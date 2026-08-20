import type { DataSourceRecord } from '../sources.js';
import { paint, symbol, type SebTheme } from './theme.js';

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;

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
    readNewsUrl: 'Read the supplied web page',
    searchCurrentNews: 'Search current news',
  };
  return descriptions[toolName] ?? humanize(toolName);
}

export function sourceBadge(source: DataSourceRecord, now = new Date()): string {
  if (source.id.startsWith('web:')) return 'WEB';
  if (source.cacheOutcome === 'stale-if-error') return 'STALE';
  const retrieved = Date.parse(source.retrievedAt ?? source.accessedAt);
  const age = Math.max(0, now.getTime() - retrieved);
  if (source.cacheOutcome === 'cache-fresh') return `CACHED ${shortAge(age)}`;
  if (source.id.toLowerCase().includes('nflverse') || source.url.toLowerCase().includes('nflverse')) {
    const season = `${source.label} ${source.url}`.match(/\b(20\d{2})\b/u)?.[1];
    return season ? `${season} STATS` : 'STATS';
  }
  return 'LIVE';
}

export function renderAnalysisText(text: string, theme: SebTheme): string {
  const enhanced = text
    .replace(/^(Confidence:\s*)(?:low|medium|high)?\s*\(?([0-9]{1,3})%\)?\.?$/gimu,
      (_match, label: string, score: string) => `${label}${score}% ${bar(Number(score), 10, theme)}`)
    .replace(/^(Win probability:\s*)([0-9]{1,3})%\.?$/gimu,
      (_match, label: string, score: string) => `${label}${score}% ${bar(Number(score), 20, theme)}`)
    .replace(/^(Weekly points|Usage trend|Schedule difficulty):\s*((?:-?\d+(?:\.\d+)?\s*,\s*)*-?\d+(?:\.\d+)?)$/gimu,
      (_match, label: string, values: string) => `${label}: ${sparkline(values.split(',').map(Number), theme)}`);
  return renderTerminalMarkdown(enhanced, theme);
}

export function renderTerminalMarkdown(text: string, theme: SebTheme): string {
  return text.split('\n').map((line) => {
    const heading = line.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) return paint(theme, 'accent', heading[2]?.toUpperCase() ?? '');
    const bullet = line.match(/^\s*[-*]\s+(.+)$/u);
    if (bullet) return `  ${symbol(theme, 'bullet')} ${inlineMarkup(bullet[1] ?? '', theme)}`;
    const decisionField = line.match(/^(Recommendation|Confidence|Key drivers|Risks|Win probability):\s*(.*)$/iu);
    if (decisionField) {
      return `${paint(theme, 'source', `${decisionField[1]}:`)} ${inlineMarkup(decisionField[2] ?? '', theme)}`;
    }
    return inlineMarkup(line, theme);
  }).join('\n');
}

export function terminalLink(label: string, url: string, enabled = true): string {
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

export function wrapTerminalLine(value: string, width: number): string[] {
  if (width <= 1 || visibleLength(value) <= width) return [value];
  const plain = stripAnsi(value);
  const words = plain.split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!word) continue;
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function inlineMarkup(value: string, theme: SebTheme): string {
  let output = value.replace(/\[([^\]]+)\]\(<([^>]+)>\)|\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gu,
    (_match, angleLabel: string | undefined, angleUrl: string | undefined, label: string | undefined, url: string | undefined) =>
      `${symbol(theme, 'source')} ${terminalLink(angleLabel ?? label ?? 'source', angleUrl ?? url ?? '', theme.links)}`);
  output = output.replace(/`([^`]+)`/gu, (_match, code: string) => paint(theme, 'source', code));
  output = output.replace(/\*\*([^*]+)\*\*/gu, (_match, strong: string) => paint(theme, 'assistant', strong));
  return output;
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

function shortAge(milliseconds: number): string {
  if (milliseconds < 60_000) return '<1m';
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}m`;
  return `${Math.floor(milliseconds / 3_600_000)}h`;
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
