/**
 * "Get more minutes" request (ContactSalesDialog -> POST /api/sales/inquiry).
 *
 * The dialog is the only way forward for a desktop user without minutes. Its
 * send button used to be disabled until an organisation was typed - with no
 * hint why, and private customers have none. The organisation is optional
 * now; the backend (which requires the field up to 10/2026) receives a fixed
 * marker for private customers instead of an empty value.
 */

/** Sent as organisation when a private customer leaves the field empty. */
export const PRIVATE_CUSTOMER_ORGANIZATION = 'Privatperson';

export const isValidMinutes = (value) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n) && n > 0;
};

/** Request body for the sales inquiry. */
export function buildSalesInquiry({ email, organizationName, minutesNeeded, message } = {}) {
  const organization = String(organizationName ?? '').trim();
  const note = String(message ?? '').trim();
  return {
    email,
    organizationName: organization || PRIVATE_CUSTOMER_ORGANIZATION,
    minutesNeeded: Math.max(1, Math.round(Number(minutesNeeded))),
    message: note || null
  };
}
