const metrikaId = document.currentScript?.dataset.metrikaId?.trim() || '';

if (/^[1-9]\d*$/.test(metrikaId)) {
  const consentPanel = document.querySelector('#analytics-consent');
  const consentKey = `tarifikator:metrika-consent:v1:${metrikaId}`;
  const disableFlag = `disableYaCounter${metrikaId}`;
  const consentButton = consentPanel.querySelector('.analytics-consent__allow');
  let counterStarted = false;

  const readChoice = () => {
    try { return localStorage.getItem(consentKey); } catch { return null; }
  };
  function startCounter() {
    if (counterStarted) return;
    window[disableFlag] = false;
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = Date.now();
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://mc.yandex.ru/metrika/tag.js';
    document.head.append(script);
    window.ym(Number(metrikaId), 'init', {
      clickmap: false,
      trackLinks: false,
      accurateTrackBounce: false,
      webvisor: false
    });
    counterStarted = true;
  }

  consentButton.addEventListener('click', () => {
    try { localStorage.setItem(consentKey, 'allow'); } catch {}
    consentPanel.hidden = true;
    startCounter();
  });

  if (readChoice() === 'allow') startCounter();
  else {
    window[disableFlag] = true;
    consentPanel.hidden = false;
  }
}
