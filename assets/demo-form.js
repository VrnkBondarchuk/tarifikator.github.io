const demoForm = document.querySelector('.demo__form');
const demoEmail = demoForm.querySelector('[name="email"]');
const personalDataConsent = demoForm.querySelector('[name="personal-data-consent"]');
const demoConsent = demoForm.querySelector('[name="marketing-consent"]');
const demoButton = demoForm.querySelector('button[type="submit"]');
const demoError = demoForm.querySelector('#demo-email-error');
const consentError = demoForm.querySelector('#demo-consent-error');
const demoResult = demoForm.querySelector('.demo__result');
const demoPanel = demoForm.closest('.demo__panel');
const demoSpinner = demoButton.querySelector('.demo__spinner');
const demoSuccess = demoPanel.querySelector('.demo__success');
let sending = false;
let cooldownUntil = 0;
let cooldownEmail = '';
let cooldownTimer;

function setState(state) {
  demoForm.dataset.state = state;
  demoPanel.dataset.state = state;
  demoForm.setAttribute('aria-busy', String(state === 'loading'));
  demoEmail.disabled = state === 'loading';
  personalDataConsent.disabled = state === 'loading';
  demoConsent.disabled = state === 'loading';
  demoSpinner.hidden = state !== 'loading';
  if (state === 'loading') demoButton.setAttribute('aria-label', 'Отправка заявки');
  else demoButton.removeAttribute('aria-label');
  demoForm.hidden = state === 'success';
  demoSuccess.hidden = state !== 'success';
}

function clearEmailError() {
  demoError.replaceChildren();
  demoEmail.removeAttribute('aria-invalid');
}
function showEmailError() {
  demoError.textContent = 'Введите адрес почты в формате name@example.ru';
  demoEmail.setAttribute('aria-invalid', 'true');
}
function clearConsentError() {
  consentError.textContent = '';
  personalDataConsent.removeAttribute('aria-invalid');
}
function showConsentError() {
  consentError.textContent = 'Отметьте согласие на обработку персональных данных.';
  personalDataConsent.setAttribute('aria-invalid', 'true');
}

function showCooldown() {
  const seconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
  if (seconds <= 0) {
    clearInterval(cooldownTimer);
    cooldownTimer = undefined;
    demoResult.textContent = '';
    setState('idle');
    updateButton();
    return;
  }
  demoResult.textContent = demoEmail.value.trim().toLowerCase() === cooldownEmail
    ? `Повторить для этого адреса можно через ${seconds} сек.` : '';
  if (demoResult.textContent) setState('error');
  updateButton();
}
function startCooldown(seconds) {
  cooldownEmail = demoEmail.value.trim().toLowerCase();
  cooldownUntil = Date.now() + seconds * 1000;
  clearInterval(cooldownTimer);
  showCooldown();
  cooldownTimer = setInterval(showCooldown, 1000);
}

function showSubmitError() {
  demoResult.textContent = 'Не удалось отправить заявку. Попробуйте ещё раз.';
  setState('error');
}

function validEmail() {
  const value = demoEmail.value.trim();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
function updateButton() {
  const coolingDown = demoEmail.value.trim().toLowerCase() === cooldownEmail && Date.now() < cooldownUntil;
  demoButton.disabled = sending || coolingDown;
  demoButton.setAttribute('aria-disabled', String(demoButton.disabled));
}
personalDataConsent.addEventListener('change', () => {
  if (personalDataConsent.checked) clearConsentError();
});
demoEmail.addEventListener('input', () => {
  clearEmailError();
  demoResult.textContent = '';
  if (!sending) setState('idle');
  if (cooldownUntil > Date.now()) showCooldown();
  updateButton();
});
demoEmail.addEventListener('focus', () => {
  clearEmailError();
});
demoForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;
  demoResult.textContent = '';
  setState('idle');
  const emailIsValid = validEmail();
  if (!emailIsValid && document.activeElement !== demoEmail) showEmailError();
  if (!personalDataConsent.checked) showConsentError();
  if (!emailIsValid || !personalDataConsent.checked) return;
  if (demoEmail.value.trim().toLowerCase() === cooldownEmail && Date.now() < cooldownUntil) return;
  sending = true;
  clearEmailError();
  clearConsentError();
  setState('loading');
  updateButton();
  try {
    const response = await fetch('/api/demo-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: demoEmail.value.trim(), personalDataConsent: personalDataConsent.checked, marketingConsent: demoConsent.checked })
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (response.status === 202) {
      setState('success');
    } else if (response.status === 429) {
      const seconds = Math.max(1, Number(result.retryAfter) || 60);
      startCooldown(seconds);
    } else if (response.status === 422) {
      setState('idle');
      if (result.error === 'consent_required') showConsentError();
      else if (document.activeElement !== demoEmail) showEmailError();
    } else {
      showSubmitError();
    }
  } catch {
    showSubmitError();
  } finally {
    sending = false;
    if (demoForm.dataset.state === 'loading') setState('idle');
    updateButton();
  }
});
setState('idle');
updateButton();
