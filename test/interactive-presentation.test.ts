import { describe, expect, it } from 'vitest';

import {
  formatElapsed,
  friendlyToolName,
  hardWrapTerminalLine,
  osc52,
  renderAnalysisText,
  sanitizeTerminalText,
  sourceBadge,
  stripAnsi,
  terminalLink,
  visibleLength,
  wrapTerminalLine,
} from '../src/interactive/presentation.js';
import { createTheme } from '../src/interactive/theme.js';

describe('interactive presentation', () => {
  it('shows a clear first-class news progress label', () => {
    expect(friendlyToolName('searchFirstClassNews')).toBe(
      'Search first-class news sources',
    );
  });

  it('removes terminal control sequences from untrusted text', () => {
    const theme = createTheme({ NO_COLOR: '1' });
    const unsafe = 'safe\x1b]52;c;Zm9v\x07 text\x1b[2J\x1bPsecret\x1b\\ done\x08';

    const output = renderAnalysisText(unsafe, theme);

    expect(output).toBe('safe text done');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\x07');
    expect(sanitizeTerminalText('a\x00b\x9fc')).toBe('abc');
    expect(sanitizeTerminalText('a\tb')).toBe('a    b');
  });

  it('measures and wraps complete terminal graphemes', () => {
    expect(visibleLength('界')).toBe(2);
    expect(visibleLength('e\u0301')).toBe(1);
    expect(visibleLength('👨‍👩‍👧‍👦')).toBe(2);
    expect(wrapTerminalLine('界'.repeat(5), 4)).toEqual(['界界', '界界', '界']);
  });

  it('keeps whitespace when it hard-wraps editor text', () => {
    const value = `alpha  beta ${'x'.repeat(20)}`;

    expect(hardWrapTerminalLine(value, 10).join('')).toBe(value);
    expect(hardWrapTerminalLine(value, 10).every((line) => visibleLength(line) <= 10)).toBe(true);
  });
  it('renders decision bars and trend charts', () => {
    const theme = createTheme({ NO_COLOR: '1', SEB_ICONS: 'ascii' });
    const output = renderAnalysisText([
      '## Decision',
      'Confidence: 72%',
      'Win probability: 61%',
      'Weekly points: 8, 14, 10, 19',
    ].join('\n'), theme);

    expect(output).toContain('DECISION');
    expect(output).toContain('72% #######---');
    expect(output).toContain('61% ############--------');
    expect(output).toContain('8 -> 14 -> 10 -> 19');
  });

  it('renders wide NFL stat tables as grouped terminal tables', () => {
    const theme = createTheme({ NO_COLOR: '1' });
    const output = renderAnalysisText([
      'Passing: 183 completions on 292 attempts, 2,549 passing yards, 21 touchdowns',
      '• Rushing: 67 carries, 349 rushing yards, 2 touchdowns',
      '',
      '#### 2025 Regular Season Game-by-Game Breakdown',
      '',
      '| Week | Opponent | Comp / Att | Pass Yds | Pass TD | INT | Carries | Rush Yds | Rush TD |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
      '| 1 | @ BUF | 14 / 19 | 209 | 2 | 0 | 6 | 70 | 1 |',
      '| 2 | vs. CLE | 19 / 29 | 225 | 4 | 0 | 2 | 13 | 0 |',
    ].join('\n'), theme, 76);

    expect(output).toContain('PASSING  183 completions');
    expect(output).toContain('◆ 2025 Regular Season Game-by-Game Breakdown');
    expect(output).toContain('│ WEEK │ OPPONENT │ PASSING');
    expect(output).toContain('14 / 19 · 209 yd · 2 TD · 0 INT');
    expect(output).toContain('6 car · 70 yd · 1 TD');
    expect(output).not.toContain(':---');
    expect(output.split('\n').every((line) => visibleLength(line) <= 76)).toBe(true);
  });

  it('uses record cards for generic tables that cannot fit safely', () => {
    const theme = createTheme({ NO_COLOR: '1' });
    const output = renderAnalysisText([
      '| Player | Team | Metric A | Metric B | Metric C | Metric D |',
      '| --- | --- | --- | --- | --- | --- |',
      '| A very long player name | SEA | Alpha value | Beta value | Gamma value | Delta value |',
    ].join('\n'), theme, 44);

    expect(output).toContain('╭─ PLAYER A very long player name');
    expect(output).toContain('METRIC A Alpha value');
    expect(output).toContain('METRIC D Delta value');
    expect(output.split('\n').every((line) => visibleLength(line) <= 44)).toBe(true);
  });

  it('renders inline Markdown in every wide-table card field', () => {
    const theme = createTheme({ NO_COLOR: '1' });
    const output = renderAnalysisText([
      '| **Player** | Team | Recommendation | Floor | Ceiling | Rationale |',
      '| --- | --- | --- | --- | --- | --- |',
      '| **Lamar Jackson** | **BAL** | **Start** | *High* | __Elite__ | ~~Old~~ Current |',
    ].join('\n'), theme, 44);

    expect(output).toContain('PLAYER Lamar Jackson · TEAM BAL');
    expect(output).toContain('RECOMMENDATION Start');
    expect(output).toContain('FLOOR High');
    expect(output).toContain('CEILING Elite');
    expect(output).toContain('RATIONALE Old Current');
    expect(output).not.toMatch(/[*_~]{1,3}/u);
  });

  it('styles deep headings, Unicode bullets, and fenced code blocks', () => {
    const theme = createTheme({ NO_COLOR: '1' });
    const output = renderAnalysisText([
      '#### Details',
      '• Record: 12-5',
      '```json',
      '{"team":"BAL"}',
      '```',
    ].join('\n'), theme, 60);

    expect(output).toContain('◆ Details');
    expect(output).toContain('• RECORD  12-5');
    expect(output).toContain('┌─ CODE · json');
    expect(output).toContain('│ {"team":"BAL"}');
  });

  it('renders common inline Markdown without visible syntax markers', () => {
    const plainTheme = createTheme({ NO_COLOR: '1' });
    const colorTheme = createTheme({});
    const markdown = [
      '*italic* and _also italic_',
      '**bold** and __also bold__',
      '***bold italic*** and ___also bold italic___',
      '~~removed~~ and **bold with *nested italic*** and __bold with *cross nested italic*__',
      '*italic with **nested bold***',
      '`*literal code*` and \\*escaped literal\\* and snake_case',
    ].join('\n');
    const plain = renderAnalysisText(markdown, plainTheme);
    const color = renderAnalysisText(markdown, colorTheme);

    expect(plain).toBe([
      'italic and also italic',
      'bold and also bold',
      'bold italic and also bold italic',
      'removed and bold with nested italic and bold with cross nested italic',
      'italic with nested bold',
      '*literal code* and *escaped literal* and snake_case',
    ].join('\n'));
    expect(stripAnsi(color)).toBe(plain);
    expect(color).toContain('\x1b[3mitalic\x1b[23m');
    expect(color).toContain('\x1b[1mbold\x1b[22m');
    expect(color).toContain('\x1b[9mremoved\x1b[29m');
  });

  it('renders inline Markdown inside headings and links', () => {
    const theme = createTheme({});
    const output = renderAnalysisText([
      '## **Decision** for *Week 1* ##',
      '[**Detailed report**](https://example.com/report)',
      '![Game chart](https://example.com/chart.png)',
    ].join('\n'), theme);

    expect(stripAnsi(output)).toContain('━━ DECISION FOR WEEK 1');
    expect(stripAnsi(output)).toContain('↗ Detailed report');
    expect(stripAnsi(output)).toContain('↗ Image: Game chart');
    expect(output).not.toMatch(/\*{1,3}(?:Decision|Week 1|Detailed report)\*{1,3}/u);
  });

  it('keeps exact spaces inside inline code', () => {
    const theme = createTheme({ NO_COLOR: '1' });

    expect(renderAnalysisText('Run `a  b` now.', theme)).toBe('Run a  b now.');
    const wrapped = renderAnalysisText('Use a long setup before `a  b` now.', theme, 20);
    expect(wrapped).toContain('a  b');
    expect(wrapped.split('\n').every((line) => visibleLength(line) <= 20)).toBe(true);
  });

  it('keeps inline styles when one long word wraps', () => {
    const theme = createTheme({});
    const word = 'x'.repeat(35);
    const output = renderAnalysisText(`*${word}*`, theme, 20);
    const lines = output.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => visibleLength(line) <= 20)).toBe(true);
    expect(lines.every((line) => line.includes('\x1b[3m'))).toBe(true);
    expect(stripAnsi(output).replace('\n', '')).toBe(word);
  });

  it('renders inline styles in lists, quotes, labels, and tables', () => {
    const theme = createTheme({ NO_COLOR: '1' });
    const output = renderAnalysisText([
      '- Player: **Lamar Jackson**',
      '> *Current starter*',
      'Status: __Ready__',
      '| Field | Value |',
      '| --- | --- |',
      '| Trend | ~~Falling~~ **Rising** |',
    ].join('\n'), theme, 60);

    expect(output).toContain('PLAYER  Lamar Jackson');
    expect(output).toContain('│ Current starter');
    expect(output).toContain('STATUS  Ready');
    expect(output).toContain('Falling Rising');
    expect(output).not.toMatch(/[*~]{1,3}/u);
  });

  it('formats source freshness and elapsed time', () => {
    expect(sourceBadge({
      accessedAt: '2026-08-20T12:00:00Z',
      cacheOutcome: 'cache-fresh',
      id: 'nflverse:weekly',
      label: 'nflverse 2025 weekly stats',
      retrievedAt: '2026-08-20T11:56:00Z',
      url: 'https://github.com/nflverse/nflverse-data/releases',
    }, new Date('2026-08-20T12:00:00Z'))).toBe('CACHED 4m');
    expect(sourceBadge({
      accessedAt: '2026-08-20T12:00:00Z',
      id: 'nflverse:weekly',
      label: 'nflverse 2025 weekly stats',
      url: 'https://github.com/nflverse/nflverse-data/releases',
    })).toBe('LIVE');
    expect(formatElapsed(1_250)).toBe('1.3s');
  });

  it('creates terminal links and clipboard output', () => {
    const link = terminalLink('NWS', 'https://weather.gov');
    const clipboard = osc52('answer');

    expect(stripAnsi(link)).toBe('NWS');
    expect(clipboard).toContain(Buffer.from('answer').toString('base64'));
  });

  it('keeps wrapped Markdown and bare URLs clickable', () => {
    const theme = createTheme({});
    const url = 'https://example.com/a/long/source/path';
    const output = renderAnalysisText([
      `Read the [NFL report source](<${url}>) before the next game.`,
      `Open ${url}.`,
    ].join('\n'), theme, 30);

    expect(output.match(new RegExp(`\\x1b\\]8;;${url}`, 'gu'))?.length).toBeGreaterThanOrEqual(2);
    expect(output).not.toContain('[NFL report source]');
    expect(output.split('\n').every((line) => visibleLength(line) <= 30)).toBe(true);
  });

  it('keeps balanced parentheses in a Markdown link target', () => {
    const theme = createTheme({});
    const url = 'https://example.com/a_(b)';
    const output = renderAnalysisText(`[report](${url})`, theme);

    expect(output).toContain(`\x1b]8;;${url}\x07`);
    expect(stripAnsi(output)).toBe('↗ report');
  });

  it('rejects unsafe terminal link targets', () => {
    expect(terminalLink('Unsafe', 'https://example.com/\u0007bad')).toBe('Unsafe');
  });

  it('keeps links in no-color mode and supports accessible themes', () => {
    const noColor = createTheme({ NO_COLOR: '1' });
    const contrast = createTheme({ SEB_THEME: 'high-contrast' });
    const compact = createTheme({ SEB_THEME: 'compact', TERM: 'dumb' });
    const plainUrl = renderAnalysisText('Open https://example.com/report.', compact);

    expect(noColor.color).toBe(false);
    expect(noColor.links).toBe(true);
    expect(contrast.name).toBe('high-contrast');
    expect(compact.compact).toBe(true);
    expect(compact.links).toBe(false);
    expect(plainUrl).toBe('Open https://example.com/report.');
  });
});
