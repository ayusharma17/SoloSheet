export function trialOfferCopy(nonEduTrialCreditsEnabled: boolean): string {
  return nonEduTrialCreditsEnabled
    ? "1 free credit for every new account"
    : "1 free credit for new .edu accounts; any verified Google account can sign up";
}

// Launch-only selection: switch public surfaces to trialOfferCopy(false) before
// disabling the private database flag so non-.edu users never see a stale offer.
export const LAUNCH_TRIAL_OFFER = trialOfferCopy(true);
