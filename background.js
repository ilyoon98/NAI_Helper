// NovelAI 자동화 도우미 - background service worker

// filename은 buildFilename()이 항상 "NovelAI/novelai_<timestamp>.png" 형태로만
// 만들어내지만, 메시지 발신자를 신뢰하지 않는 방어적 차원에서 형식을 한 번 더 검증한다.
const SAFE_FILENAME_RE = /^NovelAI\/novelai_\d{8}_\d{6}\.png$/;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return; // 다른 확장/웹페이지발 메시지 무시
  if (msg.type !== 'download') return;
  if (typeof msg.dataUrl !== 'string' || !msg.dataUrl.startsWith('data:image/')) return;
  if (typeof msg.filename !== 'string' || !SAFE_FILENAME_RE.test(msg.filename)) return;

  chrome.downloads.download({
    url: msg.dataUrl,
    filename: msg.filename,
    saveAs: false,
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' });
});
