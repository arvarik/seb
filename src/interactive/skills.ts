export interface SebSkill {
  category: 'Fantasy' | 'NFL information' | 'Research';
  description: string;
  id: string;
  instructions: string;
  suggestions: readonly string[];
  title: string;
}

export interface SebSkillInvocation {
  prompt: string;
  skill: SebSkill;
}

export const SEB_SKILLS: readonly SebSkill[] = [
  {
    id: 'general',
    title: 'Fantasy assistant',
    category: 'Fantasy',
    description: 'Route broad fantasy questions to the correct data and analysis tools.',
    instructions: 'Select the smallest set of tools that answers the request. State each important data limit.',
    suggestions: ['Show this week\'s schedule.', 'Compare two players.', 'Audit my league.'],
  },
  {
    id: 'player-info',
    title: 'Player information',
    category: 'NFL information',
    description: 'Show one NFL player profile, game log, season statistics, and verified news.',
    instructions: [
      'Answer as an NFL information assistant.',
      'Do not add fantasy advice unless the user requests it.',
      'Use findPlayers for the current player profile.',
      'Use resolvePlayerIdentity when the name is ambiguous.',
      'Use getPlayerWeeklyStats for game logs and season statistics.',
      'Use searchCurrentNews only when the request needs current reporting.',
      'Separate profile data, recorded statistics, and news claims.',
    ].join(' '),
    suggestions: [
      'Show <Player>\'s profile and recent NFL statistics.',
      'Summarize <Player>\'s season game log.',
      'Find the latest verified news about <Player>.',
    ],
  },
  {
    id: 'team-info',
    title: 'Team information',
    category: 'NFL information',
    description: 'Show one NFL team identity, players, schedule, results, statistics, and news.',
    instructions: [
      'Answer as an NFL information assistant.',
      'Do not add fantasy advice unless the user requests it.',
      'Use resolveTeamIdentity for the franchise identity.',
      'Use getTeamPlayers for current Sleeper player records.',
      'Use getNflSchedule for the schedule and recorded results.',
      'Use getTeamPerformance for prior performance statistics.',
      'Use searchCurrentNews only when the request needs current reporting.',
      'Do not call Sleeper player records an official NFL roster.',
    ].join(' '),
    suggestions: [
      'Show the <NFL team> team profile and player list.',
      'Summarize the <NFL team> season and recent results.',
      'Show the <NFL team> schedule and verified news.',
    ],
  },
  {
    id: 'nfl-stats',
    title: 'NFL facts and stats',
    category: 'NFL information',
    description: 'Answer general NFL schedule, result, player, team, and statistical questions.',
    instructions: [
      'Answer as an NFL information assistant.',
      'Do not add fantasy advice unless the user requests it.',
      'Use getNflState for the current season phase and week.',
      'Use getNflSchedule for schedules, venues, lines, and results.',
      'Use getPlayerWeeklyStats for recorded player statistics.',
      'Use getTeamPerformance for one team performance summary.',
      'State the season, week range, and source limit for each statistic.',
    ].join(' '),
    suggestions: [
      'Show the NFL schedule for Week <number>.',
      'Show <Player>\'s NFL game log and season totals.',
      'Compare <Team A> and <Team B> by recorded NFL results.',
    ],
  },
  {
    id: 'start-sit',
    title: 'Start and sit',
    category: 'Fantasy',
    description: 'Compare lineup choices with usage, matchup, venue, and weather evidence.',
    instructions: 'Compare recent opportunities, PPR output, opponent strength, game environment, and weather. Give one recommendation and one risk.',
    suggestions: ['Compare two starters.', 'Check the weather risk.', 'Explain the safer floor.'],
  },
  {
    id: 'waiver-scout',
    title: 'Waiver scout',
    category: 'Fantasy',
    description: 'Combine Sleeper demand with nflverse usage and recent production.',
    instructions: 'Use rankWaiverTargets with the selected league and roster. Explain roster need, scoring-aware recent production, Sleeper demand, risk, and the FAAB range. State that Sleeper demand covers the complete platform.',
    suggestions: ['Show trending adds.', 'Rank waiver targets by opportunity.', 'Find a high-upside bench add.'],
  },
  {
    id: 'matchup',
    title: 'Fantasy matchup',
    category: 'Fantasy',
    description: 'Compare two Sleeper rosters and explain the likely result.',
    instructions: 'Use prior Sleeper scores for the roster estimate. Add nflverse and weather context only for relevant NFL players and games.',
    suggestions: ['Predict my matchup.', 'Find each roster weakness.', 'Show the largest swing player.'],
  },
  {
    id: 'trade-review',
    title: 'Trade review',
    category: 'Fantasy',
    description: 'Compare both trade sides with production, usage, volatility, and roster need.',
    instructions: [
      'Ask for both trade sides when the request omits them.',
      'Use findPlayers to resolve each player.',
      'Use comparePlayerTrends for prior production and usage.',
      'Use the prior completed season when the current regular season has no completed games.',
      'Use getRosterPlayers when roster context affects fit.',
      'Use getLeagueTransactions only for an identified Sleeper transaction.',
      'Use searchCurrentNews only for current reporting.',
      'Separate current evidence, rest-of-season assumptions, roster fit, and risk.',
      'Never invent trade-chart or market values.',
    ].join(' '),
    suggestions: [
      'Compare <Side A> for <Side B>.',
      'Review <Player A> and <Player B> for my roster.',
      'Explain the risk on both sides of <trade>.',
    ],
  },
  {
    id: 'league-audit',
    title: 'League audit',
    category: 'Fantasy',
    description: 'Rank rosters and find strengths, weaknesses, and competitive gaps.',
    instructions: 'Use Sleeper league tools first. State the analysis period and the scoring heuristic.',
    suggestions: ['Rank every roster.', 'Find the weakest position group.', 'Show the closest contenders.'],
  },
  {
    id: 'projection-explainer',
    title: 'Projection explainer',
    category: 'Fantasy',
    description: 'Build transparent expectations from usage and game context.',
    instructions: 'Explain the input data, recent baseline, matchup adjustment, weather adjustment, range, and uncertainty. Do not call an estimate a fact.',
    suggestions: ['Estimate a player range.', 'Explain the opportunity baseline.', 'Show the downside case.'],
  },
  {
    id: 'weather-watch',
    title: 'Weather watch',
    category: 'Research',
    description: 'Find games where wind, rain, cold, heat, or alerts affect fantasy choices.',
    instructions: [
      'Use getGameWeather for one scheduled game.',
      'Use getWeekWeather for a weekly screen.',
      'Use getStadiumForecast only for a stadium outlook without a scheduled game.',
      'Pass REG during the regular season or POST during postseason.',
      'nflverse schedule releases do not include preseason game rows.',
      'Pass PRE to getGameWeather during preseason.',
      'During preseason, give a home-stadium outlook and state that it is not matched to a venue or kickoff.',
      'Treat a dome or closed roof separately.',
      'Distinguish a forecast from recorded conditions.',
      'Explain when the kickoff falls outside the NWS forecast window.',
      'Ask for a team or week only when the selected tool requires it.',
    ].join(' '),
    suggestions: [
      'Check <NFL team>\'s Week <number> kickoff weather.',
      'List outdoor weather risks for Week <number>.',
      'Explain the weather impact for <NFL team>.',
    ],
  },
  {
    id: 'schedule-scout',
    title: 'Schedule scout',
    category: 'Research',
    description: 'Inspect upcoming opponents, venue, rest, and schedule quality.',
    instructions: 'Use nflverse schedules. Separate completed results from future games. Do not infer a current injury or news event.',
    suggestions: ['Show the next four opponents.', 'Find short-rest games.', 'Compare two playoff schedules.'],
  },
  {
    id: 'usage-trends',
    title: 'Usage trends',
    category: 'Research',
    description: 'Detect changes in targets, carries, shares, output, and volatility.',
    instructions: 'Compare full-period averages with the latest three games. Note small samples and team changes.',
    suggestions: ['Find rising target volume.', 'Compare recent touches.', 'Show volatile players.'],
  },
  {
    id: 'game-environment',
    title: 'Game environment',
    category: 'Research',
    description: 'Combine both teams, the betting line fields, the venue, and weather.',
    instructions: 'Use the combined game environment tool. Explain which facts support pace, scoring, pass volume, or rushing volume.',
    suggestions: ['Analyze one NFL game.', 'Compare both offenses.', 'Show the weather adjustment.'],
  },
  {
    id: 'defense-matchup',
    title: 'Defense by position',
    category: 'Fantasy',
    description: 'Measure the fantasy production that a defense allowed to one position.',
    instructions: 'Use defense-by-position statistics. State the season, week range, game count, and scoring format.',
    suggestions: ['Check a defense against wide receivers.', 'Compare two tight end matchups.', 'Show the sample size.'],
  },
  {
    id: 'playoff-planner',
    title: 'Playoff planner',
    category: 'Fantasy',
    description: 'Compare player and team paths across future fantasy playoff weeks.',
    instructions: 'Use schedule and prior-stat tools. State that future opponent strength can change.',
    suggestions: ['Compare Weeks 15 through 17.', 'Find difficult playoff paths.', 'Check outdoor venues.'],
  },
  {
    id: 'boom-bust',
    title: 'Boom and bust',
    category: 'Fantasy',
    description: 'Compare upside, floor, opportunity, and weekly scoring volatility.',
    instructions: 'Use PPR averages, recent volume, and volatility. Do not claim a precise probability without a calibrated model.',
    suggestions: ['Find the safer floor.', 'Compare weekly volatility.', 'Explain the upside case.'],
  },
  {
    id: 'news-briefing',
    title: 'Source-safe briefing',
    category: 'Research',
    description: 'Combine public reporting with Sleeper and nflverse evidence.',
    instructions: 'Use searchCurrentNews for current reporting. Include publisher links and dates. Keep Sleeper and nflverse authoritative for league data and statistics.',
    suggestions: ['Find current player news.', 'Show current injury fields.', 'Compare reporting with recent usage.'],
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

export function parseSkillInvocation(value: string): SebSkillInvocation | null {
  const trimmed = value.trim();
  const parts = [...trimmed.matchAll(/\S+/gu)];
  for (let length = parts.length; length > 0; length -= 1) {
    const skill = findSkill(parts.slice(0, length).map((part) => part[0]).join(' '));
    if (skill) {
      const promptStart = parts[length]?.index;
      return {
        prompt: promptStart === undefined ? '' : trimmed.slice(promptStart),
        skill,
      };
    }
  }
  return null;
}

export function getSkill(id: string): SebSkill {
  return findSkill(id) ?? SEB_SKILLS[0]!;
}

export function formatSkillList(): string {
  const categories: readonly SebSkill['category'][] = [
    'NFL information',
    'Fantasy',
    'Research',
  ];
  return categories.flatMap((category) => [
    `### ${category}`,
    '',
    ...SEB_SKILLS
      .filter((skill) => skill.category === category)
      .map((skill) => `- \`${skill.id}\`: ${skill.description}`),
    '',
  ]).join('\n').trimEnd();
}
