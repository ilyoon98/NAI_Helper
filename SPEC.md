# NovelAI 자동화 도우미 — 스펙 문서

버전: 1.9.1
대상 사이트: `https://novelai.net/*`

## 개요

NovelAI 이미지 생성 페이지에서 동작하는 크롬 확장 프로그램(Manifest V3). 페이지 위에 떠있는 패널(UI)을 통해 자동 반복 생성, 이미지 자동 저장, 캐릭터별 프롬프트 태그 편집, 태그 즐겨찾기, 프롬프트 프리셋 저장/적용, 백업 코드로 내보내기/가져오기 기능을 제공한다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 매니페스트. 권한, content script 등록 |
| `background.js` | 서비스 워커. 다운로드 실행, 툴바 아이콘 클릭 시 패널 토글 메시지 전달 |
| `content.js` | 실제 기능 전부(패널 UI, NovelAI DOM 조작, 자동 생성/저장 로직) |

## 권한

- `storage`, `downloads`, `unlimitedStorage`
- `host_permissions`: `https://novelai.net/*`
- 아이콘 없음 (기본 퍼즐 아이콘 사용)

## 기능 상세

### 1. 자동 반복 생성 (`autoGenerate`)

- 패널 체크박스 ON/OFF → `chrome.storage.local`에 저장.
- **폴링 방식이 아닌 이벤트 기반**으로 동작 (v1.9.0부터):
  - 체크박스를 켜는 순간 즉시 1회 생성 시도.
  - 새로고침 시 이미 켜져 있던 상태라면 로드 직후 이어서 시작.
  - 이미지 생성이 완성될 때(`onImageGenerated` 감지)마다 **500~1000ms 사이 무작위 지연** 후 다음 생성 클릭 (v1.9.1, 고정 간격으로 두드리지 않기 위함).
  - 생성 실패 등으로 완성 이벤트가 끝내 안 오는 경우를 대비한 5초 간격 저빈도 안전망(`setInterval(tryAutoGenerateClick, 5000)`) 유지.
- Generate 버튼 탐색: 화면에 보이는(`offsetParent !== null`) `<button>` 중 텍스트가 `Generate`로 시작하는 것을 선택. 못 찾으면 콘솔에 `[NovelAI 도우미]` 경고 1회(찾을 때까지 반복 경고하지 않도록 플래그 관리).

### 2. 자동 저장 (`autoSave`)

- 새로 생성된 이미지(`img.image-grid-image`, `src`가 `blob:`로 시작)를 감지하면 fetch → dataURL 변환 → `background.js`에 다운로드 요청.
- 파일명: `NovelAI/novelai_YYYYMMDD_HHMMSS.png` (고정 포맷, background.js에서 정규식으로 검증).
- 같은 이미지(blob src)를 중복 저장하지 않도록 `savedImageSrcs` Set으로 추적.

### 3. 프롬프트 태그 편집 (Base / 캐릭터별, 포지티브/네거티브)

- NovelAI가 프롬프트 입력창을 "탭 방식"(하나만 보임) 또는 "핀 방식"(포지티브·네거티브 동시 표시)으로 렌더링하는 두 경우를 모두 처리.
- `target`: `'base'` 또는 캐릭터 인덱스(숫자). `mode`: `'positive'` | `'negative'`.
- 현재 프롬프트를 콤마 기준으로 태그 목록화하여 패널에 세로 리스트로 표시, 태그별로:
  - 드래그 앤 드롭으로 순서 변경
  - 개별 삭제
  - 즐겨찾기로 저장
- ProseMirror(contenteditable) 편집기에 텍스트를 반영할 때 `document.execCommand('selectAll' / 'insertText')` 사용.

### 4. 태그 즐겨찾기

- 태그 텍스트 + 모드(P/N)를 `chrome.storage.local`의 `tagFavorites`에 저장.
- 패널에서 클릭 한 번으로 현재 선택된 target/mode 프롬프트에 추가 가능.

### 5. 프롬프트 프리셋

- 현재 Base 또는 캐릭터 프롬프트(포지티브+네거티브)를 이름 붙여 저장.
- 저장 시점에 마지막으로 생성된 이미지가 있으면 320px 이하로 축소한 JPEG 썸네일(base64)을 함께 저장, 프리셋 이름에 마우스를 올리면 미리보기 표시.
- 프리셋 적용 시 스코프(Base용/캐릭터용)를 검사해 잘못된 대상에 적용하지 않도록 가드.
- 프리셋 ID는 `makeId()`(타임스탬프+랜덤)로 생성해 충돌 방지.

### 6. 백업 / 복원 (코드 내보내기·가져오기)

- 프리셋(썸네일 제외)·즐겨찾기 데이터를 JSON → gzip 압축 → base64 인코딩한 "코드"로 변환/복사.
- 가져오기는 기존 데이터를 지우지 않고 병합(중복 ID/중복 태그는 스킵).

### 7. 패널 UI 공통

- 드래그로 위치 이동, 리사이즈 핸들로 크기 조절 — 위치·크기 모두 `chrome.storage.local`에 저장되어 복원됨.
- 섹션(즐겨찾기/현재 태그/프리셋/백업)은 개별 접기·펼치기 가능, 상태 저장됨.
- 툴바 아이콘 클릭 → `background.js`가 현재 탭에 `togglePanel` 메시지 전송 → 패널 표시/숨김 토글.

## 보안 조치 (v1.9.0 이전 검토에서 추가)

- `background.js`, `content.js`의 `chrome.runtime.onMessage` 리스너는 `sender.id === chrome.runtime.id`를 확인해 확장 프로그램 자기 자신이 보낸 메시지만 처리.
- 다운로드 메시지는 `dataUrl`이 `data:image/`로 시작하는지, `filename`이 고정 포맷 정규식(`^NovelAI\/novelai_\d{8}_\d{6}\.png$`)과 일치하는지 검증 후에만 `chrome.downloads.download` 실행.
- 사용자 입력(태그/프리셋 이름 등)은 전부 `.textContent`/`.title`로만 DOM에 반영, `innerHTML`에 직접 삽입하지 않음.

## 알려진 이슈 / 참고사항

- NovelAI 페이지에서 관찰되는 `explore.novelai.net/user/self` 403 에러는 **본 확장 프로그램과 무관**함 — 스택 트레이스가 NovelAI 자체 번들(`main.js`, `framework-*.js`, `_app-*.js`)을 가리키며, 본 확장에는 해당 URL을 호출하는 코드가 없음(확인됨).
- `document.execCommand`는 deprecated API이나, React 기반 ProseMirror 편집기에 안전하게 값을 반영할 수 있는 사실상 유일한 방법이라 현재도 사용 중. 향후 브라우저에서 제거되면 대체 방법 필요.
- 확장 프로그램을 `chrome://extensions`에서 리로드만 하고 탭을 새로고침하지 않으면, 이미 열려있던 탭에 content script가 중복 주입되어 패널/타이머/이벤트 리스너가 여러 개 동시에 살아있는 상태가 될 수 있음. 코드 변경 후에는 **탭을 완전히 닫았다가 새로 열 것**을 권장.
- Generate 버튼 탐색은 텍스트 매칭(`/^Generate\b/i`) 기반이라 NovelAI가 버튼 문구/구조를 바꾸면 다시 깨질 수 있음 — 이 경우 콘솔에 경고가 뜨도록 되어 있음.

## 변경 이력 (요약)

- **v1.8.0**: 기존 기능 일체 (자동 생성/저장, 태그 편집, 즐겨찾기, 프리셋, 백업/복원).
- **v1.9.0**: 메시지 sender 검증 추가, 다운로드 payload 검증 추가, 프리셋 ID 생성 방식 통일(`makeId()`), 현재 태그 목록 세로 정렬 CSS 버그 수정(`flex-wrap: nowrap`), 자동 생성을 폴링 방식에서 이벤트(생성 완료) 기반으로 전환.
- **v1.9.1**: 자동 생성 재시도 지연을 고정 500ms에서 500~1000ms 무작위로 변경.
