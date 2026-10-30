// A deterministic parser for forwarded notification text. Financial identities are
// deliberately not inferred from the app that forwarded the notification.
const KOREA_OFFSET = 9 * 60 * 60 * 1000;
const MAX_AMOUNT = 9_000_000_000_000;
const DATE_PATTERN = /(?<!\d)(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})일?(?!\d)/gu;
const SHORT_DATE_PATTERN = /(?<![\d.])(\d{1,2})[/.월]\s*(\d{1,2})일?(?![\d.])/gu;
const TIME_PATTERN = /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/gu;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/gu;
const MONEY_PATTERN = /(?<![\dA-Za-z.,+\-])(?:₩\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\s*원)?|(\d{1,3}(?:,\d{3})+|\d+)\s*원)(?![\dA-Za-z])/gu;
const NON_TRANSACTION_AMOUNT = /잔액|잔고|누적|누계|이용\s*가능|사용\s*가능|출금\s*가능|남은\s*한도|총\s*한도|한도|당월\s*사용|이번\s*달\s*사용|이달\s*사용|총\s*(?:사용|이용|결제)\s*금액|합계|적립|포인트|캐시백|쿠폰|할인|혜택|수수료|부가세/u;
const FAILED = /실패|거절|불가|승인\s*거부|잔액\s*부족|한도\s*초과|정지|오류|아닙니다|아니에요|미승인|미완료|(?:결제|승인|처리)(?:가|이|는)?\s*(?:되지|하지)\s*않/u;
const PENDING = /예정|예약|대기|미결제|처리\s*중|진행\s*중|결제\s*요청|승인\s*요청|인증\s*요청|결제하시|결제하세요|결제해\s*주세요|결제할|승인\s*전|결제\s*전|사전\s*승인|가승인|보류/u;
const MARKETING = /광고|이벤트|프로모션|쿠폰|혜택|적립|캐시백|할인|마케팅|결제하면|사용하면|이용하면|결제\s*시|사용\s*시|추첨|증정|리워드/u;
const REFUND = /취\s*소|환\s*불|반\s*환|환\s*급|승인\s*정정/u;
const TRANSFER = /이체|송금|계좌\s*이동/u;
const CASH = /\bATM\b|현금\s*(?:출금|인출|서비스)|인출|현금\s*지급/iu;
const SETTLEMENT = /카드\s*(?:대금|값)|(?:대금|청구\s*금액)\s*(?:결제|출금|납부)|(?:결제|납부)\s*대금|대금\s*납부|결제일|결제\s*계좌|청구서/u;
const DEPOSIT = /입금/u;
const WITHDRAWAL = /출금|자동\s*납부|입출금/u;
const FOREIGN = /\b(?:USD|EUR|JPY|CNY|HKD|SGD|AUD|CAD|GBP)\b|달러|엔화|유로|해외\s*(?:승인|이용|결제)|환율|[$€¥]/iu;
const SUMMARY = /이용\s*내역|사용\s*내역|결제\s*내역|이번\s*달|이달\s*(?:사용|이용)|월간|월별|명세서/u;
const VERIFICATION = /테스트\s*알림|예시\s*알림|알림\s*테스트|본인\s*확인|카드\s*인증|인증\s*(?:번호|금액|용)/u;
const NON_PAYMENT = /대출|카드\s*발급|발급\s*승인|한도\s*증액|신용\s*(?:조회|평점|심사)|계좌\s*개설|계약\s*승인|연장\s*승인|보증\s*승인/u;

function normalized(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\r\n?/gu, '\n').trim() : '';
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function koreaDate(value) {
  return new Date(Date.parse(value) + KOREA_OFFSET).toISOString().slice(0, 10);
}

function dateString(year, month, day) {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${value}T00:00:00.000Z`);
  return year >= 1 && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function extractDate(text, receivedAt, occurredAt) {
  const fallback = validTimestamp(occurredAt) ? occurredAt : receivedAt;
  const baseDate = koreaDate(fallback);
  const isoTimes = [...text.matchAll(ISO_TIMESTAMP_PATTERN)];
  const fullDates = [...text.matchAll(DATE_PATTERN)];
  const dates = [];
  let problem = '';
  const explicitTimes = [];
  for (const match of isoTimes) {
    const [year, month, day] = match[0].slice(0, 10).split('-').map(Number);
    if (!dateString(year, month, day) || !validTimestamp(match[0])) problem = '알림의 거래 날짜·시각을 확인해 주세요.';
    else {
      dates.push(koreaDate(match[0]));
      explicitTimes.push(new Date(match[0]).toISOString());
    }
  }
  for (const match of fullDates) {
    if (isoTimes.some(iso => match.index >= iso.index && match.index < iso.index + iso[0].length)) continue;
    const value = dateString(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!value) problem = '알림의 거래 날짜를 확인해 주세요.';
    else dates.push(value);
  }
  for (const match of text.matchAll(SHORT_DATE_PATTERN)) {
    if (fullDates.some(full => match.index >= full.index && match.index < full.index + full[0].length)) continue;
    const month = Number(match[1]), day = Number(match[2]);
    let year = Number(baseDate.slice(0, 4));
    // A December notification forwarded shortly after New Year belongs to the
    // previous year. Other future month/day combinations need confirmation.
    if (Number(baseDate.slice(5, 7)) === 1 && month === 12) year -= 1;
    const value = dateString(year, month, day);
    if (!value) problem = '알림의 거래 날짜를 확인해 주세요.';
    else dates.push(value);
  }
  const distinct = [...new Set(dates)];
  if (distinct.length > 1) problem = '알림에 날짜가 여러 개 있어 거래 날짜를 확인해 주세요.';
  const date = distinct.length === 1 ? distinct[0] : baseDate;
  const times = [...text.matchAll(TIME_PATTERN)];
  const validTimes = [];
  for (const match of times) {
    if (isoTimes.some(iso => match.index >= iso.index && match.index < iso.index + iso[0].length)) continue;
    const hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3] || 0);
    if (hour > 23 || minute > 59 || second > 59) problem = '알림의 거래 시각을 확인해 주세요.';
    else validTimes.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`);
  }
  const distinctTimes = [...new Set(validTimes)];
  if (distinctTimes.length > 1) problem = '알림에 시각이 여러 개 있어 거래 시각을 확인해 주세요.';
  let transactionTime = validTimestamp(occurredAt) ? new Date(occurredAt).toISOString() : null;
  const distinctExplicitTimes = [...new Set(explicitTimes)];
  if (distinctExplicitTimes.length > 1) problem = '알림에 시각이 여러 개 있어 거래 시각을 확인해 주세요.';
  else if (distinctExplicitTimes.length === 1) transactionTime = distinctExplicitTimes[0];
  if (distinctTimes.length === 1) transactionTime = new Date(`${date}T${distinctTimes[0]}+09:00`).toISOString();
  if (date > koreaDate(receivedAt) || (transactionTime && Date.parse(transactionTime) > Date.parse(receivedAt) + 5 * 60 * 1000)) {
    problem = '거래 시각이 미래로 표시되어 확인이 필요합니다.';
  }
  return { date, transaction_time: transactionTime, problem };
}

function extractAmounts(text) {
  const matches = [...text.matchAll(MONEY_PATTERN)];
  const candidates = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    const previousEnd = index ? matches[index - 1].index + matches[index - 1][0].length : 0;
    const before = text.slice(Math.max(lineStart, previousEnd), match.index);
    const previousLine = text.slice(0, lineStart).trimEnd().split('\n').at(-1) || '';
    if (/[\p{Dash_Punctuation}+−±]\s*$/u.test(text.slice(0, match.index))) continue;
    if (NON_TRANSACTION_AMOUNT.test(before)) continue;
    if (!before.trim() && NON_TRANSACTION_AMOUNT.test(previousLine) && !/원|₩/u.test(previousLine)) continue;
    const amount = Number((match[1] || match[2]).replaceAll(',', ''));
    if (Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_AMOUNT) candidates.push({ amount, match });
  }
  return candidates;
}

function merchantText(value) {
  return value.replace(/(?:₩\s*)?[\d,]+\s*원/gu, '').replace(/\s*(?:일시불|할부\s*\d+개월|승인|결제\s*완료)\s*/gu, ' ')
    .replace(/^\s*[:：|·\-]+|\s*[:：|·\-]+$/gu, '').trim().slice(0, 200);
}

function extractHints(text, payload, amounts) {
  const card = text.match(/(?:카드(?:번호)?|card)\s*[:：]?\s*[\[(]?([*xX•\d-]{3,24})/iu)
    || text.match(/(?:국민|KB|토스|삼성|신한|현대|우리|롯데|하나|NH|농협)(?:카드)?\s*[\[(]([*xX•\d-]{3,24})[\])]/u);
  const account = text.match(/(?:계좌(?:번호)?|통장)\s*[:：]?\s*([*xX•\d-]{4,30})/u);
  let merchant = '';
  const labeled = text.match(/(?:가맹점(?:명)?|사용처|이용처|결제처|상호)\s*[:：]?\s*([^\n|]+)/u);
  const located = text.match(/([^\n]+?)에서\s*(?:[\d,]+\s*원\s*)?(?:결제|승인|사용)/u);
  if (labeled) merchant = merchantText(labeled[1]);
  else if (located) merchant = merchantText(located[1]);
  if (!merchant) {
    const excluded = /승인|결제|사용|입금|출금|송금|이체|잔액|잔고|누적|누계|한도|일시불|할부|카드|은행|광고|이벤트|혜택|알림|발신|님|https?:|고객센터|\d{1,2}:\d{2}|\d{1,2}[./-]\d{1,2}|원|₩/u;
    const app = normalized(payload.source_app);
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const candidate = lines.findLast(line => line !== app && !/^[\[\]()\s]*(?:토스|토스뱅크|KB|국민|KB국민은행|KB국민카드)[\[\]()\s]*$/u.test(line) && /[가-힣A-Za-z]/u.test(line) && !excluded.test(line));
    if (candidate) merchant = merchantText(candidate);
  }
  if (!merchant && amounts.length === 1) {
    const amount = amounts[0].match;
    const after = text.slice(amount.index + amount[0].length).split('\n')[0];
    const candidate = merchantText(after);
    if (candidate && /[가-힣A-Za-z]/u.test(candidate) && !/잔액|누적|한도|일시불|할부|취소|환불|했어요|되었습니다|했습|사용|승인|입금|출금|이체|송금|납부|금액|계좌|대금|완료|성공|통장|거래|적립|은행|카드|토스|\d{1,2}:\d{2}/u.test(candidate)) merchant = candidate;
  }
  return { merchant, card: card?.[1] || '', account: account?.[1] || '' };
}

function completedPayment(text) {
  return /(?:승인|결제|사용)\s*(?:완료|성공|됐|되었습니다|하였습니다|했어요|하였|했습|되었|했습니다|하셨어요)/u.test(text)
    || /카드[^\n]{0,30}(?:승인|사용|결제)(?=$|[\s:：\d]|완료|성공|됐|되었|했|하였)(?!\s*(?:번호|내역|예정|대기|가능|안내|방법))/u.test(text)
    || /원\s*(?:승인|결제|사용)(?=$|[\s:：\d]|완료|성공|됐|되었|했|하였)(?!\s*(?:번호|내역|예정|대기|가능|안내|방법))/u.test(text)
    || /(?:^|\n)\s*(?:\[[^\]]+\]\s*)?(?:승인|결제|사용)\s*(?:\n|[:：]|[\d,]+\s*원)/u.test(text);
}

export function parseNotification(payload, { receivedAt, occurredAt } = {}) {
  const received = validTimestamp(receivedAt) ? receivedAt : new Date().toISOString();
  const text = [payload.title, payload.subtitle, payload.body].map(normalized).filter(Boolean).join('\n');
  const amounts = extractAmounts(text);
  const hints = extractHints(text, payload, amounts);
  const timing = extractDate(text, received, occurredAt);
  const approved = completedPayment(text);
  let kind = approved ? 'expense' : null;
  let reason = '';
  if (REFUND.test(text)) { kind = 'refund'; reason = '취소·환불 알림은 원거래를 확인해 주세요.'; }
  else if (SETTLEMENT.test(text)) { kind = 'transfer'; reason = '카드대금 정산은 결제 지출과 구분해 확인해 주세요.'; }
  else if (TRANSFER.test(text)) { kind = 'transfer'; reason = '이체·송금 알림은 거래 유형을 확인해 주세요.'; }
  else if (CASH.test(text)) { kind = 'expense'; reason = '현금 인출 알림은 거래 내용을 확인해 주세요.'; }
  else if (FAILED.test(text)) reason = '실패·거절 알림은 자동으로 기록하지 않습니다.';
  else if (PENDING.test(text)) reason = '예정·대기 알림은 거래 완료 여부를 확인해 주세요.';
  else if (VERIFICATION.test(text)) reason = '인증·테스트 알림은 실제 지출인지 확인해 주세요.';
  else if (NON_PAYMENT.test(text)) reason = '금융 상품·심사 알림은 결제 지출인지 확인해 주세요.';
  else if (MARKETING.test(text)) reason = '광고·혜택 알림은 거래 여부를 확인해 주세요.';
  else if (DEPOSIT.test(text)) { kind = 'income'; reason = '입금 알림은 거래 유형을 확인해 주세요.'; }
  else if (WITHDRAWAL.test(text)) { kind = 'expense'; reason = '출금 알림은 결제·정산·이체 여부를 확인해 주세요.'; }
  else if (FOREIGN.test(text)) reason = '외화·해외 거래는 원화 금액을 확인해 주세요.';
  else if (SUMMARY.test(text)) reason = '요약·내역 알림은 개별 거래인지 확인해 주세요.';
  else if (amounts.length !== 1) reason = amounts.length ? '거래 금액이 여러 개 있어 확인이 필요합니다.' : '명확한 원화 거래 금액을 찾지 못했습니다.';
  else if (amounts[0].amount === 0) reason = '0원 승인 알림은 실제 지출인지 확인해 주세요.';
  else if (timing.problem) reason = timing.problem;
  else if (!approved) reason = '결제 승인 완료 여부를 확인해 주세요.';
  return {
    date: timing.date,
    amount: amounts.length === 1 ? amounts[0].amount : null,
    kind,
    note: hints.merchant || '알림 수집 거래',
    confidence: !reason,
    reason: reason || '명확한 원화 결제 승인 알림입니다.',
    hints,
    transaction_time: timing.transaction_time,
  };
}
