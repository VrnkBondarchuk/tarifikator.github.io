const demoForm = document.querySelector('.demo__form');
const demoEmail = demoForm.querySelector('[name="email"]');
const personalDataConsent = demoForm.querySelector('[name="personal-data-consent"]');
const demoConsent = demoForm.querySelector('[name="marketing-consent"]');
const demoButton = demoForm.querySelector('button[type="submit"]');
const demoError = demoForm.querySelector('#demo-email-error');
const consentError = demoForm.querySelector('#demo-consent-error');
const demoResult = demoForm.querySelector('.demo__result');
let sending = false;
let cooldownUntil = 0;
let cooldownEmail = '';
let cooldownMessage = '';
let cooldownTimer;

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
    demoResult.textContent = demoEmail.value.trim().toLowerCase() === cooldownEmail ? cooldownMessage : '';
    updateButton();
    return;
  }
  demoResult.textContent = demoEmail.value.trim().toLowerCase() === cooldownEmail
    ? `${cooldownMessage ? cooldownMessage + ' ' : ''}Повторить для этого адреса можно через ${seconds} сек.` : '';
  updateButton();
}
function startCooldown(message, seconds) {
  cooldownEmail = demoEmail.value.trim().toLowerCase();
  cooldownUntil = Date.now() + seconds * 1000;
  cooldownMessage = message;
  clearInterval(cooldownTimer);
  showCooldown();
  cooldownTimer = setInterval(showCooldown, 1000);
}

function validEmail() {
  const value = demoEmail.value.trim();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
function updateButton() {
  const coolingDown = demoEmail.value.trim().toLowerCase() === cooldownEmail && Date.now() < cooldownUntil;
  demoButton.disabled = sending || coolingDown;
  demoButton.setAttribute('aria-disabled', String(demoButton.disabled));
  demoButton.textContent = sending ? 'Отправляем…' : 'Получить доступ';
}
personalDataConsent.addEventListener('change', () => {
  if (personalDataConsent.checked) clearConsentError();
});
demoEmail.addEventListener('input', () => {
  clearEmailError();
  demoResult.textContent = '';
  if (cooldownUntil > Date.now()) showCooldown();
  updateButton();
});
demoEmail.addEventListener('focus', () => {
  clearEmailError();
});
demoForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;
  const emailIsValid = validEmail();
  if (!emailIsValid && document.activeElement !== demoEmail) showEmailError();
  if (!personalDataConsent.checked) showConsentError();
  if (!emailIsValid || !personalDataConsent.checked) return;
  if (demoEmail.value.trim().toLowerCase() === cooldownEmail && Date.now() < cooldownUntil) return;
  sending = true;
  clearEmailError();
  clearConsentError();
  demoResult.textContent = '';
  updateButton();
  try {
    const response = await fetch('/api/demo-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: demoEmail.value.trim(), personalDataConsent: personalDataConsent.checked, marketingConsent: demoConsent.checked })
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (response.status === 202) {
      startCooldown('Заявка принята. Письмо с доступом придёт на указанную почту в ближайшие минуты.', 60);
    } else if (response.status === 429) {
      const seconds = Math.max(1, Number(result.retryAfter) || 60);
      startCooldown('', seconds);
    } else if (response.status === 422) {
      if (result.error === 'consent_required') showConsentError();
      else if (document.activeElement !== demoEmail) showEmailError();
    } else {
      demoResult.textContent = 'Не удалось отправить заявку. Попробуйте ещё раз.';
    }
  } catch {
    demoResult.textContent = 'Нет связи с сервером. Попробуйте ещё раз.';
  } finally {
    sending = false;
    updateButton();
  }
});
updateButton();
