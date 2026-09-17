import Stripe from "stripe";

export const STRIPE_PACKAGE_AMOUNT = 300;
export const STRIPE_PACKAGE_CREDITS = 10;
export const STRIPE_PACKAGE_CURRENCY = "usd";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { maxNetworkRetries: 2 });
}

export function getStripeCheckoutConfig() {
  const secretKey = required("STRIPE_SECRET_KEY");
  const priceId = required("STRIPE_PRICE_ID");
  const appUrl = new URL(required("APP_URL"));
  if (!/^sk_(test|live)_/.test(secretKey) || !priceId.startsWith("price_")) {
    throw new Error("Stripe server configuration is invalid");
  }
  if (appUrl.protocol !== "https:" &&
      !(process.env.NODE_ENV === "development" && appUrl.protocol === "http:")) {
    throw new Error("APP_URL must use HTTPS outside development");
  }
  if (appUrl.username || appUrl.password) {
    throw new Error("APP_URL must not contain credentials");
  }
  return {
    secretKey,
    priceId,
    appUrl: appUrl.origin,
    livemode: secretKey.startsWith("sk_live_"),
  };
}

export function getStripeWebhookConfig() {
  const secretKey = required("STRIPE_SECRET_KEY");
  const webhookSecret = required("STRIPE_WEBHOOK_SECRET");
  const priceId = required("STRIPE_PRICE_ID");
  if (!/^sk_(test|live)_/.test(secretKey) || !webhookSecret.startsWith("whsec_") ||
      !priceId.startsWith("price_")) {
    throw new Error("Stripe webhook configuration is invalid");
  }
  return { secretKey, webhookSecret, priceId };
}
