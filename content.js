// NovelAI 자동화 도우미 - content script (runs on https://novelai.net/*)

let settingsCache = { autoGenerate: false, autoSave: false };
const savedImageSrcs = new Set();

// 확장 프로그램이 리로드되면 탭에 남아있던 옛 content script의 chrome.* 호출이
// "Extension context invalidated" 에러를 뿜는다. 호출 전에 살아있는지 확인한다.
function extAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

function safeStorageSet(obj, callback) {
  if (!extAlive()) return;
  try {
    chrome.storage.local.set(obj, callback);
  } catch (e) {
    /* 컨텍스트가 방금 죽었으면 조용히 무시 */
  }
}

// 이 시각 전에는 자동 생성 클릭을 보류한다 (새로고침 직후 429 방지용).
let autoGenerateHoldUntil = 0;
// 다음 자동 생성 클릭이 예약된 시각 (패널의 카운트다운 표시용).
let nextGenerateAt = 0;

chrome.storage.local.get(['autoGenerate', 'autoSave'], (data) => {
  settingsCache.autoGenerate = !!data.autoGenerate;
  settingsCache.autoSave = !!data.autoSave;
  // 페이지를 새로고침했는데 자동 생성이 이미 켜져 있던 상태라면 이어서 시작하되,
  // 새로고침 직전에 걸어둔 생성이 아직 서버에서 돌고 있을 수 있으므로
  // (429 "Concurrent generation is locked" 방지) 8초 기다렸다가 시작한다.
  if (settingsCache.autoGenerate) {
    autoGenerateHoldUntil = Date.now() + 8000;
    nextGenerateAt = Date.now() + 8100;
    setTimeout(tryAutoGenerateClick, 8100);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('autoGenerate' in changes) {
    settingsCache.autoGenerate = !!changes.autoGenerate.newValue;
    // 체크박스를 직접 막 켠 경우엔 보류 없이 바로 첫 생성을 시작한다.
    // (직전 생성이 아직 서버에서 돌고 있으면 tryAutoGenerateClick이 알아서 건너뛴다.)
    if (settingsCache.autoGenerate) {
      autoGenerateHoldUntil = 0;
      tryAutoGenerateClick();
    }
  }
  if ('autoSave' in changes) settingsCache.autoSave = !!changes.autoSave.newValue;
});

// "target" identifies WHICH prompt we're reading/writing: 'base' for the main
// Base Prompt / Undesired Content box, or a number for a character's own
// Prompt / Undesired Content box (character N's container carries class
// "character-prompt-input-N").
//
// NovelAI names the base box "prompt-input-box-prompt" with no characters added,
// and renames it to "prompt-input-box-base-prompt" once a character prompt exists
// (which gets its own "prompt-input-box-character-prompts-N" box). Match either
// base-prompt naming but always exclude character prompt boxes.
// NovelAI can also be "pinned" open, showing Base Prompt and Undesired Content (or
// a character's Prompt and Undesired Content) as two separate boxes at once,
// instead of sharing one tabbed slot — so we can't just grab "whichever box is
// visible", we must pick the one matching the requested mode.
function getVisibleBasePromptBoxes() {
  return Array.from(document.querySelectorAll('[class*="prompt-input-box-"]')).filter(
    (el) => !/character-prompts/.test(el.className) && el.offsetParent !== null
  );
}

function getCharacterIndices() {
  const els = document.querySelectorAll('[class*="character-prompt-input-"]');
  const indices = new Set();
  els.forEach((el) => {
    Array.from(el.classList).forEach((cls) => {
      const m = cls.match(/^character-prompt-input-(\d+)$/);
      if (m) indices.add(Number(m[1]));
    });
  });
  return Array.from(indices).sort((a, b) => a - b);
}

function getCharacterContainer(index) {
  return (
    Array.from(document.querySelectorAll('[class*="character-prompt-input-"]')).find((el) =>
      el.classList.contains(`character-prompt-input-${index}`)
    ) || null
  );
}

function getVisibleCharacterPromptBoxes(index) {
  const container = getCharacterContainer(index);
  if (!container) return [];
  return Array.from(container.querySelectorAll('[class*="prompt-input-box-"]')).filter(
    (el) => el.offsetParent !== null
  );
}

function getBasePromptBox(mode) {
  const boxes = getVisibleBasePromptBoxes();
  if (boxes.length === 0) return null;
  if (boxes.length === 1) return boxes[0]; // tabbed mode: whichever's currently shown
  const wanted = boxes.find((el) => {
    const isNegative = /undesired-content/.test(el.className);
    return mode === 'negative' ? isNegative : !isNegative;
  });
  return wanted || boxes[0];
}

function getPromptBox(target, mode) {
  if (target === 'base') return getBasePromptBox(mode);
  const boxes = getVisibleCharacterPromptBoxes(target);
  if (boxes.length === 0) return null;
  if (boxes.length === 1) return boxes[0];
  // Character boxes don't rename their class per mode like the base box does,
  // so when pinned (both shown at once) we fall back to DOM order: Prompt first.
  return mode === 'negative' ? boxes[1] : boxes[0];
}

function getPromptEditor(target, mode) {
  const box = getPromptBox(target, mode);
  if (!box) return null;
  return box.querySelector('.ProseMirror[contenteditable="true"]');
}

// In tabbed mode, only one box is visible - infer mode from it. In pinned mode
// both boxes exist simultaneously, so there's no single "active" tab; keep
// whatever the panel last had selected. Character boxes never rename their
// class between modes, so for those we always trust our own tracked state.
function getActivePromptMode(target) {
  if (target !== 'base') return currentPromptMode;
  const boxes = getVisibleBasePromptBoxes();
  if (boxes.length === 1) {
    return /undesired-content/.test(boxes[0].className) ? 'negative' : 'positive';
  }
  return currentPromptMode;
}

function getBaseTabButton(mode) {
  const container = document.querySelector('.image-gen-prompt-main');
  if (!container) return null;
  const buttons = Array.from(container.querySelectorAll('button'));
  const matches = buttons.filter((b) => {
    const t = b.textContent.trim();
    return mode === 'negative' ? t === 'Undesired Content' : t === 'Prompt' || t === 'Base Prompt';
  });
  return matches.find((b) => b.offsetParent !== null) || null;
}

function getCharacterTabButton(index, mode) {
  const container = getCharacterContainer(index);
  if (!container) return null;
  const buttons = Array.from(container.querySelectorAll('button'));
  const matches = buttons.filter((b) => {
    const t = b.textContent.trim();
    return mode === 'negative' ? t === 'Undesired Content' : t === 'Prompt';
  });
  return matches.find((b) => b.offsetParent !== null) || null;
}

function switchToPromptMode(target, mode) {
  if (target === 'base') {
    const boxes = getVisibleBasePromptBoxes();
    if (boxes.length >= 2) return true; // pinned: both already visible, nothing to click
    if (boxes.length === 1) {
      const isNegative = /undesired-content/.test(boxes[0].className);
      if ((isNegative ? 'negative' : 'positive') === mode) return true;
      const btn = getBaseTabButton(mode);
      if (!btn) return false;
      btn.click();
      return true;
    }
    return false;
  }
  const boxes = getVisibleCharacterPromptBoxes(target);
  if (boxes.length >= 2) return true; // pinned: both already visible
  if (boxes.length !== 1) return false;
  // Character boxes can't tell us their current mode from the DOM, so we just
  // click the requested tab every time (a no-op if it's already selected).
  const btn = getCharacterTabButton(target, mode);
  if (!btn) return false;
  btn.click();
  return true;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capturePositiveAndNegative(target) {
  const originalMode = getActivePromptMode(target);
  switchToPromptMode(target, 'positive');
  await delay(80);
  const positiveText = getPromptText(target, 'positive');
  switchToPromptMode(target, 'negative');
  await delay(80);
  const negativeText = getPromptText(target, 'negative');
  switchToPromptMode(target, originalMode);
  await delay(80);
  return { positiveText, negativeText };
}

async function applyPositiveAndNegative(positiveText, negativeText, target) {
  const originalMode = getActivePromptMode(target);
  switchToPromptMode(target, 'positive');
  await delay(80);
  setPromptText(positiveText || '', target, 'positive');
  if (negativeText !== undefined) {
    switchToPromptMode(target, 'negative');
    await delay(80);
    setPromptText(negativeText || '', target, 'negative');
  }
  switchToPromptMode(target, originalMode);
  await delay(80);
}

function getGenerateButton() {
  const buttons = Array.from(document.querySelectorAll('button'));
  const candidates = buttons.filter((b) => /^Generate\b/i.test(b.textContent.trim()));
  return candidates.find((b) => b.offsetParent !== null) || null;
}

let missingGenerateButtonWarned = false;

// 우리가 Generate를 클릭한 시각. 0이면 진행 중인 생성이 없다는 뜻.
// 이 값이 살아있는 동안엔 추가 클릭을 하지 않아 429(Concurrent generation is locked)를 막는다.
let generationInFlightSince = 0;
const GENERATION_TIMEOUT_MS = 90000; // 완성 신호가 이만큼 안 오면 실패로 보고 재시도 허용

function tryAutoGenerateClick() {
  if (!settingsCache.autoGenerate) return;
  if (Date.now() < autoGenerateHoldUntil) return;
  if (generationInFlightSince && Date.now() - generationInFlightSince < GENERATION_TIMEOUT_MS) return;
  const btn = getGenerateButton();
  if (btn && !btn.disabled) {
    btn.click();
    generationInFlightSince = Date.now();
    nextGenerateAt = 0; // 이제 생성 중 — 카운트다운 대신 "생성 중" 표시
    missingGenerateButtonWarned = false;
  } else if (!btn && !missingGenerateButtonWarned) {
    missingGenerateButtonWarned = true;
    console.warn('[NovelAI 도우미] Generate 버튼을 찾지 못했어요. NovelAI 페이지 구조가 바뀌었을 수 있어요.');
  }
}

function setPromptText(text, target, mode) {
  const editor = getPromptEditor(target, mode);
  if (!editor) return false;
  editor.focus();
  document.execCommand('selectAll', false, undefined);
  document.execCommand('insertText', false, text);
  return true;
}

function getPromptText(target, mode) {
  const editor = getPromptEditor(target, mode);
  return editor ? editor.textContent : '';
}

function getPromptTags(target, mode) {
  return getPromptText(target, mode)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function addTagToPrompt(tag, target, mode) {
  const current = getPromptText(target, mode);
  const next = current.trim() ? `${current.replace(/\s*$/, '')}, ${tag}` : tag;
  return setPromptText(next, target, mode);
}

// --- 429(Concurrent generation is locked) 감지 & 백오프 ---
// NovelAI가 페이지에 띄우는 에러 문구를 감지하면: 재시도를 점점 길게 미루고(15초→30초),
// 연속 3회면 자동 반복 생성을 스스로 꺼서 서버를 계속 두드리지 않는다 (밴 위험 예방).
let consecutive429 = 0;
let last429At = 0;

function setAutoStatus(text, isError) {
  setInlineStatus('nah-auto-status', text, isError);
}

function onGenerationError() {
  const now = Date.now();
  if (now - last429At < 3000) return; // 같은 토스트가 여러 노드로 잡히는 중복 방지
  last429At = now;
  if (!settingsCache.autoGenerate) return;
  generationInFlightSince = 0; // 그 클릭은 서버가 거절했으므로 진행 중 아님
  consecutive429 += 1;
  clearTimeout(nextGenerateTimer);
  if (consecutive429 >= 3) {
    consecutive429 = 0;
    safeStorageSet({ autoGenerate: false });
    const cb = document.getElementById('nah-auto-generate');
    if (cb) cb.checked = false;
    setAutoStatus('생성 잠금(429)이 연속 3회 발생해 자동 반복 생성을 껐어요. 잠시 후 직접 다시 켜주세요.', true);
    console.warn('[NovelAI 도우미] 429 연속 발생 — 자동 반복 생성을 자동으로 껐어요.');
    return;
  }
  const backoff = 15000 * consecutive429;
  autoGenerateHoldUntil = now + backoff;
  nextGenerateAt = now + backoff + 200;
  nextGenerateTimer = setTimeout(tryAutoGenerateClick, backoff + 200);
  setAutoStatus(`생성 잠금(429) 감지 — ${Math.round(backoff / 1000)}초 쉬었다가 다시 시도해요.`, true);
}

// --- Auto-generate: 폴링 대신 이미지 완성 이벤트(onImageGenerated)를 신호로 다음 생성을 건다.
// 생성이 실패해 이미지가 끝내 안 뜨는 경우를 대비한 저빈도 안전망만 유지한다.
setInterval(tryAutoGenerateClick, 5000);

// --- 다음 생성까지 남은 시간 표시 (0.1초 단위) ---
setInterval(() => {
  const el = document.getElementById('nah-next-gen');
  if (!el) return;
  if (!settingsCache.autoGenerate) {
    if (el.textContent) el.textContent = '';
    return;
  }
  if (generationInFlightSince) {
    el.textContent = '생성 중…';
    return;
  }
  const remain = Math.max(nextGenerateAt, autoGenerateHoldUntil) - Date.now();
  el.textContent = remain > 0 ? `다음 생성 ${(remain / 1000).toFixed(1)}초 전` : '대기 중';
}, 100);

// --- Auto-save ---
function buildFilename() {
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  return `NovelAI/novelai_${stamp}.png`;
}

function trySaveImage(imgEl) {
  if (!settingsCache.autoSave) return;
  const src = imgEl.src;
  if (!src || !src.startsWith('blob:')) return;
  if (savedImageSrcs.has(src)) return;
  savedImageSrcs.add(src);

  fetch(src)
    .then((r) => r.blob())
    .then((blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (!extAlive()) return;
        chrome.runtime.sendMessage({
          type: 'download',
          dataUrl: reader.result,
          filename: buildFilename(),
        });
      };
      reader.readAsDataURL(blob);
    })
    .catch((err) => console.error('[NovelAI 도우미] 이미지 저장 실패', err));
}

const seenGenerationSrcs = new Set();
let lastGeneratedImageSrc = null;

let nextGenerateTimer = null;

function onImageGenerated(imgEl) {
  const src = imgEl.src;
  if (!src || !src.startsWith('blob:')) return;
  if (seenGenerationSrcs.has(src)) return;
  seenGenerationSrcs.add(src);
  lastGeneratedImageSrc = src;
  generationInFlightSince = 0; // 생성 완료 — 다음 클릭 허용
  consecutive429 = 0; // 정상 완성됐으니 429 연속 카운트 리셋
  if (panelEl && !panelEl.classList.contains('nah-hidden')) {
    loadCurrentTags();
  }
  // 방금 생성이 끝났으니, 켜져 있다면 다음 생성을 바로 이어서 건다.
  // 매번 똑같은 간격으로 두드리지 않도록 500~1000ms 사이에서 무작위로 고른다.
  // 한 번의 생성이 이미지 여러 장/중복 이벤트를 낼 수 있으므로 타이머는 항상 1개만 유지한다.
  if (settingsCache.autoGenerate) {
    clearTimeout(nextGenerateTimer);
    const nextDelay = 500 + Math.random() * 500;
    nextGenerateAt = Date.now() + nextDelay;
    nextGenerateTimer = setTimeout(tryAutoGenerateClick, nextDelay);
  }
}

function createThumbnail(blobSrc, maxSize = 320) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = reject;
    img.src = blobSrc;
  });
}

function handleImage(imgEl) {
  trySaveImage(imgEl);
  onImageGenerated(imgEl);
}

function scanForImages(root) {
  root.querySelectorAll('img.image-grid-image').forEach(handleImage);
}

const imageObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.target.matches && m.target.matches('img.image-grid-image')) {
      handleImage(m.target);
    }
    m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      // NovelAI가 띄우는 429 에러 토스트 감지
      if (/(Concurrent generation is locked|Error generating image:\s*429)/i.test(node.textContent || '')) {
        onGenerationError();
      }
      if (node.matches && node.matches('img.image-grid-image')) {
        handleImage(node);
      } else if (node.querySelectorAll) {
        scanForImages(node);
      }
    });
  }
});

imageObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src'],
});

// =====================================================================
// Floating panel UI
// =====================================================================

const PANEL_STYLES = `
#nah-panel {
  position: fixed;
  min-width: 260px;
  min-height: 220px;
  max-width: 90vw;
  max-height: 90vh;
  background: #1b1b2f;
  color: #e6e6f0;
  font-family: "Segoe UI", sans-serif;
  font-size: 13px;
  border: 1px solid #3a3a5c;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  resize: both;
}
#nah-panel.nah-hidden { display: none; }
#nah-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: #262640;
  cursor: move;
  user-select: none;
  border-bottom: 1px solid #3a3a5c;
}
#nah-header .nah-title { font-weight: 600; color: #f5d76e; font-size: 13px; }
#nah-version { font-size: 11px; color: #7a7a99; }
#nah-next-gen { font-size: 11px; color: #f5d76e; }
#nah-close {
  background: transparent;
  border: none;
  color: #b9b9d6;
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
  padding: 2px 6px;
}
#nah-close:hover { color: #fff; }
#nah-body { padding: 12px; overflow-y: auto; flex: 1; min-height: 0; }
#nah-panel .nah-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 0;
  border-bottom: 1px solid #33334d;
}
#nah-panel .nah-row label { cursor: pointer; }
#nah-panel section {
  margin-top: 10px; background: #20203a; border: 1px solid #2c2c48;
  border-radius: 8px; padding: 10px 12px;
}
#nah-panel .nah-section-title {
  font-size: 13px; font-weight: 600; color: #b9b9d6; cursor: pointer;
  user-select: none; display: flex; align-items: center; gap: 6px;
}
#nah-panel .nah-section-title:hover { color: #e6e6f0; }
#nah-panel .nah-chevron { font-size: 10px; color: #7a7a99; width: 10px; display: inline-block; }
#nah-panel .nah-section-body { margin-top: 8px; }
#nah-panel section[data-key] > .nah-section-body.nah-collapsed { display: none; }
#nah-panel .nah-code-area {
  width: 100%; box-sizing: border-box; background: #141425; border: 1px solid #3a3a5c;
  color: #e6e6f0; border-radius: 4px; padding: 6px; font-family: monospace; font-size: 11px;
  resize: vertical; min-height: 56px; margin-top: 6px;
}
#nah-panel .nah-preset-add { display: flex; gap: 6px; margin-bottom: 8px; }
#nah-panel .nah-preset-add input {
  flex: 1; min-width: 0; background: #262640; border: 1px solid #3a3a5c;
  color: #e6e6f0; border-radius: 4px; padding: 5px 7px;
}
#nah-panel .nah-backup-row { display: flex; gap: 6px; }
#nah-panel .nah-backup-hint { margin-top: 6px; font-size: 11px; color: #7a7a99; }
#nah-panel .nah-preset-actions button.nah-thumb-edit { background: #4a4a78; }
#nah-panel .nah-preset-actions button.nah-thumb-edit:hover { background: #5c5c96; }
#nah-panel button {
  background: #4a4a78; color: #fff; border: none; border-radius: 4px;
  padding: 5px 9px; cursor: pointer; font-size: 12px;
}
#nah-panel button:hover { background: #5c5c96; }
#nah-panel .nah-preset-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 0; gap: 6px;
}
#nah-panel .nah-preset-item .nah-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#nah-panel .nah-preset-actions { display: flex; gap: 4px; }
#nah-panel .nah-preset-actions button.nah-apply { background: #3c7a52; }
#nah-panel .nah-preset-actions button.nah-apply:hover { background: #4c9a67; }
#nah-panel .nah-preset-actions button.nah-delete { background: #7a3c3c; }
#nah-panel .nah-preset-actions button.nah-delete:hover { background: #9a4c4c; }
#nah-panel .nah-empty { color: #7a7a99; font-style: italic; padding: 6px 0; }
#nah-panel .nah-status { margin-top: 8px; font-size: 11px; color: #7a7a99; min-height: 14px; }
#nah-panel .nah-inline-status {
  display: none; margin: 6px 0 2px; padding: 6px 9px; border-radius: 5px;
  font-size: 12px; line-height: 1.4;
}
#nah-panel .nah-inline-status.nah-error {
  display: block; background: #3a1c1c; border: 1px solid #9a4c4c; color: #f0997b; font-weight: 600;
}
#nah-panel .nah-inline-status.nah-info {
  display: block; background: #1c2e24; border: 1px solid #3c7a52; color: #7bd8a5;
}
#nah-panel input[type="checkbox"] { width: 16px; height: 16px; }
#nah-panel .nah-tag-list { display: flex; flex-wrap: wrap; gap: 6px; }
#nah-panel .nah-tag-chip {
  display: flex; align-items: center; gap: 6px; background: #262640;
  border: 1px solid #3a3a5c; border-radius: 14px; padding: 3px 4px 3px 10px; max-width: 100%;
}
#nah-panel .nah-tag-chip .nah-text {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px;
}
#nah-panel .nah-tag-chip button { padding: 2px 7px; border-radius: 10px; font-size: 11px; line-height: 1.4; }
#nah-panel .nah-tag-chip button.nah-add { background: #3c7a52; }
#nah-panel .nah-tag-chip button.nah-add:hover { background: #4c9a67; }
#nah-panel .nah-tag-chip button.nah-remove { background: #7a3c3c; }
#nah-panel .nah-tag-chip button.nah-remove:hover { background: #9a4c4c; }
#nah-panel .nah-section-header {
  display: flex; align-items: center; justify-content: space-between;
}
#nah-current-tags {
  max-height: 260px; overflow-y: auto; padding-right: 2px; align-content: flex-start;
}
#nah-current-tags .nah-tag-chip {
  padding: 3px 10px; cursor: pointer; user-select: none;
}
#nah-current-tags .nah-tag-chip .nah-text { max-width: 220px; }
#nah-current-tags .nah-tag-chip.nah-dragging { opacity: 0.4; }
#nah-current-tags .nah-tag-chip.nah-drag-over-left { box-shadow: inset 2px 0 0 0 #f5d76e; }
#nah-current-tags .nah-tag-chip.nah-drag-over-right { box-shadow: inset -2px 0 0 0 #f5d76e; }
#nah-current-tags .nah-tag-chip.nah-selected { border-color: #f5d76e; background: #33334d; }
#nah-current-tags .nah-tag-chip.nah-weight-up { background: #3a2318; border-color: #8a4a2c; }
#nah-current-tags .nah-tag-chip.nah-weight-up .nah-text { color: #f0997b; }
#nah-current-tags .nah-tag-chip.nah-weight-down { background: #16283a; border-color: #2c5a8a; }
#nah-current-tags .nah-tag-chip.nah-weight-down .nah-text { color: #85b7eb; }
#nah-current-tags .nah-tag-chip.nah-weight-up.nah-selected,
#nah-current-tags .nah-tag-chip.nah-weight-down.nah-selected { border-color: #f5d76e; }
#nah-panel .nah-tag-toolbar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
#nah-panel .nah-tag-toolbar input[type="text"] {
  flex: 1; min-width: 0; background: #262640; border: 1px solid #3a3a5c;
  color: #e6e6f0; border-radius: 4px; padding: 4px 7px; font-size: 12px;
}
#nah-panel .nah-tag-toolbar label {
  display: flex; align-items: center; gap: 4px; font-size: 11px; color: #b9b9d6;
  cursor: pointer; white-space: nowrap;
}
#nah-panel .nah-tag-toolbar label input { width: 13px; height: 13px; }
#nah-panel .nah-tag-actionbar {
  display: none; align-items: center; gap: 6px; background: #262640;
  border: 1px solid #f5d76e55; border-radius: 6px; padding: 5px 8px; margin-bottom: 8px;
}
#nah-panel .nah-tag-actionbar.nah-visible { display: flex; }
#nah-panel .nah-tag-actionbar .nah-selected-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: #f5d76e;
}
#nah-panel .nah-target-select {
  width: 100%; background: #262640; border: 1px solid #3a3a5c; color: #e6e6f0;
  border-radius: 4px; padding: 5px 7px; margin-bottom: 8px; font-size: 12px;
}
#nah-panel .nah-mode-toggle { display: flex; gap: 6px; margin-bottom: 8px; }
#nah-panel .nah-mode-btn { flex: 1; background: #262640; border: 1px solid #3a3a5c; }
#nah-panel .nah-mode-btn:hover { background: #33334d; }
#nah-panel .nah-mode-btn.nah-active { background: #4a4a78; border-color: #5c5c96; font-weight: 600; }
#nah-panel .nah-mode-badge {
  font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 8px; flex-shrink: 0;
}
#nah-panel .nah-mode-badge-positive { background: #3c7a52; color: #fff; }
#nah-panel .nah-mode-badge-negative { background: #7a3c3c; color: #fff; }
#nah-panel .nah-scope-badge-base { background: #3c5a7a; color: #fff; }
#nah-panel .nah-scope-badge-character { background: #7a5a3c; color: #fff; }
#nah-thumb-preview {
  position: fixed; display: none; max-width: 320px; max-height: 320px;
  border: 1px solid #3a3a5c; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  z-index: 2147483647; pointer-events: none; background: #000;
}
`;

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = PANEL_STYLES;
  document.head.appendChild(style);
}

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'nah-panel';
  panel.className = 'nah-hidden';
  panel.innerHTML = `
    <div id="nah-header">
      <span class="nah-title">NovelAI 자동화 도우미</span>
      <span style="display:flex; align-items:center; gap:4px;">
        <span id="nah-version"></span>
        <button id="nah-close" title="닫기">×</button>
      </span>
    </div>
    <div id="nah-body">
      <div class="nah-row">
        <label for="nah-auto-generate">자동 반복 생성</label>
        <span style="display:flex; align-items:center; gap:8px;">
          <span id="nah-next-gen"></span>
          <input type="checkbox" id="nah-auto-generate" />
        </span>
      </div>
      <div class="nah-row">
        <label for="nah-auto-save">자동 저장 (다운로드)</label>
        <input type="checkbox" id="nah-auto-save" />
      </div>
      <div class="nah-inline-status" id="nah-auto-status"></div>

      <section data-key="favorites">
        <div class="nah-section-title" data-toggle="favorites"><span class="nah-chevron">▾</span>즐겨찾기 태그</div>
        <div class="nah-section-body">
          <div class="nah-tag-list" id="nah-favorite-tags"></div>
          <div class="nah-inline-status" id="nah-fav-status"></div>
        </div>
      </section>

      <section data-key="currentTags">
        <div class="nah-section-header">
          <div class="nah-section-title" data-toggle="currentTags"><span class="nah-chevron">▾</span>현재 프롬프트 태그</div>
          <button id="nah-refresh-tags">새로고침</button>
        </div>
        <div class="nah-section-body">
          <select id="nah-target-select" class="nah-target-select"></select>
          <div class="nah-mode-toggle">
            <button class="nah-mode-btn" id="nah-mode-positive" data-mode="positive">포지티브</button>
            <button class="nah-mode-btn" id="nah-mode-negative" data-mode="negative">네거티브</button>
          </div>
          <div class="nah-tag-toolbar">
            <input type="text" id="nah-tag-search" placeholder="태그 검색" />
            <label><input type="checkbox" id="nah-weighted-only" />강조만</label>
          </div>
          <div class="nah-tag-actionbar" id="nah-tag-actionbar">
            <span class="nah-selected-name" id="nah-selected-name"></span>
            <button class="nah-add" id="nah-selected-fav">즐겨찾기</button>
            <button class="nah-remove" id="nah-selected-delete">삭제</button>
          </div>
          <div class="nah-tag-list" id="nah-current-tags"></div>
          <div class="nah-inline-status" id="nah-tags-status"></div>
        </div>
      </section>

      <section data-key="presets">
        <div class="nah-section-title" data-toggle="presets"><span class="nah-chevron">▾</span>프롬프트 프리셋 (전체)</div>
        <div class="nah-section-body">
          <div class="nah-preset-add">
            <input type="text" id="nah-preset-name" placeholder="프리셋 이름" />
            <button id="nah-save-preset">현재 프롬프트 저장</button>
          </div>
          <div id="nah-preset-list"></div>
          <div class="nah-inline-status" id="nah-preset-status"></div>
          <input type="file" id="nah-preset-thumb-file" accept="image/*" style="display:none" />
        </div>
      </section>

      <section data-key="backup">
        <div class="nah-section-title" data-toggle="backup"><span class="nah-chevron">▾</span>백업 / 복원</div>
        <div class="nah-section-body">
          <div class="nah-backup-row">
            <button id="nah-export-btn" type="button">코드 생성</button>
            <button id="nah-copy-code-btn" type="button">복사</button>
          </div>
          <textarea id="nah-export-code" class="nah-code-area" readonly placeholder="여기에 백업 코드가 표시돼요"></textarea>
          <div class="nah-backup-hint">이미지 썸네일은 코드에 포함되지 않아요. 프리셋·즐겨찾기 텍스트만 백업됩니다.</div>
          <textarea id="nah-import-code" class="nah-code-area" placeholder="여기에 백업 코드를 붙여넣으세요"></textarea>
          <button id="nah-import-btn" type="button">코드로 가져오기</button>
          <div class="nah-backup-hint">가져오기는 기존 프리셋·즐겨찾기를 지우지 않고 새로 추가만 해요.</div>
          <div class="nah-inline-status" id="nah-backup-status"></div>
        </div>
      </section>

      <div class="nah-status" id="nah-status"></div>
    </div>
  `;
  document.body.appendChild(panel);
  // manifest.json의 version을 그대로 읽어오므로, 버전을 올리면 여기도 자동 반영된다.
  try {
    const versionEl = panel.querySelector('#nah-version');
    if (versionEl && extAlive()) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (e) {
    /* 버전 표시는 실패해도 치명적이지 않음 */
  }
  return panel;
}

function setStatus(text) {
  const statusEl = document.getElementById('nah-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  if (text) setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

// 각 카드(섹션) 안에 표시되는 상태 메시지. 에러는 빨간 강조, 일반 안내는 초록.
// 카드마다 타이머를 따로 관리해 서로 지우지 않게 한다.
const inlineStatusTimers = {};
function setInlineStatus(elId, text, isError) {
  const el = document.getElementById(elId);
  if (!el) return;
  clearTimeout(inlineStatusTimers[elId]);
  el.textContent = text;
  el.className = `nah-inline-status ${isError ? 'nah-error' : 'nah-info'}`;
  inlineStatusTimers[elId] = setTimeout(() => {
    el.textContent = '';
    el.className = 'nah-inline-status';
  }, isError ? 4000 : 3000);
}

function setPresetStatus(text, isError) {
  setInlineStatus('nah-preset-status', text, isError);
}
function setFavStatus(text, isError) {
  setInlineStatus('nah-fav-status', text, isError);
}
function setTagsStatus(text, isError) {
  setInlineStatus('nah-tags-status', text, isError);
}
function setBackupStatus(text, isError) {
  setInlineStatus('nah-backup-status', text, isError);
}

// 저장소(chrome.storage)를 써야 하는 동작 전에 컨텍스트가 살아있는지 확인하고,
// 죽어있으면 해당 카드에 빨간 안내를 띄운다. (확장 리로드 후 탭 미새로고침 상황)
const CONTEXT_DEAD_MSG = '확장 프로그램이 리로드됐어요. 페이지를 새로고침(F5)한 뒤 다시 시도해주세요.';
function guardAlive(statusSetter) {
  if (extAlive()) return true;
  statusSetter(CONTEXT_DEAD_MSG, true);
  return false;
}

// 프리셋 적용/저장 메시지에서 대상 이름을 사람이 읽기 좋게 만든다.
function describeTarget(target) {
  return target === 'base' ? 'Base Prompt' : `캐릭터 ${target}`;
}

let thumbPreviewEl = null;

function ensureThumbPreviewEl() {
  if (thumbPreviewEl) return thumbPreviewEl;
  thumbPreviewEl = document.createElement('img');
  thumbPreviewEl.id = 'nah-thumb-preview';
  document.body.appendChild(thumbPreviewEl);
  return thumbPreviewEl;
}

function showThumbPreview(dataUrl, e) {
  const img = ensureThumbPreviewEl();
  img.src = dataUrl;
  img.style.display = 'block';
  moveThumbPreview(e);
}

function moveThumbPreview(e) {
  if (!thumbPreviewEl || thumbPreviewEl.style.display === 'none') return;
  const pad = 14;
  let left = e.clientX + pad;
  let top = e.clientY + pad;
  if (left + 320 > window.innerWidth) left = e.clientX - 320 - pad;
  if (top + 320 > window.innerHeight) top = e.clientY - 320 - pad;
  thumbPreviewEl.style.left = `${Math.max(0, left)}px`;
  thumbPreviewEl.style.top = `${Math.max(0, top)}px`;
}

function hideThumbPreview() {
  if (thumbPreviewEl) thumbPreviewEl.style.display = 'none';
}

function renderPresets(presets) {
  const listEl = document.getElementById('nah-preset-list');
  listEl.innerHTML = '';
  if (!presets.length) {
    const empty = document.createElement('div');
    empty.className = 'nah-empty';
    empty.textContent = '저장된 프리셋이 없어요.';
    listEl.appendChild(empty);
    return;
  }
  presets.forEach((preset) => {
    const scope = preset.scope === 'character' ? 'character' : 'base';
    const row = document.createElement('div');
    row.className = 'nah-preset-item';

    const scopeBadge = document.createElement('span');
    scopeBadge.className = `nah-mode-badge nah-scope-badge-${scope}`;
    scopeBadge.textContent = scope === 'character' ? 'CHAR' : 'BASE';
    scopeBadge.title =
      scope === 'character'
        ? '캐릭터용 프리셋 — 적용 시 현재 선택된 캐릭터에 들어가요'
        : 'Base Prompt용 프리셋';

    const name = document.createElement('div');
    name.className = 'nah-name';
    name.title = `포지티브: ${preset.text || '(없음)'}\n네거티브: ${preset.negativeText || '(없음)'}`;
    name.textContent = preset.name;

    if (preset.thumbnail) {
      name.addEventListener('mouseenter', (e) => showThumbPreview(preset.thumbnail, e));
      name.addEventListener('mousemove', (e) => moveThumbPreview(e));
      name.addEventListener('mouseleave', hideThumbPreview);
    }

    const actions = document.createElement('div');
    actions.className = 'nah-preset-actions';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'nah-apply';
    applyBtn.textContent = '적용';
    applyBtn.addEventListener('click', async () => {
      if (scope === 'character' && currentPromptTarget === 'base') {
        setPresetStatus('캐릭터용 프리셋이에요. 현재 프롬프트 태그에서 캐릭터를 먼저 선택해주세요.', true);
        return;
      }
      const target = scope === 'character' ? currentPromptTarget : 'base';
      applyBtn.disabled = true;
      try {
        await applyPositiveAndNegative(preset.text, preset.negativeText, target);
        setPresetStatus(`${describeTarget(target)}에 "${preset.name}" 프리셋을 적용했어요.`, false);
        loadCurrentTags();
      } finally {
        applyBtn.disabled = false;
      }
    });

    const thumbBtn = document.createElement('button');
    thumbBtn.className = 'nah-thumb-edit';
    thumbBtn.textContent = '이미지';
    thumbBtn.addEventListener('click', () => {
      thumbEditTargetPresetId = preset.id;
      const input = document.getElementById('nah-preset-thumb-file');
      if (input) input.click();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'nah-delete';
    deleteBtn.textContent = '삭제';
    deleteBtn.addEventListener('click', () => {
      if (!guardAlive(setPresetStatus)) return;
      chrome.storage.local.get(['presets'], (data) => {
        const next = (data.presets || []).filter((p) => p.id !== preset.id);
        chrome.storage.local.set({ presets: next }, () => {
          renderPresets(next);
          setPresetStatus(`"${preset.name}" 프리셋을 삭제했어요.`, false);
        });
      });
    });

    actions.appendChild(applyBtn);
    actions.appendChild(thumbBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(scopeBadge);
    row.appendChild(name);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

function loadPresets() {
  chrome.storage.local.get(['presets'], (data) => renderPresets(data.presets || []));
}

function renderFavoriteTags(favorites) {
  const listEl = document.getElementById('nah-favorite-tags');
  listEl.innerHTML = '';
  if (!favorites.length) {
    const empty = document.createElement('div');
    empty.className = 'nah-empty';
    empty.textContent = '즐겨찾기한 태그가 없어요.';
    listEl.appendChild(empty);
    return;
  }
  favorites.forEach((fav) => {
    const mode = fav.mode === 'negative' ? 'negative' : 'positive';
    const chip = document.createElement('div');
    chip.className = 'nah-tag-chip';

    const badge = document.createElement('span');
    badge.className = `nah-mode-badge nah-mode-badge-${mode}`;
    badge.textContent = mode === 'negative' ? 'N' : 'P';

    const text = document.createElement('span');
    text.className = 'nah-text';
    text.title = fav.tag;
    text.textContent = fav.tag;

    const addBtn = document.createElement('button');
    addBtn.className = 'nah-add';
    addBtn.textContent = '추가';
    addBtn.addEventListener('click', async () => {
      const ok = switchToPromptMode(currentPromptTarget, mode);
      if (!ok) return;
      await delay(80);
      if (addTagToPrompt(fav.tag, currentPromptTarget, mode)) {
        setFavStatus(`${describeTarget(currentPromptTarget)}에 "${fav.tag}" 추가했어요.`, false);
        currentPromptMode = mode;
        loadCurrentTags();
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'nah-remove';
    removeBtn.textContent = '삭제';
    removeBtn.addEventListener('click', () => {
      if (!guardAlive(setFavStatus)) return;
      chrome.storage.local.get(['tagFavorites'], (data) => {
        const next = (data.tagFavorites || []).filter((f) => f.id !== fav.id);
        chrome.storage.local.set({ tagFavorites: next }, () => {
          renderFavoriteTags(next);
          setFavStatus(`"${fav.tag}" 즐겨찾기를 삭제했어요.`, false);
        });
      });
    });

    chip.appendChild(badge);
    chip.appendChild(text);
    chip.appendChild(addBtn);
    chip.appendChild(removeBtn);
    listEl.appendChild(chip);
  });
}

function loadFavoriteTags() {
  chrome.storage.local.get(['tagFavorites'], (data) => renderFavoriteTags(data.tagFavorites || []));
}

function addTagToFavorites(tag, mode) {
  if (!guardAlive(setTagsStatus)) return;
  chrome.storage.local.get(['tagFavorites'], (data) => {
    const favorites = data.tagFavorites || [];
    if (favorites.some((f) => f.tag === tag && (f.mode || 'positive') === mode)) {
      setTagsStatus('이미 즐겨찾기에 있어요.', true);
      return;
    }
    favorites.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, tag, mode });
    chrome.storage.local.set({ tagFavorites: favorites }, () => {
      renderFavoriteTags(favorites);
      setTagsStatus(`"${tag}" 즐겨찾기에 저장했어요.`, false);
    });
  });
}

let currentTagsState = [];
let currentPromptMode = 'positive';
let currentPromptTarget = 'base';
let selectedTagIndex = null; // currentTagsState 기준 인덱스
let tagSearchQuery = '';
let weightedOnlyFilter = false;

// "1.9::trap::" 같은 가중치 문법에서 숫자만 뽑아낸다. 없으면 null.
function parseTagWeight(tag) {
  const m = tag.match(/^(\d+(?:\.\d+)?)\s*::/);
  return m ? parseFloat(m[1]) : null;
}

function isTagFilterActive() {
  return tagSearchQuery.trim() !== '' || weightedOnlyFilter;
}

function updateTagActionBar() {
  const bar = document.getElementById('nah-tag-actionbar');
  const nameEl = document.getElementById('nah-selected-name');
  if (!bar || !nameEl) return;
  const valid = selectedTagIndex !== null && selectedTagIndex < currentTagsState.length;
  bar.classList.toggle('nah-visible', valid);
  nameEl.textContent = valid ? currentTagsState[selectedTagIndex] : '';
  nameEl.title = nameEl.textContent;
}

function applyCurrentTagsToPrompt() {
  setPromptText(currentTagsState.join(', '), currentPromptTarget, currentPromptMode);
}

function moveTag(fromIndex, insertAt) {
  const arr = currentTagsState;
  if (fromIndex < 0 || fromIndex >= arr.length) return;
  const [moved] = arr.splice(fromIndex, 1);
  let insertPos = insertAt;
  if (fromIndex < insertAt) insertPos -= 1;
  insertPos = Math.max(0, Math.min(insertPos, arr.length));
  arr.splice(insertPos, 0, moved);
}

function renderCurrentTags() {
  const listEl = document.getElementById('nah-current-tags');
  listEl.innerHTML = '';
  updateTagActionBar();
  if (!currentTagsState.length) {
    const empty = document.createElement('div');
    empty.className = 'nah-empty';
    empty.textContent = '프롬프트가 비어있어요.';
    listEl.appendChild(empty);
    return;
  }

  // 검색어·강조 필터를 통과한 태그만 보여준다. 원본 순서는 건드리지 않고,
  // 각 칩이 currentTagsState의 몇 번째인지(origIdx)를 기억해 둔다.
  const query = tagSearchQuery.trim().toLowerCase();
  const visible = [];
  currentTagsState.forEach((tag, origIdx) => {
    if (query && !tag.toLowerCase().includes(query)) return;
    if (weightedOnlyFilter) {
      const w = parseTagWeight(tag);
      if (w === null || w <= 1.0) return;
    }
    visible.push({ tag, origIdx });
  });

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'nah-empty';
    empty.textContent = '조건에 맞는 태그가 없어요.';
    listEl.appendChild(empty);
    return;
  }

  // 필터가 걸려 있으면 드래그 정렬은 잠시 끈다 (보이는 순서와 실제 순서가 달라서 헷갈림 방지).
  const dragEnabled = !isTagFilterActive();

  visible.forEach(({ tag, origIdx }) => {
    const chip = document.createElement('div');
    chip.className = 'nah-tag-chip';
    const weight = parseTagWeight(tag);
    if (weight !== null && weight > 1.0) chip.classList.add('nah-weight-up');
    else if (weight !== null && weight < 1.0) chip.classList.add('nah-weight-down');
    if (selectedTagIndex === origIdx) chip.classList.add('nah-selected');
    chip.draggable = dragEnabled;

    chip.addEventListener('click', () => {
      selectedTagIndex = selectedTagIndex === origIdx ? null : origIdx;
      renderCurrentTags();
    });

    if (dragEnabled) {
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(origIdx));
        chip.classList.add('nah-dragging');
      });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('nah-dragging');
        listEl.querySelectorAll('.nah-drag-over-left, .nah-drag-over-right').forEach((el) => {
          el.classList.remove('nah-drag-over-left', 'nah-drag-over-right');
        });
      });
      chip.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const rect = chip.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        chip.classList.toggle('nah-drag-over-left', before);
        chip.classList.toggle('nah-drag-over-right', !before);
      });
      chip.addEventListener('dragleave', () => {
        chip.classList.remove('nah-drag-over-left', 'nah-drag-over-right');
      });
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chip.classList.remove('nah-drag-over-left', 'nah-drag-over-right');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (Number.isNaN(fromIdx)) return;
        const rect = chip.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        selectedTagIndex = null;
        moveTag(fromIdx, before ? origIdx : origIdx + 1);
        applyCurrentTagsToPrompt();
        renderCurrentTags();
      });
    }

    const text = document.createElement('span');
    text.className = 'nah-text';
    text.title = tag;
    text.textContent = tag;

    chip.appendChild(text);
    listEl.appendChild(chip);
  });
}

function updateModeToggleButtons() {
  const positiveBtn = document.getElementById('nah-mode-positive');
  const negativeBtn = document.getElementById('nah-mode-negative');
  if (positiveBtn) positiveBtn.classList.toggle('nah-active', currentPromptMode === 'positive');
  if (negativeBtn) negativeBtn.classList.toggle('nah-active', currentPromptMode === 'negative');
}

function populateTargetSelect() {
  const select = document.getElementById('nah-target-select');
  if (!select) return;
  const options = [{ value: 'base', label: 'Base Prompt' }].concat(
    getCharacterIndices().map((idx) => ({ value: String(idx), label: `Character ${idx}` }))
  );
  const currentValue = currentPromptTarget === 'base' ? 'base' : String(currentPromptTarget);
  const stillValid = options.some((o) => o.value === currentValue);
  select.innerHTML = '';
  options.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  });
  if (!stillValid) currentPromptTarget = 'base';
  select.value = currentPromptTarget === 'base' ? 'base' : String(currentPromptTarget);
}

function loadCurrentTags() {
  populateTargetSelect();
  currentPromptMode = getActivePromptMode(currentPromptTarget);
  currentTagsState = getPromptTags(currentPromptTarget, currentPromptMode);
  selectedTagIndex = null;
  renderCurrentTags();
  updateModeToggleButtons();
}

function loadCurrentTagsWhenReady(maxAttempts = 20, intervalMs = 500) {
  let attempts = 0;
  const tryLoad = () => {
    attempts += 1;
    if (getPromptEditor(currentPromptTarget, currentPromptMode)) {
      loadCurrentTags();
      return;
    }
    if (attempts < maxAttempts) setTimeout(tryLoad, intervalMs);
  };
  tryLoad();
}

function setupCurrentTagsContainer(panel) {
  const listEl = panel.querySelector('#nah-current-tags');
  // 태그를 드래그하는 동안엔 브라우저가 휠 스크롤을 무시하는 경우가 많아서,
  // 휠 이벤트를 직접 받아 컨테이너를 스크롤시켜 준다 (드래그 중이 아닐 때도 자연스럽게 동작).
  listEl.addEventListener('wheel', (e) => {
    if (e.deltaY === 0) return;
    listEl.scrollTop += e.deltaY;
  }, { passive: true });
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(fromIdx)) return;
    selectedTagIndex = null;
    moveTag(fromIdx, currentTagsState.length);
    applyCurrentTagsToPrompt();
    renderCurrentTags();
  });
}

let thumbEditTargetPresetId = null;

// Backup codes are gzip-compressed JSON, base64-encoded, so they paste as one
// short-ish block of text instead of a raw (much longer) JSON dump.
async function compressToCode(obj) {
  const json = JSON.stringify(obj);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function decompressFromCode(code) {
  const binary = atob(code.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function mergePresets(existing, incoming) {
  const existingIds = new Set(existing.map((p) => p.id));
  const merged = existing.slice();
  incoming.forEach((p) => {
    if (!p || typeof p.name !== 'string' || typeof p.text !== 'string') return;
    let id = p.id;
    if (!id || existingIds.has(id)) id = makeId();
    existingIds.add(id);
    merged.push({
      id,
      name: p.name,
      text: p.text,
      negativeText: p.negativeText,
      thumbnail: p.thumbnail || null,
      scope: p.scope === 'character' ? 'character' : 'base',
    });
  });
  return merged;
}

function mergeFavorites(existing, incoming) {
  const key = (f) => `${f.tag}__${f.mode === 'negative' ? 'negative' : 'positive'}`;
  const existingKeys = new Set(existing.map(key));
  const merged = existing.slice();
  incoming.forEach((f) => {
    if (!f || typeof f.tag !== 'string') return;
    const k = key(f);
    if (existingKeys.has(k)) return;
    existingKeys.add(k);
    merged.push({ id: f.id || makeId(), tag: f.tag, mode: f.mode === 'negative' ? 'negative' : 'positive' });
  });
  return merged;
}

function wirePanel(panel) {
  const autoGenerateEl = panel.querySelector('#nah-auto-generate');
  const autoSaveEl = panel.querySelector('#nah-auto-save');
  const presetNameEl = panel.querySelector('#nah-preset-name');
  const savePresetBtn = panel.querySelector('#nah-save-preset');
  const closeBtn = panel.querySelector('#nah-close');
  const refreshTagsBtn = panel.querySelector('#nah-refresh-tags');
  const presetThumbFileInput = panel.querySelector('#nah-preset-thumb-file');
  const exportBtn = panel.querySelector('#nah-export-btn');
  const copyCodeBtn = panel.querySelector('#nah-copy-code-btn');
  const exportCodeArea = panel.querySelector('#nah-export-code');
  const importBtn = panel.querySelector('#nah-import-btn');
  const importCodeArea = panel.querySelector('#nah-import-code');

  setupCurrentTagsContainer(panel);

  presetThumbFileInput.addEventListener('change', async () => {
    const file = presetThumbFileInput.files[0];
    presetThumbFileInput.value = '';
    const targetId = thumbEditTargetPresetId;
    thumbEditTargetPresetId = null;
    if (!file || !targetId) return;
    const objectUrl = URL.createObjectURL(file);
    let thumbnail;
    try {
      thumbnail = await createThumbnail(objectUrl);
    } catch (err) {
      setPresetStatus('이미지를 불러오지 못했어요.', true);
      URL.revokeObjectURL(objectUrl);
      return;
    }
    URL.revokeObjectURL(objectUrl);
    chrome.storage.local.get(['presets'], (data) => {
      const presets = data.presets || [];
      const idx = presets.findIndex((p) => p.id === targetId);
      if (idx === -1) return;
      presets[idx] = { ...presets[idx], thumbnail };
      chrome.storage.local.set({ presets }, () => {
        renderPresets(presets);
        setPresetStatus('프리셋 이미지가 변경됐어요.', false);
      });
    });
  });

  exportBtn.addEventListener('click', async () => {
    if (!guardAlive(setBackupStatus)) return;
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(['presets', 'tagFavorites'], resolve);
    });
    const presets = (data.presets || []).map((p) => ({
      id: p.id,
      name: p.name,
      text: p.text,
      negativeText: p.negativeText,
      scope: p.scope === 'character' ? 'character' : 'base',
    }));
    const payload = { presets, tagFavorites: data.tagFavorites || [] };
    try {
      exportCodeArea.value = await compressToCode(payload);
      setBackupStatus('코드 생성 완료 (이미지는 제외됨)', false);
    } catch (err) {
      setBackupStatus('코드 생성에 실패했어요.', true);
    }
  });

  copyCodeBtn.addEventListener('click', async () => {
    if (!exportCodeArea.value) {
      setBackupStatus('먼저 코드 생성을 눌러주세요.', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(exportCodeArea.value);
      setBackupStatus('클립보드에 복사했어요.', false);
    } catch (err) {
      exportCodeArea.select();
      setBackupStatus('복사가 안 되면 직접 선택해서 Ctrl+C 해주세요.', true);
    }
  });

  importBtn.addEventListener('click', async () => {
    if (!guardAlive(setBackupStatus)) return;
    const code = importCodeArea.value.trim();
    if (!code) {
      setBackupStatus('붙여넣은 코드가 없어요.', true);
      return;
    }
    let parsed;
    try {
      parsed = await decompressFromCode(code);
    } catch (err) {
      setBackupStatus('코드를 읽을 수 없어요 (형식 오류).', true);
      return;
    }
    const incomingPresets = Array.isArray(parsed.presets) ? parsed.presets : [];
    const incomingFavorites = Array.isArray(parsed.tagFavorites) ? parsed.tagFavorites : [];
    chrome.storage.local.get(['presets', 'tagFavorites'], (data) => {
      const presets = mergePresets(data.presets || [], incomingPresets);
      const tagFavorites = mergeFavorites(data.tagFavorites || [], incomingFavorites);
      chrome.storage.local.set({ presets, tagFavorites }, () => {
        renderPresets(presets);
        renderFavoriteTags(tagFavorites);
        importCodeArea.value = '';
        setBackupStatus(`가져오기 완료 (프리셋 +${incomingPresets.length}, 즐겨찾기 +${incomingFavorites.length})`, false);
      });
    });
  });

  chrome.storage.local.get(['autoGenerate', 'autoSave'], (data) => {
    autoGenerateEl.checked = !!data.autoGenerate;
    autoSaveEl.checked = !!data.autoSave;
  });

  autoGenerateEl.addEventListener('change', () => {
    chrome.storage.local.set({ autoGenerate: autoGenerateEl.checked });
  });
  autoSaveEl.addEventListener('change', () => {
    chrome.storage.local.set({ autoSave: autoSaveEl.checked });
  });

  savePresetBtn.addEventListener('click', async () => {
    if (!guardAlive(setPresetStatus)) return;
    const name = presetNameEl.value.trim();
    if (!name) {
      setPresetStatus('프리셋 이름을 입력해주세요.', true);
      presetNameEl.focus();
      return;
    }
    const scope = currentPromptTarget === 'base' ? 'base' : 'character';
    savePresetBtn.disabled = true;
    try {
      const { positiveText, negativeText } = await capturePositiveAndNegative(currentPromptTarget);
      if (!positiveText && !negativeText) {
        setPresetStatus('현재 프롬프트가 비어있어요.', true);
        return;
      }
      let thumbnail = null;
      if (lastGeneratedImageSrc) {
        try {
          thumbnail = await createThumbnail(lastGeneratedImageSrc);
        } catch (err) {
          thumbnail = null;
        }
      }
      const presets = await new Promise((resolve) => {
        chrome.storage.local.get(['presets'], (data) => resolve(data.presets || []));
      });
      presets.push({
        id: makeId(),
        name,
        text: positiveText,
        negativeText,
        thumbnail,
        scope,
      });
      await new Promise((resolve) => chrome.storage.local.set({ presets }, resolve));
      renderPresets(presets);
      presetNameEl.value = '';
      setPresetStatus(`"${name}" 저장됨 (${scope === 'character' ? '캐릭터용' : 'Base용'})`, false);
    } finally {
      savePresetBtn.disabled = false;
    }
  });

  refreshTagsBtn.addEventListener('click', loadCurrentTags);
  closeBtn.addEventListener('click', () => togglePanel(false));

  // 태그 검색 / 강조만 보기 / 선택 태그 액션 바
  panel.querySelector('#nah-tag-search').addEventListener('input', (e) => {
    tagSearchQuery = e.target.value;
    renderCurrentTags();
  });
  panel.querySelector('#nah-weighted-only').addEventListener('change', (e) => {
    weightedOnlyFilter = e.target.checked;
    renderCurrentTags();
  });
  panel.querySelector('#nah-selected-fav').addEventListener('click', () => {
    if (selectedTagIndex === null || selectedTagIndex >= currentTagsState.length) return;
    addTagToFavorites(currentTagsState[selectedTagIndex], currentPromptMode);
  });
  panel.querySelector('#nah-selected-delete').addEventListener('click', () => {
    if (selectedTagIndex === null || selectedTagIndex >= currentTagsState.length) return;
    const tag = currentTagsState[selectedTagIndex];
    currentTagsState.splice(selectedTagIndex, 1);
    selectedTagIndex = null;
    applyCurrentTagsToPrompt();
    renderCurrentTags();
    setTagsStatus(`"${tag}" 삭제했어요.`, false);
  });

  panel.querySelector('#nah-mode-positive').addEventListener('click', async () => {
    if (!switchToPromptMode(currentPromptTarget, 'positive')) return;
    currentPromptMode = 'positive';
    await delay(80);
    loadCurrentTags();
  });
  panel.querySelector('#nah-mode-negative').addEventListener('click', async () => {
    if (!switchToPromptMode(currentPromptTarget, 'negative')) return;
    currentPromptMode = 'negative';
    await delay(80);
    loadCurrentTags();
  });
  panel.querySelector('#nah-target-select').addEventListener('change', async (e) => {
    const value = e.target.value;
    currentPromptTarget = value === 'base' ? 'base' : Number(value);
    if (!switchToPromptMode(currentPromptTarget, currentPromptMode)) return;
    await delay(80);
    loadCurrentTags();
  });

  loadPresets();
  loadFavoriteTags();
  loadCurrentTagsWhenReady();
}

// --- Dragging ---
function makeDraggable(panel) {
  const header = panel.querySelector('#nah-header');
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'nah-close') return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let left = startLeft + dx;
    let top = startTop + dy;
    const maxLeft = window.innerWidth - panel.offsetWidth;
    const maxTop = window.innerHeight - 40;
    left = Math.max(0, Math.min(left, maxLeft));
    top = Math.max(0, Math.min(top, maxTop));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    safeStorageSet({
      panelPosition: { top: parseInt(panel.style.top, 10), left: parseInt(panel.style.left, 10) },
    });
  });
}

function restorePosition(panel) {
  chrome.storage.local.get(['panelPosition'], (data) => {
    const pos = data.panelPosition;
    if (pos && Number.isFinite(pos.top) && Number.isFinite(pos.left)) {
      panel.style.top = `${pos.top}px`;
      panel.style.left = `${pos.left}px`;
    } else {
      panel.style.top = '80px';
      panel.style.left = `${Math.max(0, window.innerWidth - 320)}px`;
    }
  });
}

function restoreSize(panel) {
  chrome.storage.local.get(['panelSize'], (data) => {
    const size = data.panelSize;
    if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
      panel.style.width = `${size.width}px`;
      panel.style.height = `${size.height}px`;
    } else {
      panel.style.width = '300px';
      panel.style.height = '520px';
    }
  });
}

function watchResize(panel) {
  let saveTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const width = Math.round(panel.offsetWidth);
      const height = Math.round(panel.offsetHeight);
      if (width <= 0 || height <= 0) return; // panel hidden (display:none)
      safeStorageSet({ panelSize: { width, height } });
    }, 300);
  });
  ro.observe(panel);
}

function setupCollapsibleSections(panel) {
  const toggles = Array.from(panel.querySelectorAll('[data-toggle]'));
  chrome.storage.local.get(['sectionCollapsed'], (data) => {
    const collapsed = data.sectionCollapsed || {};

    const applyState = (toggle, isCollapsed) => {
      const body = toggle.closest('section').querySelector('.nah-section-body');
      const chevron = toggle.querySelector('.nah-chevron');
      if (body) body.classList.toggle('nah-collapsed', isCollapsed);
      if (chevron) chevron.textContent = isCollapsed ? '▸' : '▾';
    };

    toggles.forEach((toggle) => {
      const key = toggle.dataset.toggle;
      applyState(toggle, !!collapsed[key]);
      toggle.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        collapsed[key] = !collapsed[key];
        applyState(toggle, collapsed[key]);
        safeStorageSet({ sectionCollapsed: collapsed });
      });
    });
  });
}

let panelEl = null;

function togglePanel(forceState) {
  if (!panelEl) return;
  const shouldShow = forceState !== undefined ? forceState : panelEl.classList.contains('nah-hidden');
  panelEl.classList.toggle('nah-hidden', !shouldShow);
  safeStorageSet({ panelVisible: shouldShow });
  if (shouldShow) loadCurrentTagsWhenReady();
}

function initPanel() {
  injectStyles();
  panelEl = buildPanel();
  restorePosition(panelEl);
  restoreSize(panelEl);
  makeDraggable(panelEl);
  watchResize(panelEl);
  setupCollapsibleSections(panelEl);
  wirePanel(panelEl);

  chrome.storage.local.get(['panelVisible'], (data) => {
    if (data.panelVisible) togglePanel(true);
  });
}

if (document.body) {
  initPanel();
} else {
  document.addEventListener('DOMContentLoaded', initPanel);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return; // 다른 확장/웹페이지발 메시지 무시
  if (msg.type === 'togglePanel') togglePanel();
});
