import { describe, expect, it } from 'vitest';

import {
  findNewsSource,
  FIRST_CLASS_NEWS_SOURCES,
  listTeamNewsSites,
} from '../src/news/sources.js';

describe('first-class news source registry', () => {
  it('uses unique public HTTPS identifiers and discovery URLs', () => {
    const ids = FIRST_CLASS_NEWS_SOURCES.map((source) => source.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))).toBe(true);
    for (const source of FIRST_CLASS_NEWS_SOURCES) {
      for (const value of [source.discoveryUrl, source.homepageUrl]) {
        const url = new URL(value);
        expect(url.protocol).toBe('https:');
        expect(url.username).toBe('');
        expect(url.password).toBe('');
      }
      if (source.discoveryKind === 'html') {
        expect(source.htmlFlavor).toBeDefined();
      }
    }
  });

  it('contains official, independent, and fantasy publishers', () => {
    const categories = new Set(
      FIRST_CLASS_NEWS_SOURCES.map((source) => source.category),
    );

    expect(categories).toEqual(new Set(['official', 'independent', 'fantasy']));
    expect(findNewsSource('nfl')).toMatchObject({
      category: 'official',
      label: 'NFL News',
    });
    expect(FIRST_CLASS_NEWS_SOURCES.some(
      (source) => source.category === 'independent' && !source.team,
    )).toBe(true);
    expect(FIRST_CLASS_NEWS_SOURCES.some(
      (source) => source.category === 'fantasy' && !source.team,
    )).toBe(true);
  });

  it('contains one official news site for every NFL team', () => {
    const teams = listTeamNewsSites();
    const teamSources = FIRST_CLASS_NEWS_SOURCES.filter(
      (source) => source.id.startsWith('team-'),
    );

    expect(teams).toHaveLength(32);
    expect(new Set(teams.map((team) => team.code)).size).toBe(32);
    expect(teamSources).toHaveLength(32);
    expect(new Set(teamSources.map((source) => source.team))).toEqual(
      new Set(teams.map((team) => team.code)),
    );
    for (const team of teams) {
      const source = findNewsSource(`team-${team.code.toLowerCase()}`);
      expect(source).toMatchObject({
        category: 'official',
        homepageUrl: team.url,
        team: team.code,
      });
    }
  });

  it('returns copies of the team site list and protects registry entries', () => {
    const first = listTeamNewsSites();
    const second = listTeamNewsSites();

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(Object.isFrozen(FIRST_CLASS_NEWS_SOURCES)).toBe(true);
    expect(FIRST_CLASS_NEWS_SOURCES.every(Object.isFrozen)).toBe(true);
    expect(findNewsSource('not-configured')).toBeUndefined();
  });
});
