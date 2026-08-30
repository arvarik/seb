import type { NewsSourceDefinition } from './types.js';

interface TeamNewsSite {
  code: string;
  domain: string;
  label: string;
}

const TEAM_NEWS_SITES: readonly TeamNewsSite[] = [
  { code: 'ARI', domain: 'www.azcardinals.com', label: 'Arizona Cardinals' },
  { code: 'ATL', domain: 'www.atlantafalcons.com', label: 'Atlanta Falcons' },
  { code: 'BAL', domain: 'www.baltimoreravens.com', label: 'Baltimore Ravens' },
  { code: 'BUF', domain: 'www.buffalobills.com', label: 'Buffalo Bills' },
  { code: 'CAR', domain: 'www.panthers.com', label: 'Carolina Panthers' },
  { code: 'CHI', domain: 'www.chicagobears.com', label: 'Chicago Bears' },
  { code: 'CIN', domain: 'www.bengals.com', label: 'Cincinnati Bengals' },
  { code: 'CLE', domain: 'www.clevelandbrowns.com', label: 'Cleveland Browns' },
  { code: 'DAL', domain: 'www.dallascowboys.com', label: 'Dallas Cowboys' },
  { code: 'DEN', domain: 'www.denverbroncos.com', label: 'Denver Broncos' },
  { code: 'DET', domain: 'www.detroitlions.com', label: 'Detroit Lions' },
  { code: 'GB', domain: 'www.packers.com', label: 'Green Bay Packers' },
  { code: 'HOU', domain: 'www.houstontexans.com', label: 'Houston Texans' },
  { code: 'IND', domain: 'www.colts.com', label: 'Indianapolis Colts' },
  { code: 'JAX', domain: 'www.jaguars.com', label: 'Jacksonville Jaguars' },
  { code: 'KC', domain: 'www.chiefs.com', label: 'Kansas City Chiefs' },
  { code: 'LV', domain: 'www.raiders.com', label: 'Las Vegas Raiders' },
  { code: 'LAC', domain: 'www.chargers.com', label: 'Los Angeles Chargers' },
  { code: 'LAR', domain: 'www.therams.com', label: 'Los Angeles Rams' },
  { code: 'MIA', domain: 'www.miamidolphins.com', label: 'Miami Dolphins' },
  { code: 'MIN', domain: 'www.vikings.com', label: 'Minnesota Vikings' },
  { code: 'NE', domain: 'www.patriots.com', label: 'New England Patriots' },
  { code: 'NO', domain: 'www.neworleanssaints.com', label: 'New Orleans Saints' },
  { code: 'NYG', domain: 'www.giants.com', label: 'New York Giants' },
  { code: 'NYJ', domain: 'www.newyorkjets.com', label: 'New York Jets' },
  { code: 'PHI', domain: 'www.philadelphiaeagles.com', label: 'Philadelphia Eagles' },
  { code: 'PIT', domain: 'www.steelers.com', label: 'Pittsburgh Steelers' },
  { code: 'SF', domain: 'www.49ers.com', label: 'San Francisco 49ers' },
  { code: 'SEA', domain: 'www.seahawks.com', label: 'Seattle Seahawks' },
  { code: 'TB', domain: 'www.buccaneers.com', label: 'Tampa Bay Buccaneers' },
  { code: 'TEN', domain: 'www.tennesseetitans.com', label: 'Tennessee Titans' },
  { code: 'WAS', domain: 'www.commanders.com', label: 'Washington Commanders' },
];

const GENERAL_NEWS_SOURCES: readonly NewsSourceDefinition[] = [
  {
    category: 'official',
    discoveryKind: 'news-sitemap',
    discoveryUrl: 'https://www.nfl.com/sitemap-fast-changing.xml',
    enrichArticles: true,
    enrichDatedArticles: true,
    homepageUrl: 'https://www.nfl.com/news/',
    id: 'nfl',
    label: 'NFL News',
    urlPathPrefix: '/news/',
  },
  {
    activationTerms: [
      'concussion',
      'health',
      'helmet',
      'medical',
      'player safety',
      'safety protocol',
    ],
    category: 'official',
    discoveryKind: 'html',
    discoveryUrl:
      'https://www.nfl.com/playerhealthandsafety/resources/press-releases/',
    enrichArticles: true,
    enrichDatedArticles: true,
    homepageUrl:
      'https://www.nfl.com/playerhealthandsafety/resources/press-releases/',
    htmlFlavor: 'nfl-player-health',
    id: 'nfl-player-health',
    label: 'NFL Player Health and Safety',
    urlPathPrefix: '/playerhealthandsafety/',
  },
  {
    category: 'independent',
    discoveryKind: 'html',
    discoveryUrl: 'https://apnews.com/hub/nfl',
    enrichArticles: true,
    homepageUrl: 'https://apnews.com/hub/nfl',
    htmlFlavor: 'ap-nfl-hub',
    id: 'ap-nfl',
    label: 'Associated Press NFL',
    urlPathPrefix: '/article/',
  },
  {
    category: 'independent',
    discoveryKind: 'rss',
    discoveryUrl: 'https://www.espn.com/espn/rss/nfl/news',
    homepageUrl: 'https://www.espn.com/nfl/',
    id: 'espn-nfl',
    label: 'ESPN NFL',
  },
  {
    category: 'independent',
    discoveryKind: 'rss',
    discoveryUrl: 'https://www.cbssports.com/rss/headlines/nfl/',
    homepageUrl: 'https://www.cbssports.com/nfl/',
    id: 'cbs-nfl',
    label: 'CBS Sports NFL',
  },
  {
    category: 'independent',
    discoveryKind: 'rss',
    discoveryUrl: 'https://www.nbcsports.com/profootballtalk.rss',
    homepageUrl: 'https://www.nbcsports.com/nfl/profootballtalk',
    id: 'profootballtalk',
    label: 'NBC ProFootballTalk',
  },
  {
    category: 'independent',
    discoveryKind: 'news-sitemap',
    discoveryUrl: 'https://www.foxsports.com/sitemap.xml?type=news',
    homepageUrl: 'https://www.foxsports.com/nfl',
    id: 'fox-nfl',
    label: 'FOX Sports NFL',
    urlPathPrefix: '/stories/nfl/',
  },
  {
    category: 'independent',
    discoveryKind: 'rss',
    discoveryUrl: 'https://sports.yahoo.com/nfl/rss/',
    homepageUrl: 'https://sports.yahoo.com/nfl/',
    id: 'yahoo-nfl',
    label: 'Yahoo Sports NFL',
  },
  {
    category: 'fantasy',
    discoveryKind: 'html',
    discoveryUrl: 'https://www.nbcsports.com/fantasy/football/player-news',
    homepageUrl: 'https://www.nbcsports.com/fantasy/football/player-news',
    htmlFlavor: 'rotoworld-player',
    id: 'rotoworld-player-news',
    label: 'NBC Rotoworld Player News',
    urlPathPrefix: '/fantasy/football/player-news/',
  },
  {
    category: 'fantasy',
    discoveryKind: 'html',
    discoveryUrl: 'https://www.fantasypros.com/nfl/player-news.php',
    homepageUrl: 'https://www.fantasypros.com/nfl/player-news.php',
    htmlFlavor: 'fantasypros-player',
    id: 'fantasypros-player-news',
    label: 'FantasyPros Player News',
    urlPathPrefix: '/nfl/news/',
  },
  {
    category: 'fantasy',
    discoveryKind: 'rss',
    discoveryUrl: 'https://www.pff.com/feed',
    homepageUrl: 'https://www.pff.com/news/fantasy-football',
    id: 'pff',
    label: 'PFF Fantasy News',
  },
];

const TEAM_NEWS_SOURCES: readonly NewsSourceDefinition[] = TEAM_NEWS_SITES.map(
  ({ code, domain, label }) => ({
    category: 'official',
    discoveryKind: code === 'WAS' ? 'news-sitemap' : 'rss',
    discoveryUrl: code === 'WAS'
      ? `https://${domain}/sitemap-fast-changing.xml`
      : `https://${domain}/rss/news`,
    ...(code === 'WAS'
      ? { enrichArticles: true, enrichDatedArticles: true }
      : {}),
    ...(code === 'GB'
      ? { excludedPathPrefixes: ['/news/insider-inbox'] }
      : {}),
    homepageUrl: `https://${domain}/news/`,
    id: `team-${code.toLowerCase()}`,
    label: `${label} News`,
    team: code,
    urlPathPrefix: '/news/',
  }),
);

const FANTASYPROS_TEAM_SOURCE: NewsSourceDefinition = {
  category: 'fantasy',
  discoveryKind: 'html',
  discoveryUrl: 'https://www.fantasypros.com/nfl/team-news.php',
  homepageUrl: 'https://www.fantasypros.com/nfl/team-news.php',
  htmlFlavor: 'fantasypros-team',
  id: 'fantasypros-team-news',
  label: 'FantasyPros Team News',
  urlPathPrefix: '/nfl/news/',
};

export const FIRST_CLASS_NEWS_SOURCES: readonly NewsSourceDefinition[] =
  Object.freeze([
    ...GENERAL_NEWS_SOURCES,
    ...TEAM_NEWS_SOURCES,
    FANTASYPROS_TEAM_SOURCE,
  ].map((source) => Object.freeze({ ...source })));

export function findNewsSource(id: string): NewsSourceDefinition | undefined {
  return FIRST_CLASS_NEWS_SOURCES.find((source) => source.id === id);
}

export function listTeamNewsSites(): Array<{
  code: string;
  label: string;
  url: string;
}> {
  return TEAM_NEWS_SITES.map(({ code, domain, label }) => ({
    code,
    label,
    url: `https://${domain}/news/`,
  }));
}
