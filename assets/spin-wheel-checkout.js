const CONFIG = {
  pollInterval: 1000,
  pollTimeout: 120000,
  popupReadyTimeout: 5000,
  claimClickInterval: 1500,
  rewardStorageKey: 'popupboost_spin_wheel_reward_claimed',
  completedStorageKey: 'popupboost_spin_wheel_completed',
};

let isHandlingCheckout = false;
let popupBoostObserver;
let lastClaimClickAt = 0;

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

function getSpinWheelConfig() {
  return getTheme().spinWheelCheckout || {};
}

function getTheme() {
  if (typeof Theme !== 'undefined') return Theme;

  return window.Theme || {};
}

function isEnabled() {
  return getSpinWheelConfig().enabled !== false;
}

function getCartStateUrl() {
  const cartUrl = getTheme().routes?.cart_url || '/cart';
  return `${cartUrl.replace(/\/$/, '')}.js`;
}

async function getCart() {
  const response = await fetch(getCartStateUrl(), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Unable to load cart state.');
  }

  return response.json();
}

function getDiscountCodes(cart) {
  const cartLevelCodes = (cart.cart_level_discount_applications || []).map((discount) => discount.title);
  const ajaxDiscountCodes = (cart.discount_codes || []).map((discount) => discount.code);
  const lineDiscountCodes = (cart.items || []).flatMap((item) =>
    (item.line_level_discount_allocations || []).map((allocation) => allocation.discount_application?.title)
  );

  return [...cartLevelCodes, ...ajaxDiscountCodes, ...lineDiscountCodes].filter(Boolean).sort();
}

function getCartSignature(cart) {
  return {
    itemCount: Number(cart.item_count || 0),
    totalDiscount: Number(cart.total_discount || 0),
    itemKeys: (cart.items || []).map((item) => item.key).sort(),
    discounts: getDiscountCodes(cart),
  };
}

function hasRewardApplied(cart, baseline) {
  const current = getCartSignature(cart);
  const previous = getCartSignature(baseline);

  if (current.itemCount > previous.itemCount) return true;

  const newItemAdded = current.itemKeys.some((itemKey) => !previous.itemKeys.includes(itemKey));
  if (newItemAdded) return true;

  return false;
}

function sanitizeStorageKeyPart(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

function getParticipantStorageId() {
  const config = getSpinWheelConfig();

  if (config.customerId) return `customer-${sanitizeStorageKeyPart(config.customerId)}`;
  if (config.autofillEmail) return `email-${sanitizeStorageKeyPart(config.autofillEmail)}`;

  return null;
}

function getScopedStorageKey(storageKey) {
  const participantId = getParticipantStorageId();

  return participantId ? `${storageKey}:${participantId}` : null;
}

function storeRewardSignature(cart) {
  const storageKey = getScopedStorageKey(CONFIG.rewardStorageKey);

  if (!storageKey) return;

  sessionStorage.setItem(storageKey, JSON.stringify(getCartSignature(cart)));
}

function markSpinCompleted(cart) {
  const payload = {
    completedAt: new Date().toISOString(),
    reward: getCartSignature(cart),
  };
  const storageKey = getScopedStorageKey(CONFIG.completedStorageKey);

  if (!storageKey) return;

  try {
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (error) {
    sessionStorage.setItem(storageKey, JSON.stringify(payload));
  }
}

function hasCompletedSpin() {
  const storageKey = getScopedStorageKey(CONFIG.completedStorageKey);

  if (!storageKey) return false;

  try {
    if (localStorage.getItem(storageKey)) return true;
  } catch (error) {
    return Boolean(sessionStorage.getItem(storageKey));
  }

  return Boolean(sessionStorage.getItem(storageKey));
}

function getStoredRewardSignature() {
  const storageKey = getScopedStorageKey(CONFIG.rewardStorageKey);

  if (!storageKey) return null;

  try {
    return JSON.parse(sessionStorage.getItem(storageKey) || 'null');
  } catch (error) {
    return null;
  }
}

function cartMatchesStoredReward(cart) {
  const stored = getStoredRewardSignature();
  if (!stored) return false;

  const current = getCartSignature(cart);
  const hasStoredItem = (stored.itemKeys || []).some((itemKey) => current.itemKeys.includes(itemKey));
  const hasStoredDiscount =
    !stored.discounts?.length || stored.discounts.some((discount) => current.discounts.includes(discount));

  const isMatch = hasStoredItem && hasStoredDiscount && current.itemCount >= stored.itemCount;

  if (!isMatch) {
    const storageKey = getScopedStorageKey(CONFIG.rewardStorageKey);

    if (storageKey) {
      sessionStorage.removeItem(storageKey);
    }
  }

  return isMatch;
}

function setMessage(button, message, type = 'status') {
  const container = button.closest('[data-spin-wheel-checkout]');
  const messageElement = container?.querySelector('[data-spin-wheel-message]');

  if (!messageElement) return;

  messageElement.textContent = message;
  messageElement.dataset.type = type;
  messageElement.hidden = !message;
}

function setLoading(button, isLoading) {
  button.toggleAttribute('aria-busy', isLoading);
}

function getAutofillEmail() {
  const config = getSpinWheelConfig();

  if (config.autofillEmail) return config.autofillEmail;

  return null;
}

function dispatchFieldEvents(input) {
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

function setEmailInputValue(input, email) {
  const inputValueDescriptor = Object.getOwnPropertyDescriptor(input, 'value');
  const prototypeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const valueSetter =
    prototypeValueDescriptor?.set && inputValueDescriptor?.set !== prototypeValueDescriptor.set
      ? prototypeValueDescriptor.set
      : inputValueDescriptor?.set;

  if (valueSetter) {
    valueSetter.call(input, email);
  } else {
    input.value = email;
  }

  input.defaultValue = email;
}

function autofillPopupBoostEmailFields() {
  const email = getAutofillEmail();
  if (!email) return;

  const emailInputs = [
    ...document.querySelectorAll(
      '.pb-modal input[type="email"], .pb-popup input[type="email"], [class*="pb-"] input[type="email"], input[type="email"]'
    ),
  ];

  for (const input of emailInputs) {
    if (!(input instanceof HTMLInputElement)) continue;

    setEmailInputValue(input, email);
    dispatchFieldEvents(input);
  }
}

function getElementText(element) {
  if (element instanceof HTMLInputElement) {
    return element.value || element.getAttribute('aria-label') || element.title || '';
  }

  return element.textContent || element.getAttribute('aria-label') || element.title || '';
}

function isVisibleElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function isPopupBoostElement(element) {
  const root = element.closest(
    '.pb-modal, .pb-popup, .pb-overlay, [class^="pb-"], [class*=" pb-"], [class*="popupboost"], [class*="popup-boost"], [id*="popupboost"], [id*="popup-boost"]'
  );

  if (!(root instanceof HTMLElement)) return false;
  if (root.closest('.pb-teaser')) return false;

  return /spin|wheel|gift|prize|win/i.test(root.textContent || '');
}

function isClaimButton(element) {
  if (!isVisibleElement(element) || !isPopupBoostElement(element)) return false;

  const text = getElementText(element).replace(/\s+/g, ' ').trim();
  if (!text) return false;

  const isClaimAction = /\b(claim|redeem|add\s+to\s+cart|add\s+gift|get\s+(my|your|the)?\s*(gift|prize)|grab\s+(my|your|the)?\s*(gift|prize)|apply\s+(gift|prize|reward))\b/i.test(text);
  const isNotClaimAction = /\b(spin|try\s+again|no\b|not\s+lucky|close|dismiss|checkout)\b/i.test(text);

  return isClaimAction && !isNotClaimAction;
}

function autoClaimPopupBoostPrize() {
  if (Date.now() - lastClaimClickAt < CONFIG.claimClickInterval) return false;

  const claimButton = [
    ...document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'),
  ].find(isClaimButton);

  if (!(claimButton instanceof HTMLElement)) return false;

  lastClaimClickAt = Date.now();
  claimButton.click();

  return true;
}

function runPopupBoostAutomation() {
  autofillPopupBoostEmailFields();
  autoClaimPopupBoostPrize();
}

function startPopupBoostAutofill() {
  runPopupBoostAutomation();

  if (popupBoostObserver) return;

  popupBoostObserver = new MutationObserver(() => {
    runPopupBoostAutomation();
  });

  popupBoostObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

async function waitForPopupBoost() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CONFIG.popupReadyTimeout) {
    if (typeof window.PopupBoost?.open === 'function') return true;
    await sleep(250);
  }

  return false;
}

async function openPopupBoost(sourceButton) {
  startPopupBoostAutofill();

  if (typeof window.PopupBoost?.open === 'function') {
    window.PopupBoost.open();
    setTimeout(runPopupBoostAutomation, 100);
    return true;
  }

  const container = sourceButton?.closest('[data-spin-wheel-checkout]');
  const triggers = [
    ...(container?.querySelectorAll('[data-popupboost-spin-trigger]') || []),
    ...document.querySelectorAll('[data-popupboost-spin-trigger]'),
  ];
  const trigger = triggers.find((element) => element instanceof HTMLElement && element !== sourceButton);

  if (trigger instanceof HTMLElement) {
    trigger.click();
  }

  document.dispatchEvent(new CustomEvent('popup-boost:open', { bubbles: true }));
  window.dispatchEvent(new CustomEvent('popup-boost:open'));

  if (await waitForPopupBoost()) {
    window.PopupBoost.open();
  }

  runPopupBoostAutomation();

  return true;
}

async function waitForReward(baselineCart) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CONFIG.pollTimeout) {
    await sleep(CONFIG.pollInterval);
    runPopupBoostAutomation();

    const currentCart = await getCart();
    if (hasRewardApplied(currentCart, baselineCart)) {
      storeRewardSignature(currentCart);
      markSpinCompleted(currentCart);
      return currentCart;
    }
  }

  throw new Error('Gift was not added before the timeout.');
}

function continueToCheckout(button) {
  setLoading(button, false);

  const form = button.form || document.getElementById(button.getAttribute('form'));

  if (form instanceof HTMLFormElement && typeof form.requestSubmit === 'function') {
    try {
      form.requestSubmit(button);
      return;
    } catch (error) {
      console.error('[Spin Wheel Checkout]', error);
    }
  }

  window.location.href = button.dataset.checkoutUrl || getSpinWheelConfig().checkoutUrl || '/checkout';
}

async function handleCheckoutClick(event) {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest('[data-spin-wheel-checkout-button]');
  if (!button || !isEnabled() || isHandlingCheckout) return;

  event.preventDefault();

  if (hasCompletedSpin()) {
    event.stopImmediatePropagation();
    continueToCheckout(button);
    return;
  }

  isHandlingCheckout = true;
  setLoading(button, true);
  setMessage(button, 'Opening your free gift wheel...');

  try {
    const baselineCart = await getCart();

    if (cartMatchesStoredReward(baselineCart)) {
      markSpinCompleted(baselineCart);
      continueToCheckout(button);
      return;
    }

    await openPopupBoost(button);

    setMessage(button, 'Your free gift will be claimed automatically, then we will continue to checkout.');
    await waitForReward(baselineCart);

    setMessage(button, 'Free gift added. Continuing to checkout...');
    continueToCheckout(button);
  } catch (error) {
    console.error('[Spin Wheel Checkout]', error);
    setMessage(button, 'We could not confirm your free gift. Please spin again before checkout.', 'error');
  } finally {
    isHandlingCheckout = false;
    setLoading(button, false);
  }
}

document.addEventListener('click', handleCheckoutClick, true);
