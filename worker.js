// 자동 편성은 시간이 걸려서 화면이 멈추지 않게 따로 돌립니다.
importScripts('core.js');
self.onmessage = e => {
  const { input, seconds } = e.data;
  try {
    const res = generateRoster(input, seconds);
    self.postMessage({ ok: true, codes: res.codes, free: res.free, penalty: res.penalty, iterations: res.iterations });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
