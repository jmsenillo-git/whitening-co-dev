class SpinWheelCheckout {
  static defaults = {
    pollInterval: 1000,
    pollTimeout: 120000,
    popupReadyTimeout: 5000,
    rewardStorageKey: 'popupboost_spin_wheel_reward_claimed',
    completedStorageKey: 'popupboost_spin_wheel_completed',
  };

  constructor(theme = SpinWheelCheckout.getTheme()) {
    this.theme = theme;
    this.config = theme.spinWheelCheckout || {};
    this.isHandlingCheckout = false;
    this.popupBoostObserver = null;
    this.activeButton = null;
    this.hasSeenPopupBoostPopup = false;

    this.handleCheckoutClick = this.handleCheckoutClick.bind(this);
  }

  static getTheme() {
    if (typeof Theme !== 'undefined') return Theme;

    return window.Theme || {};
  }

  init() {
    if (!this.isEnabled()) return;

    document.addEventListener('click', this.handleCheckoutClick, true);
  }

  isEnabled() {
    return this.config.enabled !== false;
  }

  get checkoutUrl() {
    return this.activeButton?.dataset.checkoutUrl || this.config.checkoutUrl || '/checkout';
  }

  get popupId() {
    return String(this.activeButton?.dataset.spinWheelPopupId || this.config.popupId || '').trim();
  }

  get triggerSelector() {
    return String(this.activeButton?.dataset.spinWheelTriggerSelector || this.config.triggerSelector || '').trim();
  }

  get couponCodePrefix() {
    return String(this.activeButton?.dataset.spinWheelCouponCodePrefix || this.config.couponCodePrefix || '').trim();
  }

  sleep(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  getCartStateUrl() {
    const cartUrl = this.theme.routes?.cart_url || '/cart';

    return `${cartUrl.replace(/\/$/, '')}.js`;
  }

  async getCart() {
    const response = await fetch(this.getCartStateUrl(), {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Unable to load cart state.');
    }

    return response.json();
  }

  getDiscountCodes(cart) {
    const cartLevelCodes = (cart.cart_level_discount_applications || []).map((discount) => discount.title);
    const ajaxDiscountCodes = (cart.discount_codes || []).map((discount) => discount.code);
    const lineDiscountCodes = (cart.items || []).flatMap((item) =>
      (item.line_level_discount_allocations || []).map((allocation) => allocation.discount_application?.title)
    );

    return [...cartLevelCodes, ...ajaxDiscountCodes, ...lineDiscountCodes].filter(Boolean).sort();
  }

  escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  stringHasCouponPrefix(value, prefix = this.couponCodePrefix) {
    if (!prefix || typeof value !== 'string') return false;

    const normalizedText = value.trim().toLowerCase();
    const normalizedPrefix = prefix.toLowerCase();
    if (normalizedText.startsWith(normalizedPrefix)) return true;

    return new RegExp(`(^|[^a-z0-9])${this.escapeRegExp(prefix)}`, 'i').test(value);
  }

  objectContainsCouponPrefix(value, prefix = this.couponCodePrefix, seen = new WeakSet(), depth = 0) {
    if (!prefix || value == null || depth > 6) return false;
    if (typeof value === 'string') return this.stringHasCouponPrefix(value, prefix);
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;

    seen.add(value);

    if (Array.isArray(value)) {
      return value.some((item) => this.objectContainsCouponPrefix(item, prefix, seen, depth + 1));
    }

    return Object.values(value).some((item) => this.objectContainsCouponPrefix(item, prefix, seen, depth + 1));
  }

  getPrefixedRewardItems(cart) {
    const prefix = this.couponCodePrefix;
    if (!prefix) return [];

    return (cart.items || []).filter((item) => this.objectContainsCouponPrefix(item, prefix));
  }

  getPrefixedRewardItemKeys(cart) {
    return this.getPrefixedRewardItems(cart)
      .map((item) => item.key)
      .filter(Boolean)
      .sort();
  }

  hasPrefixedReward(cart) {
    return this.getPrefixedRewardItems(cart).length > 0;
  }

  getCartSignature(cart) {
    return {
      itemCount: Number(cart.item_count || 0),
      totalDiscount: Number(cart.total_discount || 0),
      itemKeys: (cart.items || []).map((item) => item.key).sort(),
      rewardItemKeys: this.getPrefixedRewardItemKeys(cart),
      discounts: this.getDiscountCodes(cart),
    };
  }

  hasRewardApplied(cart, baselineCart) {
    const current = this.getCartSignature(cart);
    const previous = this.getCartSignature(baselineCart);

    if (current.itemCount > previous.itemCount) return true;

    return current.itemKeys.some((itemKey) => !previous.itemKeys.includes(itemKey));
  }

  getScopedStorageKey(storageKey) {
    const popupScope = this.popupId || 'default';
    const customerScope = this.config.customerId || 'guest';
    const scopedId = `${popupScope}:${customerScope}`
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, '-')
      .replace(/^-|-$/g, '');

    return `${storageKey}:${scopedId}`;
  }

  storeRewardSignature(cart) {
    sessionStorage.setItem(this.getScopedStorageKey(SpinWheelCheckout.defaults.rewardStorageKey), JSON.stringify(this.getCartSignature(cart)));
  }

  markSpinCompleted(cart) {
    const payload = {
      completedAt: new Date().toISOString(),
      reward: this.getCartSignature(cart),
    };
    const storageKey = this.getScopedStorageKey(SpinWheelCheckout.defaults.completedStorageKey);

    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (error) {
      sessionStorage.setItem(storageKey, JSON.stringify(payload));
    }
  }

  hasCompletedSpin() {
    const storageKey = this.getScopedStorageKey(SpinWheelCheckout.defaults.completedStorageKey);

    try {
      if (localStorage.getItem(storageKey)) return true;
    } catch (error) {
      return Boolean(sessionStorage.getItem(storageKey));
    }

    return Boolean(sessionStorage.getItem(storageKey));
  }

  getStoredRewardSignature() {
    try {
      const rewardValue = sessionStorage.getItem(this.getScopedStorageKey(SpinWheelCheckout.defaults.rewardStorageKey));
      if (rewardValue) return JSON.parse(rewardValue);
    } catch (error) {
      sessionStorage.removeItem(this.getScopedStorageKey(SpinWheelCheckout.defaults.rewardStorageKey));
    }

    try {
      const completedValue =
        localStorage.getItem(this.getScopedStorageKey(SpinWheelCheckout.defaults.completedStorageKey)) ||
        sessionStorage.getItem(this.getScopedStorageKey(SpinWheelCheckout.defaults.completedStorageKey));
      const completed = completedValue ? JSON.parse(completedValue) : null;

      return completed?.reward || null;
    } catch (error) {
      this.clearStoredReward();
    }

    return null;
  }

  clearStoredReward() {
    const rewardStorageKey = this.getScopedStorageKey(SpinWheelCheckout.defaults.rewardStorageKey);
    const completedStorageKey = this.getScopedStorageKey(SpinWheelCheckout.defaults.completedStorageKey);

    sessionStorage.removeItem(rewardStorageKey);
    sessionStorage.removeItem(completedStorageKey);

    try {
      localStorage.removeItem(completedStorageKey);
    } catch (error) {
    }
  }

  cartMatchesStoredReward(cart) {
    const stored = this.getStoredRewardSignature();
    if (!stored) return true;

    const current = this.getCartSignature(cart);

    if (this.couponCodePrefix) {
      return this.hasPrefixedReward(cart);
    }

    if (stored.rewardItemKeys?.length) {
      return stored.rewardItemKeys.some((itemKey) => current.itemKeys.includes(itemKey));
    }

    return current.itemCount >= Number(stored.itemCount || 0);
  }

  setMessage(button, message, type = 'status') {
    const container = button.closest('[data-spin-wheel-checkout]');
    const messageElement = container?.querySelector('[data-spin-wheel-message]');

    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.dataset.type = type;
    messageElement.hidden = !message;
  }

  setLoading(button, isLoading) {
    if (isLoading) {
      button.setAttribute('aria-busy', 'true');
      return;
    }

    button.removeAttribute('aria-busy');
  }

  isVisibleElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  getPopupBoostRoots() {
    return [
      ...document.querySelectorAll(
        '.pb-modal, .pb-popup, .pb-overlay, [class^="pb-"], [class*=" pb-"], [class*="popupboost"], [class*="popup-boost"], [id*="popupboost"], [id*="popup-boost"]'
      ),
    ].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.closest('.pb-teaser')) return false;

      return /spin|wheel|gift|prize|win/i.test(element.textContent || '');
    });
  }

  hasVisiblePopupBoostPopup() {
    return this.getPopupBoostRoots().some((element) => this.isVisibleElement(element));
  }

  createPopupClosedError() {
    const error = new Error('Spin wheel popup closed before the gift was confirmed.');
    error.name = 'SpinWheelPopupClosedError';

    return error;
  }

  updatePopupBoostState() {
    if (this.hasVisiblePopupBoostPopup()) {
      this.hasSeenPopupBoostPopup = true;
    }
  }

  startPopupBoostObserver() {
    this.updatePopupBoostState();

    if (this.popupBoostObserver) return;

    this.popupBoostObserver = new MutationObserver(() => {
      this.updatePopupBoostState();
    });

    this.popupBoostObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  async waitForPopupBoost() {
    const startedAt = Date.now();

    while (Date.now() - startedAt < SpinWheelCheckout.defaults.popupReadyTimeout) {
      if (typeof window.PopupBoost?.open === 'function') return true;
      await this.sleep(250);
    }

    return false;
  }

  tryOpenWithPopupBoostApi() {
    if (typeof window.PopupBoost?.open !== 'function') return false;

    try {
      if (this.popupId) {
        window.PopupBoost.open(this.popupId);
      } else {
        window.PopupBoost.open();
      }
    } catch (error) {
      window.PopupBoost.open();
    }

    setTimeout(() => this.updatePopupBoostState(), 100);

    return true;
  }

  clickConfiguredTrigger(sourceButton) {
    if (this.triggerSelector) {
      let trigger = null;

      try {
        trigger = [...document.querySelectorAll(this.triggerSelector)].find((element) => {
          return element instanceof HTMLElement && element !== sourceButton;
        });
      } catch (error) {
        console.warn('[Spin Wheel Checkout] Invalid PopupBoost trigger selector.', error);
      }

      if (trigger instanceof HTMLElement) {
        trigger.click();
        return true;
      }
    }

    for (const selector of ['[data-popupboost-spin-trigger]']) {
      const trigger = [...document.querySelectorAll(selector)].find((element) => {
        return element instanceof HTMLElement && element !== sourceButton && this.isVisibleElement(element);
      });

      if (trigger instanceof HTMLElement) {
        trigger.click();
        return true;
      }
    }

    return false;
  }

  async openPopupBoost(sourceButton) {
    this.hasSeenPopupBoostPopup = false;
    this.startPopupBoostObserver();

    if (this.tryOpenWithPopupBoostApi()) return true;

    this.clickConfiguredTrigger(sourceButton);
    document.dispatchEvent(new CustomEvent('popup-boost:open', { bubbles: true, detail: { popupId: this.popupId } }));
    window.dispatchEvent(new CustomEvent('popup-boost:open', { detail: { popupId: this.popupId } }));

    if (await this.waitForPopupBoost()) {
      this.tryOpenWithPopupBoostApi();
    }

    this.updatePopupBoostState();

    return true;
  }

  async waitForReward(baselineCart) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < SpinWheelCheckout.defaults.pollTimeout) {
      await this.sleep(SpinWheelCheckout.defaults.pollInterval);
      this.updatePopupBoostState();

      const currentCart = await this.getCart();
      const hasConfirmedReward = this.couponCodePrefix
        ? this.hasPrefixedReward(currentCart)
        : this.hasRewardApplied(currentCart, baselineCart);

      if (hasConfirmedReward && this.hasRewardApplied(currentCart, baselineCart)) {
        this.storeRewardSignature(currentCart);
        this.markSpinCompleted(currentCart);
        return currentCart;
      }

      if (this.hasVisiblePopupBoostPopup()) {
        this.hasSeenPopupBoostPopup = true;
      } else if (this.hasSeenPopupBoostPopup) {
        throw this.createPopupClosedError();
      }
    }

    throw new Error('Gift was not added before the timeout.');
  }

  continueToCheckout(button) {
    this.setLoading(button, false);

    const form = button.form || document.getElementById(button.getAttribute('form'));

    if (form instanceof HTMLFormElement && typeof form.requestSubmit === 'function') {
      form.requestSubmit(button);
      return;
    }

    window.location.href = button.dataset.checkoutUrl || this.checkoutUrl;
  }

  async handleCheckoutClick(event) {
    if (!(event.target instanceof Element)) return;

    const button = event.target.closest('[data-spin-wheel-checkout-button]');
    if (!(button instanceof HTMLButtonElement) || this.isHandlingCheckout) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    this.activeButton = button;

    this.isHandlingCheckout = true;
    this.setLoading(button, true);

    try {
      const baselineCart = await this.getCart();

      if (this.hasPrefixedReward(baselineCart)) {
        this.storeRewardSignature(baselineCart);
        this.markSpinCompleted(baselineCart);
        this.continueToCheckout(button);
        return;
      }

      if (this.hasCompletedSpin()) {
        if (this.cartMatchesStoredReward(baselineCart)) {
          this.continueToCheckout(button);
          return;
        }

        this.clearStoredReward();
      }

      this.setMessage(button, 'Opening your free gift wheel...');

      await this.openPopupBoost(button);

      this.setMessage(button, 'Claim your free gift. Checkout will continue automatically after it is added.');
      await this.waitForReward(baselineCart);

      this.setMessage(button, 'Free gift added. Continuing to checkout...');
      this.continueToCheckout(button);
    } catch (error) {
      console.error('[Spin Wheel Checkout]', error);
      if (error?.name === 'SpinWheelPopupClosedError') {
        this.setMessage(button, 'Spin the wheel before checkout to claim your free gift.', 'error');
      } else {
        this.setMessage(button, 'We could not confirm your free gift. Please spin and claim your prize before checkout.', 'error');
      }
    } finally {
      this.isHandlingCheckout = false;
      this.setLoading(button, false);
      this.activeButton = null;
    }
  }
}

new SpinWheelCheckout().init();
