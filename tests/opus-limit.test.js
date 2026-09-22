// Opus 무료 생성 잔량 감지 로직 테스트 (의존성 없음 — node tests/opus-limit.test.js)
//
// content.js를 통째로 실행할 수는 없다(chrome.* / DOM이 없으므로). 그래서 감지 블록만
// 텍스트로 잘라내 가짜 DOM 위에서 돌린다. 복사본이 아니라 실제 content.js를 읽으므로,
// content.js를 고치면 이 테스트도 새 코드를 검사한다.
//
// NovelAI가 잔량 문구나 Generate 버튼 구조를 또 바꿔서 정규식을 손봐야 할 때,
// 기존 케이스가 깨지지 않았는지 확인하는 용도.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const CONTENT_JS = path.join(__dirname, '..', 'content.js');
const src = fs.readFileSync(CONTENT_JS, 'utf8');
const start = src.indexOf('const OPUS_LINE_RE');
const end = src.indexOf('// 자동 반복 생성을 끄고');
if (start < 0 || end < 0 || end < start) {
  throw new Error('content.js에서 Opus 감지 블록을 찾지 못했어요 — 블록 경계 주석이 바뀌었는지 확인해주세요.');
}
const block = src.slice(start, end);

// 잔량 문구를 품은 요소들(문서 순서 = 바깥 → 안쪽). 실제 페이지에선 20개가 잡힌다.
let fakeGaugeTexts = [];
let fakeButtonText = null;
let now = 0;
let gaugeEls = [];

function setGauge(texts) {
  // 이전 시나리오의 요소는 DOM에서 빠진 셈으로 둔다.
  // 실제 코드가 opusGaugeElCache.isConnected로 캐시를 무효화하는 경로를 그대로 타게 하려는 것.
  gaugeEls.forEach((el) => { el.isConnected = false; });
  fakeGaugeTexts = texts;
  gaugeEls = texts.map((t) => ({ textContent: t, isConnected: true }));
}

const sandbox = {
  DEFAULT_OPUS_LIMIT_PERCENT: 10,
  settingsCache: { opusLimit: true, opusLimitPercent: 10, anlasGuard: true },
  console,
  Number,
  Math,
  String,
  isFinite,
  Date: { now: () => now },
  document: {
    querySelectorAll() {
      return gaugeEls;
    },
  },
  Infinity,
  getGenerateButton() {
    return fakeButtonText === null ? null : { textContent: fakeButtonText, isConnected: true };
  },
};
// readAnlasGuard()는 감지 블록보다 위(설정 캐시 근처)에 있어 따로 잘라온다.
const guardFnStart = src.indexOf('function readAnlasGuard(');
if (guardFnStart < 0) throw new Error('content.js에서 readAnlasGuard()를 찾지 못했어요.');
const guardFn = src.slice(guardFnStart, src.indexOf('}', guardFnStart) + 1);

vm.createContext(sandbox);
vm.runInContext(guardFn + '\n' + block, sandbox);

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `\n        기대: ${e}\n        실제: ${a}`));
}

function scenario({ gauge, button, limit, on = true, guard = true, elapsed = 60000 }) {
  setGauge(gauge === undefined ? [] : Array.isArray(gauge) ? gauge : [gauge]);
  fakeButtonText = button === undefined ? null : button;
  sandbox.settingsCache.opusLimit = on;
  sandbox.settingsCache.anlasGuard = guard;
  if (limit !== undefined) sandbox.settingsCache.opusLimitPercent = limit;
  now = elapsed; // pageLoadedAt은 블록 평가 시점(now=0)에 잡혔다
  const read = sandbox.readOpusRemaining();
  const verdict = sandbox.checkOpusBudget();
  return { percent: read.percent, text: read.text, anlas: read.anlas, action: verdict.action, reason: verdict.reason };
}

// --- 잔량 문구 파싱 ---
check(
  '100% 잔량 + More Info 링크가 같은 줄에 있어도 파싱',
  scenario({ gauge: '100% of Opus Generations remaining More Info', button: 'Generate 1 Image 0', limit: 10 }).percent,
  100
);
check(
  '줄바꿈/여러 공백이 섞여도 파싱',
  scenario({ gauge: '  97 %  of   Opus\n Generations  remaining ', button: 'Generate 1 Image 0', limit: 10 }).percent,
  97
);
check(
  '소수점 잔량도 파싱',
  scenario({ gauge: '12.5% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).percent,
  12.5
);
check(
  '단수형(Generation) 문구도 파싱',
  scenario({ gauge: '3% of Opus Generation remaining', button: 'Generate 1 Image 0', limit: 10 }).percent,
  3
);
check(
  '숫자 없는 소진 문구는 0%로 간주',
  scenario({ gauge: 'No Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).percent,
  0
);
check(
  '문구 자체가 없으면 null',
  scenario({ gauge: undefined, button: 'Generate 1 Image 0', limit: 10 }).percent,
  null
);

// --- Anlas 비용 파싱 ---
check(
  '무료 생성 버튼(0)',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).anlas,
  0
);
check(
  '유료 생성 버튼(24)',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 1 Image 24', limit: 10 }).anlas,
  24
);
check(
  '여러 장 생성 버튼(Generate 4 Images 96)',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 4 Images 96', limit: 10 }).anlas,
  96
);
check(
  '천 단위 콤마(1,234)',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 1 Image 1,234', limit: 10 }).anlas,
  1234
);
check(
  '배지 없는 버튼은 null(모름)',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 1 Image', limit: 10 }).anlas,
  null
);
check(
  '예상 밖 버튼 문구는 null(모름)',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate', limit: 10 }).anlas,
  null
);

// --- 판단 ---
check(
  '잔량 100% > 임계 10% → 계속',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).action,
  'go'
);
check(
  '잔량 11% > 임계 10% → 계속',
  scenario({ gauge: '11% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).action,
  'go'
);
check(
  '잔량 10% = 임계 10% → 정지',
  scenario({ gauge: '10% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).action,
  'stop'
);
check(
  '잔량 9% < 임계 10% → 정지',
  scenario({ gauge: '9% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).action,
  'stop'
);
check(
  '잔량은 넉넉한데 버튼이 유료(Anlas 24) → 정지',
  scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 1 Image 24', limit: 10 }).action,
  'stop'
);
check(
  '잔량 제한이 꺼져 있으면 잔량 0%여도 계속 (무료 생성이라 Anlas 체크도 안 걸림)',
  scenario({ gauge: '0% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10, on: false }).action,
  'go'
);
check(
  '문구 못 찾음 + 로드 직후(5초) → 이번 클릭만 보류',
  scenario({ gauge: undefined, button: 'Generate 1 Image 0', limit: 10, elapsed: 5000 }).action,
  'wait'
);
check(
  '문구 못 찾음 + 로드 후 충분히 지남 → 안전 정지',
  scenario({ gauge: undefined, button: 'Generate 1 Image 0', limit: 10, elapsed: 60000 }).action,
  'stop'
);
check(
  '임계 0%면 잔량 1%까진 계속',
  scenario({ gauge: '1% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 0 }).action,
  'go'
);
check(
  '임계 0% + 잔량 0% → 정지',
  scenario({ gauge: '0% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 0 }).action,
  'stop'
);

// --- 실제 novelai.net/image DOM에서 뜬 문자열 (2026-09 실측) ---
// 같은 문구를 품은 요소가 바깥(footer)부터 안쪽(span)까지 함께 잡히는 상황을 재현한다.
const REAL_SPAN = '100% of Opus Generations remaining';
const REAL_ROW = '100% of Opus Generations remainingMore Info';
const REAL_FOOTER =
  'StepsGuidanceSeedSamplerEuler AncestralEuler Ancestral100% of Opus Generations remaining' +
  'More InfoGenerate 1 Image26Anlas';
const REAL_BUTTON = 'Generate 1 Image26Anlas';

check(
  '실측 버튼 텍스트에서 Anlas 26을 읽는다',
  scenario({ gauge: REAL_SPAN, button: REAL_BUTTON, limit: 10 }).anlas,
  26
);
check(
  '바깥 footer와 안쪽 span이 함께 잡히면 가장 안쪽(span)을 고른다',
  scenario({ gauge: [REAL_FOOTER, REAL_ROW, REAL_SPAN], button: REAL_BUTTON, limit: 10 }).text,
  REAL_SPAN
);
check(
  '바깥 footer만 잡혀도 퍼센트는 올바로 읽는다(버튼의 26에 낚이지 않음)',
  scenario({ gauge: [REAL_FOOTER], button: REAL_BUTTON, limit: 10 }).percent,
  100
);
check(
  '잔량 100%여도 버튼이 유료(26 Anlas)면 정지 — 실측 상태',
  scenario({ gauge: [REAL_FOOTER, REAL_SPAN], button: REAL_BUTTON, limit: 10 }).action,
  'stop'
);
// 퍼센트 숫자가 형제 요소로 쪼개져 안쪽 요소엔 문구만 남는 경우.
// 문구만 있는 요소를 고르면 '숫자 없음 = 0%'로 읽혀 멀쩡한데도 멈춰버린다.
check(
  '숫자가 쪼개져 있으면 퍼센트를 품은 요소를 우선한다 (0%로 오판하지 않음)',
  scenario({ gauge: ['of Opus Generations remaining', REAL_ROW], button: 'Generate 1 Image 0', limit: 10 }).percent,
  100
);
check(
  '위 경우 판정도 계속(go)',
  scenario({ gauge: ['of Opus Generations remaining', REAL_ROW], button: 'Generate 1 Image 0', limit: 10 }).action,
  'go'
);
// 문구만 있고 문서 어디에도 퍼센트가 없으면 소진(0%)으로 보는 기존 동작은 유지.
check(
  '문서에 퍼센트가 아예 없으면 소진(0%)으로 간주',
  scenario({ gauge: ['No Opus Generations remaining'], button: 'Generate 1 Image 0', limit: 10 }).percent,
  0
);

// --- 두 안전망의 독립 동작 (v1.13.0: Anlas 체크를 별도 체크박스로 분리) ---
// 실측에서 게이지 100% + 26 Anlas 라는 어긋난 상태가 확인됐으므로, 한쪽만 켜서 쓸 수 있어야 한다.
check(
  'Anlas 체크를 끄면 잔량 100% + 26 Anlas에서도 계속',
  scenario({ gauge: REAL_SPAN, button: REAL_BUTTON, limit: 10, guard: false }).action,
  'go'
);
check(
  'Anlas 체크를 꺼도 잔량 임계값은 그대로 동작',
  scenario({ gauge: '5% of Opus Generations remaining', button: REAL_BUTTON, limit: 10, guard: false }).action,
  'stop'
);
check(
  '잔량 제한을 꺼도 Anlas 체크만으로 정지한다',
  scenario({ gauge: REAL_SPAN, button: REAL_BUTTON, limit: 10, on: false, guard: true }).action,
  'stop'
);
check(
  '잔량 제한 끔 + Anlas 체크 끔 → 아무 판정도 하지 않는다',
  scenario({ gauge: '0% of Opus Generations remaining', button: REAL_BUTTON, limit: 10, on: false, guard: false }).action,
  'go'
);
check(
  '잔량 제한 끔 + Anlas 체크 켬 + 무료(0) → 계속',
  scenario({ gauge: REAL_SPAN, button: 'Generate 1 Image 0', limit: 10, on: false, guard: true }).action,
  'go'
);
check(
  '잔량 제한 끔 + Anlas 체크 켬 + 문구 없음 → 비용을 읽었으므로 계속',
  scenario({ gauge: undefined, button: 'Generate 1 Image 0', limit: 10, on: false, guard: true }).action,
  'go'
);

// readAnlasGuard: 저장된 적 없으면 켬이 기본이어야 한다 (!!로 읽으면 꺼짐이 되어버림)
check('readAnlasGuard(undefined) = true', sandbox.readAnlasGuard(undefined), true);
check('readAnlasGuard(false) = false', sandbox.readAnlasGuard(false), false);
check('readAnlasGuard(true) = true', sandbox.readAnlasGuard(true), true);

// --- 두 신호가 어긋날 때(잔량 넉넉 + Anlas 비용 붙음) 새로고침 안내 ---
// 로그인 직후 F5 전에는 실제로 무료인데도 비용이 표시된다(사용자 확인).
check(
  '잔량이 임계값보다 넉넉한데 비용이 붙으면 새로고침 안내를 붙인다',
  /새로고침/.test(scenario({ gauge: REAL_SPAN, button: REAL_BUTTON, limit: 10 }).reason),
  true
);
check(
  '잔량도 임계값 이하면 새로고침 안내는 붙이지 않는다',
  /새로고침/.test(scenario({ gauge: '5% of Opus Generations remaining', button: REAL_BUTTON, limit: 10 }).reason),
  false
);
check(
  '잔량 제한을 꺼둬도 게이지에 여유가 있으면 새로고침 안내를 붙인다',
  /새로고침/.test(scenario({ gauge: REAL_SPAN, button: REAL_BUTTON, limit: 10, on: false }).reason),
  true
);
check(
  '잔량 제한 끔 + 게이지 0% + 비용 붙음 → 어긋남이 아니므로 안내 없음',
  /새로고침/.test(scenario({ gauge: '0% of Opus Generations remaining', button: REAL_BUTTON, limit: 10, on: false }).reason),
  false
);

// --- clampPercent ---
check('clampPercent(undefined) = 기본 10', sandbox.clampPercent(undefined), 10);
check('clampPercent("") = 기본 10', sandbox.clampPercent(''), 10);
check('clampPercent(150) = 99', sandbox.clampPercent(150), 99);
check('clampPercent(-5) = 0', sandbox.clampPercent(-5), 0);
check('clampPercent("7.6") = 8', sandbox.clampPercent('7.6'), 8);
check('formatPercent(12.5) = "12.5"', sandbox.formatPercent(12.5), '12.5');
check('formatPercent(100) = "100"', sandbox.formatPercent(100), '100');

// 정지 메시지 예시 출력 (사람이 읽을 문장 확인용)
console.log('\n정지 메시지 예시:');
console.log(' 1) ' + scenario({ gauge: '9% of Opus Generations remaining', button: 'Generate 1 Image 0', limit: 10 }).reason);
console.log(' 2) ' + scenario({ gauge: '100% of Opus Generations remaining', button: 'Generate 1 Image 24', limit: 10 }).reason);
console.log(' 3) ' + scenario({ gauge: undefined, button: 'Generate 1 Image', limit: 10 }).reason);

console.log('\n' + (failures ? failures + '건 실패' : '전부 통과'));
process.exit(failures ? 1 : 0);
