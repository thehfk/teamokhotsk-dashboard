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
  'PL': {
    sector: '위성 / 데이터',
    recommendation: 'buy',
    recReason: 'AI 위성 기술 상용화 + 방위 수요 급증으로 수주잔고 $900M 돌파. 흑자 전환 시점이 핵심 관전 포인트',
    news: [
      { type: 'positive', text: '<strong>AI 궤도 탐지 성공</strong> — 펠리칸-4 위성에서 NVIDIA Jetson으로 실시간 AI 물체 탐지 구현', date: '2026-04-16' },
      { type: 'positive', text: '<strong>Q4 FY2026 어닝 서프라이즈</strong> — 매출 $86.8M (컨센서스 $78.2M 상회), 방위 수주잔고 $900M 돌파', date: '2026-04-02' },
      { type: 'positive', text: '<strong>미 공군 우주 예산 YoY +124%</strong> — 2027 회계연도 우주 분야 예산 대폭 증가, 지구 관측 수요 확대 기대', date: '2026-04-22' },
      { type: 'neutral',  text: '<strong>수익성 개선 과제</strong> — EBIT 마진 -77.6% 유지, 흑자 전환까지 장기 관점 필요. Goldman Sachs 목표가 $20 유지', date: '2026-04-20' }
    ]
  },
  'NVDA': {
    sector: '반도체 / AI',
    recommendation: 'strong-buy',
    recReason: '사상 최고가 재돌파, 시총 $5.1조 달성. 5월 실적 발표 앞두고 블랙웰 공급 확대 기대감 지속',
    news: [
      { type: 'positive', text: '<strong>사상 최고가 재돌파</strong> — 4/24 2025년 10월 이후 첫 신고가 경신, 시가총액 $5.1조로 단독 선두 복귀', date: '2026-04-24' },
      { type: 'positive', text: '<strong>반도체 AI 수요 확인</strong> — Intel 데이터센터 +22% 실적 호조로 AI 칩 수요 증가 전망 상향', date: '2026-04-24' },
      { type: 'neutral',  text: '<strong>5월 20일 실적 발표 예정</strong> — 블랙웰 GPU 공급 현황·마진 가이던스 주목, 단기 차익 실현 매물 경계', date: '2026-04-25' }
    ]
  },
  'NKE': {
    sector: '스포츠 의류 / 소비재',
    recommendation: 'hold',
    recReason: "'Win Now' 구조조정으로 비용 절감 중이나 중국 매출 -20% 전망·Converse -35% 등 단기 실적 회복 불확실. 2027년 2월 분기부터 매출 성장 재개 예상",
    news: [
      { type: 'negative', text: '<strong>2차 인력 감축 단행</strong> — 기술 부서 중심 1,400명(전체 2%) 추가 감원, Win Now 턴어라운드 전략 가속화', date: '2026-04-15' },
      { type: 'negative', text: '<strong>중국 매출 -20% 전망</strong> — 현 분기 중국 추가 급락, Converse YoY -35% 지속. JPMorgan 등 복수 증권사 하향 조정', date: '2026-04-10' },
      { type: 'neutral',  text: '<strong>혁신 총괄 임원 교체</strong> — Tony Bignell 퇴임·Andy Caine 선임, 제품 혁신 방향 재정비 중', date: '2026-04-08' },
      { type: 'neutral',  text: '<strong>52주 최저가 근접</strong> — 현재 $44.69, 52주 저점 $42.09 근접. 밸류에이션 매력 vs 실적 불확실성 사이 관망세', date: '2026-04-24' }
    ]
  },
  'GOOGL': {
    sector: '빅테크 / 클라우드',
    recommendation: 'buy',
    recReason: 'Anthropic $400억 투자·Wiz 인수 완료로 AI 클라우드 경쟁력 강화. 4/29 실적 발표가 단기 방향성 결정',
    news: [
      { type: 'positive', text: '<strong>Anthropic $400억 투자 확정</strong> — Google Cloud를 주요 인프라로 지정, AI 클라우드 수요 직접 수혜 기대', date: '2026-04-23' },
      { type: 'positive', text: '<strong>Wiz 인수 완료</strong> — 클라우드 보안 강자 Wiz 인수로 AI 보안 포트폴리오 강화', date: '2026-04-23' },
      { type: 'neutral',  text: '<strong>4월 29일 1분기 실적 발표</strong> — AI 투자 ROI·광고 매출 성장률·Google Cloud 가속 여부 주목', date: '2026-04-22' }
    ]
  }
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
        const liveNews = isExited ? [] : fetchNewsRSS(s.ticker);
        return {
          ticker:         s.ticker,
          name:           s.name,
          sector:         meta.sector         || '',
          buyPrice:       Math.round(avgBuy * 100) / 100,
          currentPrice:   s.currentPrice,
          livePrice:      s.livePrice || s.currentPrice,
          exitDate:       s.exitDate || '',
          recommendation: meta.recommendation || 'hold',
          recReason:      meta.recReason      || '',
          news:           isExited ? [] : (liveNews.length ? liveNews : (meta.news || []))
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
  return { seasons, members, updatedAt: new Date().toISOString() };
}

// ── 유틸 ────────────────────────────────────────────────────
function parseTicker(raw) {
  // "NYSE:pl" → "PL",  "NASDAQ:NVDA" → "NVDA",  "GOOGL" → "GOOGL"
  const parts = String(raw).split(':');
  return parts[parts.length - 1].toUpperCase().trim();
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
