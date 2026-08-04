// ============================================================
// 팀오호츠크 투자 대쉬보드 — Google Apps Script 백엔드
//
// 시트 → JSON 변환만 담당. 시장 지수·RSI·뉴스는 GitHub Actions가
// 30분마다 갱신하는 data/data.json에서 프론트가 별도 로드.
//
// [시트 구조 - 첫 번째 시트] 컬럼 (헤더로 자동 감지)
// 시즌 | 회차 | 이름 | 종목 | 티커 | 기준일 | 평균가 | 수량 | 현재가 [| 청산일 | 실시간가]
//
// ※ 시즌 컬럼이 비어있으면 '26봄' 기본값 사용
// ※ 회차 컬럼이 비어있으면 기준일 기준으로 자동 회차 부여
// 현재가 셀 수식 예시: =IF(J2="", GOOGLEFINANCE(E2,"price"), INDEX(GOOGLEFINANCE(E2,"close",J2),2,2))
// 실시간가 셀 수식 예시: =GOOGLEFINANCE(E2,"price")
//
// [배포 방법]
// 1. Google Sheets → 확장 프로그램 → Apps Script
// 2. 이 코드 붙여넣기
// 3. 배포 관리 → 편집 → 새 버전 → 배포 (URL 유지)
// ============================================================

const SEASON_CONFIG = {
  '26봄': { totalRounds: 4 }
};
const DEFAULT_SEASON    = '26봄';
const DEFAULT_TOTAL_ROUNDS = 4;

// 종목별 섹터 라벨 (하드코딩된 종목에만 표시. 나머지는 빈 문자열)
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
      // rsi와 news는 GitHub Actions가 갱신하는 data/data.json에서 프론트가 주입.
      const stocks = Object.values(stocksRaw).map(s => {
        const meta   = STOCK_META[s.ticker] || {};
        const avgBuy = s.buyPrices.length > 0
          ? s.buyPrices.reduce((a, b) => a + b, 0) / s.buyPrices.length : 0;
        return {
          ticker:       s.ticker,
          name:         s.name,
          sector:       meta.sector || '',
          buyPrice:     Math.round(avgBuy * 100) / 100,
          currentPrice: s.currentPrice,
          livePrice:    s.livePrice || s.currentPrice,
          exitDate:     s.exitDate || ''
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
