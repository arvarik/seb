import { describe, expect, it } from 'vitest';

import {
  formatElapsed,
  osc52,
  renderAnalysisText,
  sourceBadge,
  stripAnsi,
  terminalLink,
  visibleLength,
} from '../src/interactive/presentation.js';
import { createTheme } from '../src/interactive/theme.js';

describe('interactive presentation', () => {
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
    })).toBe('2025 STATS');
    expect(formatElapsed(1_250)).toBe('1.3s');
  });

  it('creates terminal links and clipboard output', () => {
    const link = terminalLink('NWS', 'https://weather.gov');
    const clipboard = osc52('answer');

    expect(stripAnsi(link)).toBe('NWS');
    expect(clipboard).toContain(Buffer.from('answer').toString('base64'));
  });

  it('keeps links in no-color mode and supports accessible themes', () => {
    const noColor = createTheme({ NO_COLOR: '1' });
    const contrast = createTheme({ SEB_THEME: 'high-contrast' });
    const compact = createTheme({ SEB_THEME: 'compact', TERM: 'dumb' });

    expect(noColor.color).toBe(false);
    expect(noColor.links).toBe(true);
    expect(contrast.name).toBe('high-contrast');
    expect(compact.compact).toBe(true);
    expect(compact.links).toBe(false);
  });
});
