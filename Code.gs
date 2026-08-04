// ============================================================
// 팀오호츠크 투자 대쉬보드 — Google Apps Script 백엔드
//
// [시트 구조 - 첫 번째 시트] 9개 컬럼
// 시즌 | 회차 | 이름 | 종목 | 티커 | 기준일 | 평균가 | 수량 | 현재가
//
// ※ 시즌 컬럼이 비어있으면 '26봄' 기본값 사용
// ※ 회차 컬럼이 비어있으면 기준일 기준으로 자동 회차 부여
// 현재가 컬럼 수식 예시: =GOOGLEFINANCE(D2,"price")
// 매수금/평가금/수익금/수익률은 대쉬보드에서 자동 계산
//
// [배포 방법]
// 1. Google Sheets → 확장 프로그램 → Apps Script
// 2. 이 코드 붙여넣기
// 3. 배포 → 새 배포 → 웹 앱 → 액세스: 모든 사용자 → 배포
// 4. URL을 index.html SCRIPT_URL에 입력
// ============================================================

const SEASON_CONFIG = {
  '26봄': { totalRounds: 4 }
};
const DEFAULT_SEASON    = '26봄';
const DEFAULT_TOTAL_ROUNDS = 4;

// 종목별 뉴스 & 추천 의견
const STOCK_META = {
  'PL':    { sector: '위성 / 데이터' },
  'NVDA':  { sector: '반도체 / AI' },
  'NKE':   { sector: '스포츠 의류 / 소비재' },
  'GOOGL': { sector: '빅테크 / 클라우드' }
};

// 멤버 색상 (이름 → hex)
const MEMBER_COLORS = {
  '김재윤': '#6c63ff',
  '김하나': '#ff6584',
  '박지원': '#00d4aa',
  '신선아': '#ffd166',
  '윤다혜': '#ff9f43',
  '이수연': '#74c0fc',
  '이주영': '#a29bfe',
  '정호준': '#fd79a8',
  '조진서': '#55efc4'
};

const COLOR_PALETTE = ['#6c63ff','#ff6584','#00d4aa','#ffd166','#ff9f43','#74c0fc','#a29bfe','#fd79a8','#55efc4'];

// ── 메인 ────────────────────────────────────────────────────
function doGet(e) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets()[0];
    const data  = buildData(sheet);
    return jsonResponse(data);
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── 데이터 빌드 ──────────────────────────────────────────────
function buildData(sheet) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { seasons: [], members: [], updatedAt: new Date().toISOString() };

  // 헤더로 컬럼 구조 자동 감지
  // 9컬럼: 시즌 | 회차 | 이름 | 종목 | 티커 | 기준일 | 평균가 | 수량 | 현재가 [| 청산일]
  // 8컬럼:       회차 | 이름 | 종목 | 티커 | 기준일 | 평균가 | 수량 | 현재가 [| 청산일]
  const header = rows[0].map(h => String(h || '').trim());
  const has시즌 = header[0] === '시즌';
  const C = has시즌
    ? { season:0, round:1, name:2, stock:3, ticker:4, date:5, avg:6, qty:7, cur:8 }
    : { season:-1, round:0, name:1, stock:2, ticker:3, date:4, avg:5, qty:6, cur:7 };
  C.exit = header.indexOf('청산일');
  C.live = header.indexOf('실시간가');

  function col(row, idx) { return idx >= 0 ? row[idx] : undefined; }

  // 시즌별 (날짜→회차) 매핑 수집
  const seasonDateToRound = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name    = String(col(r, C.name) || '').trim();
    if (!name) continue;
    const seasonId = String(col(r, C.season) || '').trim() || DEFAULT_SEASON;
    const roundId  = parseInt(col(r, C.round)) || 0;
    const dateStr  = parseDate(col(r, C.date));
    const key = seasonId + '|' + dateStr;
    if (roundId > 0 && dateStr && !seasonDateToRound[key]) seasonDateToRound[key] = roundId;
  }

  // 날짜만 있고 회차 없는 경우 자동 부여
  const unmapped = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name    = String(col(r, C.name) || '').trim();
    if (!name) continue;
    const seasonId = String(col(r, C.season) || '').trim() || DEFAULT_SEASON;
    const roundId  = parseInt(col(r, C.round)) || 0;
    const dateStr  = parseDate(col(r, C.date));
    const key = seasonId + '|' + dateStr;
    if (roundId < 1 && dateStr && !seasonDateToRound[key]) {
      if (!unmapped[seasonId]) unmapped[seasonId] = [];
      if (!unmapped[seasonId].includes(dateStr)) unmapped[seasonId].push(dateStr);
    }
  }
  Object.entries(unmapped).forEach(([sid, dates]) => {
    dates.sort();
    const existingMax = Object.entries(seasonDateToRound)
      .filter(([k]) => k.startsWith(sid + '|'))
      .reduce((m, [, v]) => Math.max(m, v), 0);
    dates.forEach((d, i) => { seasonDateToRound[sid + '|' + d] = existingMax + i + 1; });
  });

  // 실제 데이터 집계
  const seasonMap = {};
  const memberMap = {};
  let colorIdx = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name      = String(col(r, C.name)   || '').trim();
    const stockName = String(col(r, C.stock)  || '').trim();
    const tickerRaw = String(col(r, C.ticker) || '').trim();
    if (!name || !stockName || !tickerRaw) continue;

    const seasonId = String(col(r, C.season) || '').trim() || DEFAULT_SEASON;
    const dateStr  = parseDate(col(r, C.date));
    const roundId  = parseInt(col(r, C.round)) || seasonDateToRound[seasonId + '|' + dateStr] || 0;
    if (roundId < 1) continue;

    const ticker   = parseTicker(tickerRaw);
    const buyPrice = parseFloat(col(r, C.avg)) || 0;
    const qty      = parseInt(col(r, C.qty))   || 0;
    const curPrice = parseFloat(col(r, C.cur)) || 0;

    if (!seasonMap[seasonId]) seasonMap[seasonId] = { roundMap: {} };
    const rm = seasonMap[seasonId].roundMap;
    if (!rm[roundId]) rm[roundId] = { date: dateStr, stocks: {} };
    if (!rm[roundId].date && dateStr) rm[roundId].date = dateStr;

    const livePrice = C.live >= 0 ? (parseFloat(col(r, C.live)) || 0) : 0;

    if (!rm[roundId].stocks[ticker]) {
      rm[roundId].stocks[ticker] = { ticker, name: String(stockName), currentPrice: curPrice, livePrice: livePrice, buyPrices: [], exitDate: '' };
    } else {
      if (curPrice > 0)  rm[roundId].stocks[ticker].currentPrice = curPrice;
      if (livePrice > 0) rm[roundId].stocks[ticker].livePrice    = livePrice;
    }
    if (buyPrice > 0) rm[roundId].stocks[ticker].buyPrices.push(buyPrice);

    const exitDate = parseDate(col(r, C.exit));
    if (exitDate && !rm[roundId].stocks[ticker].exitDate) {
      rm[roundId].stocks[ticker].exitDate = exitDate;
    }

    const memberName = String(name).trim();
    if (!memberMap[memberName]) {
      memberMap[memberName] = {
        name:  memberName,
        color: MEMBER_COLORS[memberName] || COLOR_PALETTE[colorIdx++ % COLOR_PALETTE.length],
        holdings: []
      };
    }
    if (qty > 0) memberMap[memberName].holdings.push({ season: seasonId, ticker, round: roundId, quantity: qty, buyPrice });
  }

  // 시즌 배열 구성
  const sortedSeasonIds = Object.keys(seasonMap).sort();
  const seasons = sortedSeasonIds.map((seasonId, sIdx) => {
    const seasonStatus = sIdx === sortedSeasonIds.length - 1 ? 'current' : 'done';
    const rm = seasonMap[seasonId].roundMap;
    const sortedRoundIds = Object.keys(rm).map(Number).sort((a, b) => a - b);
    const maxRound = sortedRoundIds.length ? sortedRoundIds[sortedRoundIds.length - 1] : 0;
    const totalRounds = (SEASON_CONFIG[seasonId] || {}).totalRounds || DEFAULT_TOTAL_ROUNDS;

    const rounds = sortedRoundIds.map((roundId, rIdx) => {
      const rStatus = rIdx === sortedRoundIds.length - 1 ? 'current' : 'done';
      const { date, stocks: stocksRaw } = rm[roundId];
      const stocks = Object.values(stocksRaw).map(s => {
        const meta   = STOCK_META[s.ticker] || {};
        const avgBuy = s.buyPrices.length > 0
          ? s.buyPrices.reduce((a, b) => a + b, 0) / s.buyPrices.length : 0;
        const isExited = !!s.exitDate;
        // 뉴스와 RSI 모두 프론트에서 CORS 프록시로 직접 호출 (Apps Script IP는 대부분 외부 데이터 소스에서 차단)
        const rsi      = null;
        return {
          ticker:         s.ticker,
          name:           s.name,
          sector:         meta.sector         || '',
          buyPrice:       Math.round(avgBuy * 100) / 100,
          currentPrice:   s.currentPrice,
          livePrice:      s.livePrice || s.currentPrice,
          exitDate:       s.exitDate || '',
          rsi:            rsi,
          recReason:      meta.recReason      || '',
          news:           []  // 프론트에서 loadNewsAsync가 채움
        };
      });
      return { id: roundId, label: `${roundId}회차`, date, status: rStatus, stocks };
    });

    for (let i = maxRound + 1; i <= totalRounds; i++) {
      rounds.push({ id: i, label: `${i}회차`, date: '', status: 'upcoming', stocks: [] });
    }

    return { id: seasonId, label: seasonId, status: seasonStatus, rounds };
  });

  const members = Object.values(memberMap).map(m => ({ name: m.name, color: m.color, holdings: m.holdings }));
  // 시장 지수는 프론트에서 CORS 프록시로 Yahoo 직접 호출 (Apps Script IP는 Yahoo에서 차단됨)
  return { seasons, members, updatedAt: new Date().toISOString() };
}

// ── 유틸 ────────────────────────────────────────────────────
function parseTicker(raw) {
  // "NYSE:pl" → "PL",  "NASDAQ:NVDA" → "NVDA",  "GOOGL" → "GOOGL"
  const parts = String(raw).split(':');
  return parts[parts.length - 1].toUpperCase().trim();
}

// ── 시장 지수 (Yahoo Finance 3개월 일봉, 10분 캐시) ────────
const MARKET_INDICES = [
  { name: 'KOSPI',       ticker: '^KS11',  group: '한국 시장' },
  { name: 'KOSDAQ',      ticker: '^KQ11',  group: '한국 시장' },
  { name: 'S&P500',      ticker: '^GSPC',  group: '미국 시장' },
  { name: 'NASDAQ',      ticker: '^IXIC',  group: '미국 시장' },
  { name: '다우존스',     ticker: '^DJI',   group: '미국 시장' },
  { name: 'VIX',         ticker: '^VIX',   group: '공포지수' },
  { name: '원달러환율',   ticker: 'KRW=X',  group: '환율 / 금리' },
  { name: '미국10년금리', ticker: '^TNX',   group: '환율 / 금리' }
];

function fetchIndexData(ticker) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'idx_' + ticker;
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);

    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                encodeURIComponent(ticker) + '?range=3mo&interval=1d';
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());
    const result = data.chart.result && data.chart.result[0];
    if (!result) return null;
    const rawCloses = result.indicators.quote[0].close;
    const timestamps = result.timestamp || [];

    const labels = [], series = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = rawCloses[i];
      if (c === null || c === undefined) continue;
      labels.push(Utilities.formatDate(new Date(timestamps[i]*1000), 'Asia/Seoul', 'MM/dd'));
      series.push(Math.round(c * 100) / 100);
    }
    if (series.length < 2) return null;
    const value = series[series.length - 1];
    const prev  = series[series.length - 2];
    const change = ((value - prev) / prev) * 100;
    const out = { value, change: Math.round(change * 100) / 100, labels, series };
    cache.put(key, JSON.stringify(out), 600);
    return out;
  } catch (e) {
    return null;
  }
}

function buildMarket() {
  const cards = [];
  const groupMap = {};
  MARKET_INDICES.forEach(idx => {
    const d = fetchIndexData(idx.ticker);
    if (!d) return;
    cards.push({ name: idx.name, value: d.value, change: d.change });
    if (!groupMap[idx.group]) groupMap[idx.group] = { name: idx.group, labels: d.labels, series: [] };
    groupMap[idx.group].series.push({ name: idx.name, data: d.series });
  });
  return { cards, groups: Object.values(groupMap) };
}

// ── RSI (Yahoo Finance 일봉, 10분 캐시) ──────────────────────
function computeRSI(closes, period) {
  period = period || 14;
  const c = (closes || []).filter(x => x !== null && !isNaN(x));
  if (c.length < period + 1) return null;
  const slice = c.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i-1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function fetchRSI(ticker) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'rsi_' + ticker;
    const hit = cache.get(key);
    if (hit !== null) {
      const v = parseFloat(hit);
      return isNaN(v) ? null : v;
    }
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                encodeURIComponent(ticker) + '?range=1mo&interval=1d';
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());
    const closes = data.chart.result[0].indicators.quote[0].close;
    const rsi = computeRSI(closes);
    cache.put(key, rsi === null ? '' : String(rsi), 600);
    return rsi;
  } catch (e) {
    return null;
  }
}

// ── 실시간 뉴스 (Google News RSS, 30분 캐시) ────────────────
function fetchNewsRSS(ticker) {
  try {
    const cache = CacheService.getScriptCache();
    const key   = 'news_' + ticker;
    const hit   = cache.get(key);
    if (hit) return JSON.parse(hit);

    const url  = 'https://news.google.com/rss/search?q=' + encodeURIComponent(ticker + ' stock') + '&hl=en-US&gl=US&ceid=US:en';
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];

    const xml   = resp.getContentText();
    const doc   = XmlService.parse(xml);
    const items = doc.getRootElement().getChild('channel').getChildren('item').slice(0, 4);

    const news = items.map(item => {
      const rawTitle = item.getChildText('title') || '';
      const link     = item.getChildText('link')  || '';
      const pubDate  = item.getChildText('pubDate') || '';

      // "Title - Source" 분리
      const m = rawTitle.match(/^(.*)\s[-–]\s([^-–]+)$/);
      const title     = (m ? m[1] : rawTitle).trim();
      const publisher = m ? m[2].trim() : '';

      let date = '';
      try {
        date = Utilities.formatDate(new Date(pubDate), 'Asia/Seoul', 'MM/dd HH:mm');
      } catch(e) {}

      const lower = title.toLowerCase();
      let type = 'neutral';
      if (/surge|soar|jump|beat|rise|gain|high|record|strong|growth|profit|up|bull|rally/.test(lower)) type = 'positive';
      if (/fall|drop|plunge|miss|decline|loss|low|down|weak|cut|layoff|warn|concern|risk|sue|fine/.test(lower)) type = 'negative';

      return { type, title, publisher, link, date, text: '<strong>' + title + '</strong>' };
    });

    cache.put(key, JSON.stringify(news), 300);
    return news;
  } catch (e) {
    return [];
  }
}

function parseDate(raw) {
  if (!raw) return '';
  if (raw instanceof Date) {
    return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(raw).trim();
  if (!s) return '';
  // "26/03/23" → "2026-03-23"
  const p = s.split('/');
  if (p.length === 3) {
    const y = parseInt(p[0]) < 100 ? 2000 + parseInt(p[0]) : parseInt(p[0]);
    return `${y}-${p[1].padStart(2,'0')}-${p[2].padStart(2,'0')}`;
  }
  return s;
}
