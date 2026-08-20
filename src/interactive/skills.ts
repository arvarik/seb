export interface SebSkill {
  description: string;
  id: string;
  instructions: string;
  suggestions: readonly string[];
  title: string;
}

export const SEB_SKILLS: readonly SebSkill[] = [
  {
    id: 'general',
    title: 'General manager',
    description: 'Route broad fantasy questions to the correct data and analysis tools.',
    instructions: 'Select the smallest set of tools that answers the request. State each important data limit.',
    suggestions: ['Show this week\'s schedule.', 'Compare two players.', 'Audit my league.'],
  },
  {
    id: 'start-sit',
    title: 'Start and sit',
    description: 'Compare lineup choices with usage, matchup, venue, and weather evidence.',
    instructions: 'Compare recent opportunities, PPR output, opponent strength, game environment, and weather. Give one recommendation and one risk.',
    suggestions: ['Compare two starters.', 'Check the weather risk.', 'Explain the safer floor.'],
  },
  {
    id: 'waiver-scout',
    title: 'Waiver scout',
    description: 'Combine Sleeper demand with nflverse usage and recent production.',
    instructions: 'Start with Sleeper add trends. Verify targets, carries, recent PPR output, and schedule context before ranking players.',
    suggestions: ['Show trending adds.', 'Rank waiver targets by opportunity.', 'Find a high-upside bench add.'],
  },
  {
    id: 'matchup',
    title: 'Fantasy matchup',
    description: 'Compare two Sleeper rosters and explain the likely result.',
    instructions: 'Use prior Sleeper scores for the roster estimate. Add nflverse and weather context only for relevant NFL players and games.',
    suggestions: ['Predict my matchup.', 'Find each roster weakness.', 'Show the largest swing player.'],
  },
  {
    id: 'trade-review',
    title: 'Trade review',
    description: 'Compare both trade sides with production, usage, volatility, and roster need.',
    instructions: 'Separate current value, rest-of-season assumptions, roster fit, and risk. Do not invent market values.',
    suggestions: ['Compare both trade sides.', 'Show the risk for each player.', 'Explain which roster gains more.'],
  },
  {
    id: 'league-audit',
    title: 'League audit',
    description: 'Rank rosters and find strengths, weaknesses, and competitive gaps.',
    instructions: 'Use Sleeper league tools first. State the analysis period and the scoring heuristic.',
    suggestions: ['Rank every roster.', 'Find the weakest position group.', 'Show the closest contenders.'],
  },
  {
    id: 'projection-explainer',
    title: 'Projection explainer',
    description: 'Build transparent expectations from usage and game context.',
    instructions: 'Explain the input data, recent baseline, matchup adjustment, weather adjustment, range, and uncertainty. Do not call an estimate a fact.',
    suggestions: ['Estimate a player range.', 'Explain the opportunity baseline.', 'Show the downside case.'],
  },
  {
    id: 'weather-watch',
    title: 'Weather watch',
    description: 'Find games where wind, rain, cold, heat, or alerts affect fantasy choices.',
    instructions: 'Use the game weather tool. Treat domes separately. Distinguish a forecast from a recorded game condition.',
    suggestions: ['Check this game\'s kickoff weather.', 'List high-risk outdoor games.', 'Explain the kicking impact.'],
  },
  {
    id: 'schedule-scout',
    title: 'Schedule scout',
    description: 'Inspect upcoming opponents, venue, rest, and schedule quality.',
    instructions: 'Use nflverse schedules. Separate completed results from future games. Do not infer a current injury or news event.',
    suggestions: ['Show the next four opponents.', 'Find short-rest games.', 'Compare two playoff schedules.'],
  },
  {
    id: 'usage-trends',
    title: 'Usage trends',
    description: 'Detect changes in targets, carries, shares, output, and volatility.',
    instructions: 'Compare full-period averages with the latest three games. Note small samples and team changes.',
    suggestions: ['Find rising target volume.', 'Compare recent touches.', 'Show volatile players.'],
  },
  {
    id: 'game-environment',
    title: 'Game environment',
    description: 'Combine both teams, the betting line fields, the venue, and weather.',
    instructions: 'Use the combined game environment tool. Explain which facts support pace, scoring, pass volume, or rushing volume.',
    suggestions: ['Analyze one NFL game.', 'Compare both offenses.', 'Show the weather adjustment.'],
  },
  {
    id: 'defense-matchup',
    title: 'Defense by position',
    description: 'Measure the fantasy production that a defense allowed to one position.',
    instructions: 'Use defense-by-position statistics. State the season, week range, game count, and scoring format.',
    suggestions: ['Check a defense against wide receivers.', 'Compare two tight end matchups.', 'Show the sample size.'],
  },
  {
    id: 'playoff-planner',
    title: 'Playoff planner',
    description: 'Compare player and team paths across future fantasy playoff weeks.',
    instructions: 'Use schedule and prior-stat tools. State that future opponent strength can change.',
    suggestions: ['Compare Weeks 15 through 17.', 'Find difficult playoff paths.', 'Check outdoor venues.'],
  },
  {
    id: 'boom-bust',
    title: 'Boom and bust',
    description: 'Compare upside, floor, opportunity, and weekly scoring volatility.',
    instructions: 'Use PPR averages, recent volume, and volatility. Do not claim a precise probability without a calibrated model.',
    suggestions: ['Find the safer floor.', 'Compare weekly volatility.', 'Explain the upside case.'],
  },
  {
    id: 'news-briefing',
    title: 'Source-safe briefing',
    description: 'Summarize connected player changes without inventing publisher news.',
    instructions: 'Use Sleeper status fields and nflverse trends. State that Seb has no publisher news feed when the request needs current reporting.',
    suggestions: ['Show current injury fields.', 'Find recent usage changes.', 'List the missing news sources.'],
  },
] as const;

export function findSkill(value: string): SebSkill | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  return (
    SEB_SKILLS.find(
      (skill) => skill.id === normalized || skill.title.toLowerCase() === value.trim().toLowerCase(),
    ) ?? null
  );
}

export function getSkill(id: string): SebSkill {
  return findSkill(id) ?? SEB_SKILLS[0]!;
}

export function formatSkillList(): string {
  return SEB_SKILLS.map(
    (skill) => `- \`${skill.id}\`: ${skill.description}`,
  ).join('\n');
}
