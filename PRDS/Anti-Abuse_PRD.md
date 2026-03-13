# **PRD: Identity Guard & Anti-Abuse System**

---

## **1. Executive Summary**

The objective of this system is to enforce a strict **"1-Trial-Per-Student"** policy and facilitate a secure conversion to a **$3.00 for 10 credits** paid model. By integrating institutional authentication with financial verification, the platform mitigates the risk of credit farming via email aliases or multiple accounts.

---

## **2. Authentication & Identity Layer**

### **2.1 Institutional Domain Lockdown**

- **Constraint**: Access is strictly limited to verified educational domains to ensure only students can use the platform.
- **Implementation**: The Google OAuth provider is configured with a whitelist restricted to `*.edu`.
- **Validation**: Any sign-in attempt from a non-whitelisted domain (e.g., `@gmail.com`) is rejected at the provider level. except for admin whitelist. create somewhere where i can create a list of emails to be whitelisted and have unlimited credits.

### **2.2 Immutable Identity Mapping**

- **Constraint**: Prevent a single student from creating multiple accounts using university email aliases (e.g., `netid@wisc.edu` vs. `name@wisc.edu`).
- **Implementation**: The system uses the **Google Unique Identifier (`sub`)** as the primary key for user profiles.
- **Logic**: Because Google provides the same unique ID regardless of the alias used, the application resolves all associated aliases to a single existing profile.

---

## **3. Credit Allocation & Trial Logic**

### **3.1 The "Hook and Convert" Model**

- **Initial Grant**: Upon the first successful login of a unique institutional ID, the system grants exactly one trial credit.
- **Default State**: After the trial credit is consumed, the account balance remains at zero until a purchase is made.

### **3.2 Device & Hardware Contextualization**

- **Requirement**: Associate a hardware/browser "fingerprint" with every new account during the signup handshake.
- **Anti-Abuse Rule**: If a device fingerprint is already associated with an existing profile, any subsequent accounts created on that same hardware initialize with **zero credits** rather than the standard trial.

---

## **4. Financial Integration & Fulfillment**

### **4.1 Transactional Identity (Stripe)**

- **Payment Trigger**: Users purchase additional credits at a rate of $3.00 for 10 sheets.
- **Identity Linking**: Every Stripe Checkout session includes the user’s unique internal `user_id` as a `client_reference_id` to ensure accurate fulfillment.

### **4.2 Automated Fulfillment & Fraud Detection**

- **Webhook Logic**: Upon verification of a successful payment, the system immediately increments the user's `credits` column by 3 units.
- **Fraud Deterrence**: The system leverages professional payment processing "Radar" to identify and block multiple transactions from the same credit card if distributed across different accounts.

---

## **5. Acceptance Criteria**

- **AC 1**: Authentication is denied for any email address not ending in `.edu`.
- **AC 2**: Multiple login attempts using aliases for the same NetID result in the same profile session.
- **AC 3**: Successful $1.00 payment results in the immediate addition of exactly 3 credits to the profile.
- **AC 4**: The administrator account (`ayush170505@gmail.com`) retains unlimited credit status and bypasses domain restrictions.
