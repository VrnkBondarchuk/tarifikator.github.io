const metrikaScript = document.querySelector('script[data-metrika-id]');
const metrikaId = metrikaScript?.dataset.metrikaId?.trim() || '';

if (/^[1-9]\d*$/.test(metrikaId)) {
  const consentPanel = document.querySelector('#analytics-consent');
  const consentKey = `tarifikator:metrika-consent:v1:${metrikaId}`;
  const disableFlag = `disableYaCounter${metrikaId}`;
  const footerLabel = document.querySelector('.site-footer__legal span:last-child');
  let counterStarted = false;
  let scriptInjected = false;

  const readChoice = () => {
    try { return localStorage.getItem(consentKey); } catch { return null; }
  };
  const saveChoice = choice => {
    try { localStorage.setItem(consentKey, choice); } catch {}
  };
  const showPanel = () => { consentPanel.hidden = false; };
  const hidePanel = () => { consentPanel.hidden = true; };

  function startCounter() {
    if (counterStarted) return;
    window[disableFlag] = false;
    if (!scriptInjected) {
      (function (m, e, t, r, i, k, a) {
        m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
        m[i].l = Date.now();
        k = e.createElement(t);
        a = e.getElementsByTagName(t)[0];
        k.async = true;
        k.src = r;
        a.parentNode.insertBefore(k, a);
      })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
      scriptInjected = true;
    }
    window.ym(Number(metrikaId), 'init', {
      clickmap: false,
      trackLinks: false,
      accurateTrackBounce: false,
      webvisor: false
    });
    counterStarted = true;
  }

  function stopCounter() {
    window[disableFlag] = true;
    if (counterStarted && typeof window.ym === 'function') {
      window.ym(Number(metrikaId), 'destruct');
    }
    counterStarted = false;
  }

  const settingsButton = document.createElement('button');
  settingsButton.type = 'button';
  settingsButton.className = 'site-footer__cookie-settings';
  settingsButton.textContent = footerLabel.textContent;
  settingsButton.addEventListener('click', showPanel);
  footerLabel.replaceWith(settingsButton);

  consentPanel.addEventListener('click', event => {
    const choice = event.target.closest('[data-analytics-choice]')?.dataset.analyticsChoice;
    if (!choice) return;
    if (choice === 'allow') {
      saveChoice('allow');
      hidePanel();
      startCounter();
    } else {
      saveChoice('deny');
      stopCounter();
      hidePanel();
    }
  });

  if (readChoice() === 'allow') startCounter();
  else {
    window[disableFlag] = true;
    if (readChoice() !== 'deny') showPanel();
  }
}
