import { tool, type JSONValue } from 'ai';
import { z } from 'zod';

import { throwIfRequestAborted } from '../ai/request-signal.js';
import { ResearchDataError } from '../data/research-error.js';
import { normalizePlayerName } from '../identity/normalize.js';
import type { NewsClient } from '../news/client.js';
import { bundleCandidateNewsChecks, type BundledNewsCheck } from '../news/tools.js';
import type { NflverseClient } from '../nflverse/client.js';
import { optimizeRosterLineup, projectLeagueMatchup } from '../projection/matchup.js';
import type { ForecastDiff } from '../projection/player-projection.js';
import { PlayerProjectionService, type ProjectionSnapshotStore } from '../projection/service.js';
import {
  buildFantasyLeagueActionCenter,
  type FantasyLeagueAction,
} from '../sleeper/action-center.js';
import type { SleeperClient } from '../sleeper/client.js';
import type { SleeperLeague } from '../sleeper/types.js';
import { WaiverAssistantService } from '../waivers/service.js';
import type { RankedWaiverCandidate, WaiverAssistantResult } from '../waivers/ranking.js';
import type { WeatherClient } from '../weather/client.js';

const MAX_PORTFOLIO_LEAGUES = 10;

export interface WeeklyPortfolioBriefRequest {
  leagueId?: string | undefined;
  rosterId?: number | undefined;
  season?: number | undefined;
  username?: string | undefined;
  week?: number | undefined;
}

export interface WeeklyPortfolioBriefDependencies {
  news?: Pick<NewsClient, 'search'> | undefined;
  nflverse: NflverseClient;
  sleeper: SleeperClient;
  snapshotDatabase?: ProjectionSnapshotStore | false | undefined;
  weather: WeatherClient;
}

export interface PortfolioDropCandidate {
  injuryStatus: string | null;
  name: string;
  playerId: string;
  points: number | null;
  position: string | null;
}

export interface PortfolioForecastShift {
  diff: ForecastDiff;
  expectedPoints: number;
  playerName: string;
  position: string;
}

export interface PortfolioMatchupSummary {
  complete: boolean;
  myInProgressPoints: number;
  myProjectedSubtotal: number;
  opponentInProgressPoints: number;
  opponentLabel: string;
  opponentProjectedSubtotal: number;
  opponentRosterId: number;
  winProbability: number | null;
}

export interface PortfolioLeagueBrief {
  actions: FantasyLeagueAction[];
  addsDisabled?: boolean | undefined;
  bestBall?: boolean | undefined;
  error?: string | undefined;
  faabRemaining: number | null;
  forecastShifts: PortfolioForecastShift[];
  leagueId: string;
  leagueName: string;
  lineup: {
    complete: boolean;
    currentProjectedPoints: number;
    missingSlots: string[];
    optimalProjectedPoints: number;
    pointsDelta: number;
    recommendationEligible: boolean;
    recommendedSwaps: Awaited<ReturnType<typeof optimizeRosterLineup>>['recommendedSwaps'];
    warnings: string[];
  } | null;
  lineupError?: string | undefined;
  lineupNote?: string | undefined;
  matchup: PortfolioMatchupSummary | null;
  matchupNote?: string | undefined;
  rawLineup?: Awaited<ReturnType<typeof optimizeRosterLineup>> | undefined;
  rawMatchup?: Awaited<ReturnType<typeof projectLeagueMatchup>> | undefined;
  rawWaivers?: WaiverAssistantResult | undefined;
  rosterId: number | null;
  season: number;
  status: string;
  suggestedDrops: PortfolioDropCandidate[];
  waiverError?: string | undefined;
  waiverMode: 'faab' | 'priority' | 'unknown' | null;
  waiverTargets: Array<{
    adds: number;
    expectedPoints: number | null;
    faabRange: { lower: number; upper: number } | null;
    injuryStatus: string | null;
    name: string;
    needLevel: RankedWaiverCandidate['rosterNeed']['level'];
    playerId: string;
    position: string;
    rank: number;
    team: string | null;
  }>;
  week: number;
}

export interface WeeklyPortfolioBrief {
  bundledNewsChecks: BundledNewsCheck[];
  generatedAt: string;
  leagues: PortfolioLeagueBrief[];
  notes: string[];
  season: number;
  user: { userId: string; username: string } | null;
  week: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function buildWeeklyPortfolioBrief(
  deps: WeeklyPortfolioBriefDependencies,
  request: WeeklyPortfolioBriefRequest,
): Promise<WeeklyPortfolioBrief> {
  throwIfRequestAborted();
  const state = await deps.sleeper.getNflState();
  const defaultSeason = Number(state.league_season ?? state.season);
  const season = request.season ?? (Number.isInteger(defaultSeason) ? defaultSeason : new Date().getUTCFullYear());
  if (!Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new ResearchDataError('The portfolio brief requires a valid NFL season from 1999 through 2100.');
  }
  const rawWeek = state.display_week || state.week || 1;
  const week = request.week ?? Math.min(18, Math.max(1, rawWeek));
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    throw new ResearchDataError('The portfolio brief requires a regular-season or fantasy week from 1 through 18.');
  }

  const trimmedUser = request.username?.trim();
  const userRecord = trimmedUser ? await deps.sleeper.getUser(trimmedUser) : null;
  const user = userRecord
    ? {
        userId: userRecord.user_id,
        username: userRecord.username ?? userRecord.display_name ?? trimmedUser!,
      }
    : null;

  const notes: string[] = [];
  let targetLeagues: SleeperLeague[];
  if (request.leagueId) {
    targetLeagues = [await deps.sleeper.getLeague(request.leagueId)];
  } else if (user) {
    const discovered = await deps.sleeper.getUserLeagues(user.userId, String(season));
    const inSeason = discovered.filter((league) => league.status === 'in_season');
    const pool = inSeason.length > 0 ? inSeason : discovered;
    if (pool.length === 0) {
      throw new ResearchDataError(
        `Sleeper found no ${season} leagues for @${user.username}.`,
      );
    }
    if (pool.length > MAX_PORTFOLIO_LEAGUES) {
      notes.push(
        `Showing the first ${MAX_PORTFOLIO_LEAGUES} of ${pool.length} Sleeper leagues. Pass --league <ID> to inspect another league.`,
      );
    }
    targetLeagues = pool.slice(0, MAX_PORTFOLIO_LEAGUES);
  } else {
    throw new ResearchDataError(
      'No Sleeper account or league roster specified. Connect a Sleeper username or supply a league ID and roster ID.',
    );
  }

  const players = await deps.sleeper.getPlayers();
  throwIfRequestAborted();

  const projectionService = new PlayerProjectionService(
    deps.sleeper,
    deps.nflverse,
    deps.weather,
    undefined,
    deps.snapshotDatabase ?? false,
  );
  const waiverService = new WaiverAssistantService(deps.sleeper, deps.nflverse);

  const leagues = await Promise.all(
    targetLeagues.map(async (league): Promise<PortfolioLeagueBrief> => {
      const leagueSeason = Number(league.season) || season;
      try {
        const [rosters, leagueUsers] = await Promise.all([
          deps.sleeper.getLeagueRosters(league.league_id),
          deps.sleeper.getLeagueUsers(league.league_id).catch(() => []),
        ]);
        const explicitRoster = request.leagueId && request.rosterId !== undefined
          ? rosters.find((candidate) => candidate.roster_id === request.rosterId)
          : undefined;
        if (request.leagueId && request.rosterId !== undefined && !explicitRoster) {
          throw new ResearchDataError(
            `Roster ${request.rosterId} does not exist in league ${league.league_id}.`,
          );
        }
        const ownedRoster = explicitRoster ?? (user
          ? rosters.find(
              (candidate) =>
                candidate.owner_id === user.userId ||
                candidate.co_owners?.includes(user.userId) === true,
            )
          : undefined);
        if (!ownedRoster) {
          return {
            actions: [],
            error: user
              ? `@${user.username} does not own a roster in ${league.name}.`
              : 'Specify a roster ID when running a single-league brief without a Sleeper username.',
            faabRemaining: null,
            forecastShifts: [],
            leagueId: league.league_id,
            leagueName: league.name,
            lineup: null,
            matchup: null,
            rosterId: null,
            season: leagueSeason,
            status: league.status,
            suggestedDrops: [],
            waiverMode: null,
            waiverTargets: [],
            week,
          };
        }

        const isBestBall = Number(league.settings?.best_ball ?? 0) === 1;
        const addsDisabled = Number(league.settings?.disable_adds ?? 0) === 1;

        const actionCenter = buildFantasyLeagueActionCenter({
          league,
          players,
          rosters: [ownedRoster],
          week,
        });

        const explicitHistoricalWindow =
          request.week !== undefined &&
          week > 1 &&
          (leagueSeason < Number(state.season) || (leagueSeason === Number(state.season) && week < state.week));

        const [lineupOutcome, matchupOutcome, waiverOutcome] = await Promise.all([
          isBestBall
            ? Promise.resolve({ ok: true as const, value: undefined })
            : optimizeRosterLineup(deps.sleeper, deps.nflverse, projectionService, {
                leagueId: league.league_id,
                rosterId: ownedRoster.roster_id,
                season: leagueSeason,
                week,
              }).then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => {
                  throwIfRequestAborted();
                  return { error: errorText(error), ok: false as const };
                },
              ),
          projectLeagueMatchup(deps.sleeper, deps.nflverse, projectionService, {
            leagueId: league.league_id,
            rosterId: ownedRoster.roster_id,
            season: leagueSeason,
            week,
          }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => {
              throwIfRequestAborted();
              return { error: errorText(error), ok: false as const };
            },
          ),
          addsDisabled
            ? Promise.resolve({ ok: true as const, value: undefined })
            : waiverService.rankTargets({
                leagueId: league.league_id,
                resultLimit: 3,
                rosterId: ownedRoster.roster_id,
                ...(explicitHistoricalWindow
                  ? { analysisSeason: leagueSeason, throughWeek: week - 1 }
                  : {}),
              }).then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => {
                  throwIfRequestAborted();
                  return { error: errorText(error), ok: false as const };
                },
              ),
        ]);

        const rawLineup = lineupOutcome.ok ? lineupOutcome.value : undefined;
        const rawMatchup = matchupOutcome.ok ? matchupOutcome.value : undefined;
        const rawWaivers = waiverOutcome.ok ? waiverOutcome.value : undefined;

        const activeRosterLimit = (league.roster_positions ?? []).filter(
          (slot) => !['IR', 'RESERVE', 'TAXI'].includes(slot.toUpperCase()),
        ).length;
        const reservedIds = new Set([...(ownedRoster.reserve ?? []), ...(ownedRoster.taxi ?? [])]);
        const activeOwnedCount = (ownedRoster.players ?? []).filter((id) => !reservedIds.has(id)).length;
        const hasOpenRosterSpot = activeRosterLimit > 0 && activeOwnedCount < activeRosterLimit;

        // ponytail: heuristic cap (<= 10.5 projected pts, active non-bye/non-IR) avoids suggesting bye-week or IR studs as drops; upgrade to rest-of-season value model if multi-week ROS rankings are added.
        const suggestedDrops: PortfolioDropCandidate[] =
          rawLineup && !addsDisabled && !hasOpenRosterSpot
            ? [...rawLineup.bench]
                .filter(
                  (entry) =>
                    entry.status === 'projected' &&
                    entry.points !== null &&
                    entry.points <= 10.5 &&
                    !/\b(?:ir|pup)\b/iu.test(entry.injuryStatus ?? ''),
                )
                .sort(
                  (a, b) =>
                    (a.points ?? Infinity) - (b.points ?? Infinity) ||
                    a.name.localeCompare(b.name),
                )
                .slice(0, 2)
                .map((entry) => ({
                  injuryStatus: entry.injuryStatus,
                  name: entry.name,
                  playerId: entry.playerId,
                  points: entry.points,
                  position: entry.position,
                }))
            : [];

        const forecastShifts: PortfolioForecastShift[] = rawLineup
          ? rawLineup.projections
              .flatMap((item): PortfolioForecastShift[] => {
                if (item.status !== 'projected' || !item.projection.forecastDiff) return [];
                const diff = item.projection.forecastDiff;
                const hasInjuryDriver = diff.drivers.some((driver) =>
                  driver.startsWith('Injury status changed'),
                );
                if (Math.abs(diff.deltaExpectedPoints) < 0.5 && !hasInjuryDriver) return [];
                return [{
                  diff,
                  expectedPoints: item.projection.expectedPoints,
                  playerName: item.projection.player.name,
                  position: item.projection.player.position,
                }];
              })
              .sort((a, b) => Math.abs(b.diff.deltaExpectedPoints) - Math.abs(a.diff.deltaExpectedPoints))
              .slice(0, 4)
          : [];

        let matchup: PortfolioMatchupSummary | null = null;
        if (rawMatchup) {
          const mySide = rawMatchup.rosters.find((side) => side.rosterId === ownedRoster.roster_id);
          const oppSide = rawMatchup.rosters.find((side) => side.rosterId !== ownedRoster.roster_id);
          if (mySide && oppSide) {
            const oppRoster = rosters.find((candidate) => candidate.roster_id === oppSide.rosterId);
            const oppUser = oppRoster?.owner_id
              ? leagueUsers.find((candidate) => candidate.user_id === oppRoster.owner_id)
              : undefined;
            const teamName = typeof oppUser?.metadata?.team_name === 'string'
              ? oppUser.metadata.team_name.trim()
              : '';
            const opponentLabel = teamName || oppUser?.display_name?.trim() || `Roster ${oppSide.rosterId}`;
            const firstIsMine = rawMatchup.rosters[0]?.rosterId === ownedRoster.roster_id;
            const winProbability = rawMatchup.winProbability === null
              ? null
              : firstIsMine
                ? rawMatchup.winProbability
                : Math.round((1 - rawMatchup.winProbability) * 1000) / 1000;
            matchup = {
              complete: mySide.complete && oppSide.complete,
              myInProgressPoints: mySide.inProgressPoints,
              myProjectedSubtotal: mySide.projectedSubtotal,
              opponentInProgressPoints: oppSide.inProgressPoints,
              opponentLabel,
              opponentProjectedSubtotal: oppSide.projectedSubtotal,
              opponentRosterId: oppSide.rosterId,
              winProbability,
            };
          }
        }

        const matchupNote = !matchupOutcome.ok
          ? matchupOutcome.error === 'The selected roster has no unique matchup for this week.'
            ? 'No head-to-head matchup this week (bye or points format).'
            : matchupOutcome.error
          : undefined;

        return {
          actions: actionCenter.actions,
          ...(addsDisabled ? { addsDisabled: true } : {}),
          ...(isBestBall ? { bestBall: true } : {}),
          faabRemaining: rawWaivers?.faab.remaining ?? null,
          forecastShifts,
          leagueId: league.league_id,
          leagueName: league.name,
          lineup: rawLineup
            ? {
                complete: rawLineup.complete,
                currentProjectedPoints: rawLineup.currentProjectedPoints,
                missingSlots: rawLineup.missingSlots,
                optimalProjectedPoints: rawLineup.optimalProjectedPoints,
                pointsDelta: rawLineup.pointsDelta,
                recommendationEligible: rawLineup.recommendationEligible,
                recommendedSwaps: rawLineup.recommendedSwaps,
                warnings: rawLineup.warnings,
              }
            : null,
          ...(isBestBall
            ? { lineupNote: 'Best-ball league (optimal starters scored automatically).' }
            : !lineupOutcome.ok
              ? { lineupError: lineupOutcome.error }
              : {}),
          matchup,
          ...(matchupNote ? { matchupNote } : {}),
          ...(rawLineup ? { rawLineup } : {}),
          ...(rawMatchup ? { rawMatchup } : {}),
          ...(rawWaivers ? { rawWaivers } : {}),
          rosterId: ownedRoster.roster_id,
          season: leagueSeason,
          status: league.status,
          suggestedDrops,
          ...(!waiverOutcome.ok ? { waiverError: waiverOutcome.error } : {}),
          waiverMode: rawWaivers?.faab.mode ?? null,
          waiverTargets: (rawWaivers?.targets ?? []).map((target) => ({
            adds: target.demand.adds,
            expectedPoints: target.production?.expectedPoints ?? null,
            faabRange: target.faab ? { lower: target.faab.lower, upper: target.faab.upper } : null,
            injuryStatus: target.player.injuryStatus,
            name: target.player.name,
            needLevel: target.rosterNeed.level,
            playerId: target.player.playerId,
            position: target.player.position,
            rank: target.rank,
            team: target.player.team,
          })),
          week,
        };
      } catch (error) {
        throwIfRequestAborted();
        if (request.leagueId && error instanceof ResearchDataError) throw error;
        return {
          actions: [],
          error: errorText(error),
          faabRemaining: null,
          forecastShifts: [],
          leagueId: league.league_id,
          leagueName: league.name,
          lineup: null,
          matchup: null,
          rosterId: null,
          season: leagueSeason,
          status: league.status,
          suggestedDrops: [],
          waiverMode: null,
          waiverTargets: [],
          week,
        };
      }
    }),
  );

  const primaryNewsCandidates: Array<{ name: string; team?: string | null | undefined }> = [];
  const benchedSwapCandidates: Array<{ name: string; team?: string | null | undefined }> = [];
  for (const league of leagues) {
    const teamById = new Map<string, string>();
    for (const item of league.rawLineup?.projections ?? []) {
      if (item.status === 'projected' && item.projection.player.team) {
        teamById.set(item.projection.player.playerId, item.projection.player.team);
      }
    }
    for (const swap of league.lineup?.recommendedSwaps ?? []) {
      primaryNewsCandidates.push({
        name: swap.startPlayer.name,
        team: teamById.get(swap.startPlayer.playerId),
      });
      if (swap.sitPlayer && swap.sitPlayer.playerId !== '0') {
        benchedSwapCandidates.push({
          name: swap.sitPlayer.name,
          team: teamById.get(swap.sitPlayer.playerId),
        });
      }
    }
    for (const starter of league.rawLineup?.optimalLineup ?? []) {
      if (starter.injuryStatus) {
        primaryNewsCandidates.push({
          name: starter.name,
          team: teamById.get(starter.playerId),
        });
      }
    }
    const topWaiver = league.waiverTargets[0];
    if (topWaiver) {
      primaryNewsCandidates.push({ name: topWaiver.name, team: topWaiver.team });
    }
  }
  const newsCandidates = [...primaryNewsCandidates, ...benchedSwapCandidates];
  if (newsCandidates.length === 0) {
    const fallbackStarter = leagues[0]?.rawLineup?.optimalLineup[0];
    if (fallbackStarter) newsCandidates.push({ name: fallbackStarter.name });
  }

  const maxNewsCandidates = Math.min(20, Math.max(8, leagues.length * 4));
  const bundledNewsChecks = deps.news
    ? await bundleCandidateNewsChecks(deps.news, newsCandidates, maxNewsCandidates)
    : [];

  return {
    bundledNewsChecks,
    generatedAt: new Date().toISOString(),
    leagues,
    notes,
    season,
    user,
    week,
  };
}

export function stripPortfolioBriefRawData(brief: WeeklyPortfolioBrief) {
  return {
    ...brief,
    leagues: brief.leagues.map(
      ({ rawLineup: _rawLineup, rawMatchup: _rawMatchup, rawWaivers: _rawWaivers, ...rest }) => rest,
    ),
  };
}

export function formatWeeklyPortfolioBrief(brief: WeeklyPortfolioBrief): string {
  const accountLabel = brief.user ? ` · @${brief.user.username}` : '';
  const lines: string[] = [
    `## Seb Weekly Brief · ${brief.season} Week ${brief.week}${accountLabel}`,
    '',
  ];
  for (const note of brief.notes) {
    lines.push(`> ${note}`, '');
  }

  for (const league of brief.leagues) {
    const rosterBadge = league.rosterId !== null ? ` · Roster ${league.rosterId}` : '';
    lines.push(`### ${league.leagueName} (\`${league.leagueId}\`${rosterBadge})`, '');
    if (league.error) {
      lines.push(`- ${league.error}`, '');
      continue;
    }

    if (league.matchup) {
      const winText = league.matchup.winProbability !== null
        ? ` · Win probability: ${Math.round(league.matchup.winProbability * 100)}%`
        : ' · Partial subtotal';
      const inProgressText =
        league.matchup.myInProgressPoints > 0 || league.matchup.opponentInProgressPoints > 0
          ? ` · Live in-progress: ${league.matchup.myInProgressPoints.toFixed(2)} vs. ${league.matchup.opponentInProgressPoints.toFixed(2)}`
          : '';
      lines.push(
        `- **Matchup**: ${league.matchup.myProjectedSubtotal.toFixed(2)} vs. ${league.matchup.opponentLabel} (${league.matchup.opponentProjectedSubtotal.toFixed(2)})${winText}${inProgressText}`,
      );
    } else if (league.matchupNote) {
      lines.push(`- **Matchup**: ${league.matchupNote}`);
    }

    if (league.lineup) {
      if (league.lineup.recommendedSwaps.length === 0) {
        lines.push(
          `- **Lineup**: Optimal starters already set (${league.lineup.optimalProjectedPoints.toFixed(2)} pts${league.lineup.complete ? '' : ', partial'})`,
        );
      } else {
        lines.push(
          `- **Lineup optimization**: ${league.lineup.currentProjectedPoints.toFixed(2)} -> ${league.lineup.optimalProjectedPoints.toFixed(2)} pts (+${league.lineup.pointsDelta.toFixed(2)})`,
        );
        for (const swap of league.lineup.recommendedSwaps) {
          const sitLabel = swap.sitPlayer
            ? `${swap.sitPlayer.name} (${swap.sitPlayer.points?.toFixed(2) ?? 'n/a'})`
            : 'Empty Slot';
          lines.push(
            `  - \`${swap.slot}\`: Start **${swap.startPlayer.name}** (${swap.startPlayer.points.toFixed(2)}) over ${sitLabel} (+${swap.pointsGain.toFixed(2)} pts)`,
          );
        }
      }
      for (const warning of league.lineup.warnings.slice(0, 3)) {
        lines.push(`  - Alert: ${warning}`);
      }
    } else if (league.lineupNote) {
      lines.push(`- **Lineup**: ${league.lineupNote}`);
    } else if (league.lineupError) {
      lines.push(`- **Lineup**: ${league.lineupError}`);
    }

    const hasLineupWarnings = (league.lineup?.warnings.length ?? 0) > 0;
    const urgentActions = league.actions.filter(
      (action) =>
        action.urgency !== 'low' &&
        !(hasLineupWarnings && action.kind === 'player-status'),
    );
    for (const action of urgentActions.slice(0, 3)) {
      lines.push(`- **Action (${action.urgency})**: ${action.title} — ${action.details}`);
    }

    if (league.waiverTargets.length > 0) {
      const dropText = league.suggestedDrops.length > 0
        ? ` · Suggested drop: ${league.suggestedDrops
            .map((drop) => `${drop.name} (${drop.points !== null ? `${drop.points.toFixed(1)} pts` : (drop.position ?? 'bench')})`)
            .join(' or ')}`
        : '';
      lines.push(`- **Top waiver claims**${dropText}:`);
      for (const target of league.waiverTargets) {
        const pts = target.expectedPoints !== null ? `${target.expectedPoints.toFixed(1)} est pts/g` : 'no weekly baseline';
        const faab = target.faabRange
          ? target.faabRange.lower === target.faabRange.upper
            ? ` · FAAB $${target.faabRange.lower}`
            : ` · FAAB $${target.faabRange.lower}–$${target.faabRange.upper}`
          : '';
        lines.push(
          `  - #${target.rank} **${target.name}** (${target.position}, ${target.team ?? 'FA'}) — ${pts}, ${target.needLevel} need${faab}`,
        );
      }
    } else if (league.addsDisabled) {
      lines.push('- **Waivers**: Roster additions disabled in league settings.');
    } else if (league.waiverError) {
      lines.push(`- **Waivers**: ${league.waiverError}`);
    }

    if (league.forecastShifts.length > 0) {
      lines.push('- **Forecast shifts since last check**:');
      for (const shift of league.forecastShifts) {
        const sign = shift.diff.deltaExpectedPoints >= 0 ? '+' : '';
        lines.push(
          `  - **${shift.playerName}** (${shift.position}): ${sign}${shift.diff.deltaExpectedPoints.toFixed(2)} pts (now ${shift.expectedPoints.toFixed(2)}) — ${shift.diff.drivers.join('; ')}`,
        );
      }
    }

    lines.push('');
  }

  const freshArticles = brief.bundledNewsChecks.flatMap((check) => {
    const normalizedSubject = normalizePlayerName(check.playerName);
    return check.articles
      .filter((article) => {
        if (article.stale) return false;
        if (!normalizedSubject) return true;
        const haystack = normalizePlayerName(`${article.title} ${article.excerpt ?? ''}`);
        return ` ${haystack} `.includes(` ${normalizedSubject} `);
      })
      .slice(0, 2)
      .map((article) => ({ ...article, playerName: check.playerName }));
  });
  if (freshArticles.length > 0) {
    const seenUrls = new Set<string>();
    lines.push('### Newsroom Wire', '');
    for (const article of freshArticles) {
      if (seenUrls.has(article.url)) continue;
      seenUrls.add(article.url);
      lines.push(
        `- **${article.playerName}**: ${article.title} (${article.publisherLabel}, ${article.publishedAt.slice(0, 10)})`,
      );
      if (seenUrls.size >= 8) break;
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function createPortfolioBriefTools(
  deps: WeeklyPortfolioBriefDependencies,
  defaultUsername?: () => string | null | undefined,
) {
  return {
    runWeeklyPortfolioBrief: tool({
      description:
        'Run a complete weekly autopilot brief across all active Sleeper leagues (or one focused league) in one call. Combines action-center alerts, exact lineup optimization, suggested bench drops, head-to-head matchup win odds, top waiver/FAAB claims, forecast shifts, and deduplicated first-class newsroom checks.',
      inputSchema: z.object({
        username: z.string().trim().min(1).max(80).optional(),
        leagueId: z.string().trim().regex(/^\d+$/).optional(),
        rosterId: z.number().int().positive().optional(),
        season: z.number().int().min(1999).max(2100).optional(),
        week: z.number().int().min(1).max(18).optional(),
      }),
      execute: async (input) => {
        const fallbackUser = defaultUsername?.()?.trim();
        return buildWeeklyPortfolioBrief(deps, {
          ...(input.leagueId ? { leagueId: input.leagueId } : {}),
          ...(input.rosterId !== undefined ? { rosterId: input.rosterId } : {}),
          ...(input.season !== undefined ? { season: input.season } : {}),
          ...(input.username
            ? { username: input.username }
            : fallbackUser
              ? { username: fallbackUser }
              : {}),
          ...(input.week !== undefined ? { week: input.week } : {}),
        });
      },
      toModelOutput: ({ output }) => ({
        type: 'json',
        value: stripPortfolioBriefRawData(output) as unknown as JSONValue,
      }),
    }),
  };
}
