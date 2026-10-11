export const SPORTS_TAGS = [
  'Sports', 'Basketball', 'Football', 'Baseball', 'Hockey',
  'Soccer', 'Tennis', 'Golf', 'MMA', 'Cricket', 'Formula 1', 'Boxing',
];

export const SPORTS_KEYWORDS: Record<string, string[]> = {
  NBA: ['nba', 'lakers', 'celtics', 'heat', 'warriors', 'bucks', 'suns', 'nuggets', 'nets', 'knicks',
        '76ers', 'sixers', 'mavericks', 'mavs', 'clippers', 'rockets', 'bulls', 'hawks', 'pacers',
        'cavaliers', 'cavs', 'thunder', 'timberwolves', 'pelicans', 'pistons', 'raptors', 'magic',
        'spurs', 'grizzlies', 'kings', 'blazers', 'hornets', 'wizards', 'jazz'],
  NFL: ['nfl', 'chiefs', 'eagles', 'bills', 'cowboys', 'ravens', '49ers', 'niners', 'dolphins',
        'lions', 'jets', 'bengals', 'patriots', 'packers', 'chargers', 'seahawks', 'steelers',
        'jaguars', 'texans', 'broncos', 'vikings', 'bears', 'browns', 'saints', 'colts',
        'titans', 'rams', 'falcons', 'cardinals', 'commanders', 'panthers', 'buccaneers',
        'super bowl', 'nfl draft', 'nfl mvp'],
  MLB: ['mlb', 'yankees', 'dodgers', 'astros', 'braves', 'mets', 'phillies', 'cubs', 'red sox',
        'padres', 'guardians', 'orioles', 'mariners', 'rangers', 'rays', 'twins', 'brewers',
        'giants', 'cardinals', 'reds', 'blue jays', 'white sox', 'pirates', 'diamondbacks',
        'angels', 'tigers', 'royals', 'rockies', 'nationals', 'marlins', 'athletics',
        'world series', 'home run'],
  NHL: ['nhl', 'stanley cup', 'maple leafs', 'bruins', 'oilers', 'panthers', 'rangers',
        'avalanche', 'hurricanes', 'stars', 'flames', 'lightning', 'penguins', 'capitals',
        'red wings', 'kraken', 'canucks', 'wild', 'islanders', 'senators', 'devils',
        'blackhawks', 'predators', 'blues', 'sabres', 'coyotes', 'sharks', 'ducks', 'jets'],
  UFC: ['ufc', 'mma', 'dana white', 'octagon'],
  Soccer: ['premier league', 'champions league', 'la liga', 'bundesliga', 'serie a', 'ligue 1',
           'world cup', 'euro cup', 'mls', 'manchester', 'liverpool', 'arsenal', 'chelsea',
           'barcelona', 'real madrid', 'bayern', 'psg', 'juventus', 'inter milan', 'ac milan'],
  Tennis: ['tennis', 'wimbledon', 'us open tennis', 'french open', 'australian open',
           'atp', 'wta', 'grand slam'],
  F1: ['formula 1', 'f1', 'grand prix', 'verstappen', 'hamilton', 'leclerc', 'norris'],
  Golf: ['golf', 'pga', 'masters', 'the open', 'us open golf', 'ryder cup'],
  Cricket: ['cricket', 'ipl', 'ashes', 'world cup cricket', 't20', 'test match'],
  Boxing: ['boxing', 'heavyweight', 'middleweight', 'welterweight', 'lightweight'],
};

export const LEAGUE_PATTERNS: Record<string, Record<string, string>> = {
  NBA: { 'nba finals': 'NBA Finals', 'nba playoffs': 'NBA Playoffs', 'nba mvp': 'NBA MVP', 'all-star': 'All-Star' },
  NFL: { 'super bowl': 'Super Bowl', 'nfl playoffs': 'NFL Playoffs', 'nfl draft': 'NFL Draft', 'nfl mvp': 'NFL MVP' },
  MLB: { 'world series': 'World Series', 'mlb playoffs': 'MLB Playoffs' },
  NHL: { 'stanley cup': 'Stanley Cup', 'nhl playoffs': 'NHL Playoffs' },
  Soccer: { 'premier league': 'Premier League', 'champions league': 'Champions League', 'la liga': 'La Liga',
            'bundesliga': 'Bundesliga', 'serie a': 'Serie A', 'world cup': 'World Cup', 'euro': 'Euros', 'mls': 'MLS' },
  Tennis: { 'wimbledon': 'Wimbledon', 'us open': 'US Open', 'french open': 'French Open', 'australian open': 'Australian Open' },
  F1: { 'grand prix': 'Grand Prix', 'world championship': 'F1 Championship' },
  Golf: { 'masters': 'The Masters', 'pga championship': 'PGA Championship', 'us open': 'US Open', 'the open': 'The Open' },
};

export const TAG_TO_SPORT: Record<string, string> = {
  'basketball': 'NBA',
  'football': 'NFL',
  'baseball': 'MLB',
  'hockey': 'NHL',
  'soccer': 'Soccer',
  'tennis': 'Tennis',
  'golf': 'Golf',
  'mma': 'UFC',
  'cricket': 'Cricket',
  'formula 1': 'F1',
  'boxing': 'Boxing',
};

export const TITLE_BLACKLIST = [
  'election', 'political', 'president', 'congress', 'senate',
  'stock', 'crypto', 'bitcoin', 'ethereum', 'weather', 'temperature',
];
