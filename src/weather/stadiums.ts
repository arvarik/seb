export interface StadiumLocation {
  latitude: number;
  longitude: number;
  name: string;
  team: string;
}

const stadiums: readonly StadiumLocation[] = [
  { team: 'ARI', name: 'State Farm Stadium', latitude: 33.5276, longitude: -112.2626 },
  { team: 'ATL', name: 'Mercedes-Benz Stadium', latitude: 33.7553, longitude: -84.4006 },
  { team: 'BAL', name: 'M&T Bank Stadium', latitude: 39.278, longitude: -76.6227 },
  { team: 'BUF', name: 'Highmark Stadium', latitude: 42.7738, longitude: -78.7868 },
  { team: 'CAR', name: 'Bank of America Stadium', latitude: 35.2258, longitude: -80.8528 },
  { team: 'CHI', name: 'Soldier Field', latitude: 41.8623, longitude: -87.6167 },
  { team: 'CIN', name: 'Paycor Stadium', latitude: 39.0955, longitude: -84.5161 },
  { team: 'CLE', name: 'Huntington Bank Field', latitude: 41.5061, longitude: -81.6995 },
  { team: 'DAL', name: 'AT&T Stadium', latitude: 32.7473, longitude: -97.0945 },
  { team: 'DEN', name: 'Empower Field at Mile High', latitude: 39.7439, longitude: -105.0201 },
  { team: 'DET', name: 'Ford Field', latitude: 42.34, longitude: -83.0456 },
  { team: 'GB', name: 'Lambeau Field', latitude: 44.5013, longitude: -88.0622 },
  { team: 'HOU', name: 'NRG Stadium', latitude: 29.6847, longitude: -95.4107 },
  { team: 'IND', name: 'Lucas Oil Stadium', latitude: 39.7601, longitude: -86.1639 },
  { team: 'JAX', name: 'EverBank Stadium', latitude: 30.3239, longitude: -81.6373 },
  { team: 'KC', name: 'GEHA Field at Arrowhead Stadium', latitude: 39.0489, longitude: -94.4839 },
  { team: 'LV', name: 'Allegiant Stadium', latitude: 36.0908, longitude: -115.183 },
  { team: 'LAC', name: 'SoFi Stadium', latitude: 33.9535, longitude: -118.3392 },
  { team: 'LA', name: 'SoFi Stadium', latitude: 33.9535, longitude: -118.3392 },
  { team: 'MIA', name: 'Hard Rock Stadium', latitude: 25.958, longitude: -80.2389 },
  { team: 'MIN', name: 'U.S. Bank Stadium', latitude: 44.9736, longitude: -93.2575 },
  { team: 'NE', name: 'Gillette Stadium', latitude: 42.0909, longitude: -71.2643 },
  { team: 'NO', name: 'Caesars Superdome', latitude: 29.9511, longitude: -90.0812 },
  { team: 'NYG', name: 'MetLife Stadium', latitude: 40.8135, longitude: -74.0745 },
  { team: 'NYJ', name: 'MetLife Stadium', latitude: 40.8135, longitude: -74.0745 },
  { team: 'PHI', name: 'Lincoln Financial Field', latitude: 39.9008, longitude: -75.1675 },
  { team: 'PIT', name: 'Acrisure Stadium', latitude: 40.4468, longitude: -80.0158 },
  { team: 'SEA', name: 'Lumen Field', latitude: 47.5952, longitude: -122.3316 },
  { team: 'SF', name: "Levi's Stadium", latitude: 37.403, longitude: -121.9698 },
  { team: 'TB', name: 'Raymond James Stadium', latitude: 27.9759, longitude: -82.5033 },
  { team: 'TEN', name: 'Nissan Stadium', latitude: 36.1665, longitude: -86.7713 },
  { team: 'WAS', name: 'Northwest Stadium', latitude: 38.9077, longitude: -76.8645 },
];

const aliases: Readonly<Record<string, string>> = {
  ARZ: 'ARI',
  BLT: 'BAL',
  CLV: 'CLE',
  HST: 'HOU',
  JAC: 'JAX',
  LA: 'LA',
  LAR: 'LA',
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LA',
  WSH: 'WAS',
};

export function findHomeStadium(team: string): StadiumLocation | null {
  const normalized = team.trim().toUpperCase();
  const canonical = aliases[normalized] ?? normalized;
  return stadiums.find((stadium) => stadium.team === canonical) ?? null;
}

export function listHomeStadiums(): readonly StadiumLocation[] {
  return stadiums;
}
