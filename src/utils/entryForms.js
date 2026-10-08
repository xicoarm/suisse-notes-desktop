/**
 * Field checks of the sign-in and registration screens.
 *
 * The submit buttons are never disabled for missing input: a click validates
 * and says what is missing (rule messages under the fields). These helpers
 * name the problems as "field:kind" words for the customer-step telemetry
 * (never the values themselves) and keep the rules in one testable place.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;

export const isValidEmail = (value) => EMAIL_RE.test(String(value || '').trim());
const isBlank = (value) => !String(value ?? '').trim();

/** @returns {string[]} e.g. ['email:missing', 'password:missing'] */
export function loginFieldProblems({ email, password } = {}) {
  const problems = [];
  if (isBlank(email)) problems.push('email:missing');
  if (!password) problems.push('password:missing');
  return problems;
}

/** @returns {string[]} e.g. ['name:missing', 'email:invalid', 'password:too_short', 'confirmPassword:mismatch'] */
export function registerFieldProblems({ name, email, password, confirmPassword } = {}) {
  const problems = [];
  if (isBlank(name)) problems.push('name:missing');
  if (isBlank(email)) problems.push('email:missing');
  else if (!isValidEmail(email)) problems.push('email:invalid');
  if (!password) problems.push('password:missing');
  else if (String(password).length < MIN_PASSWORD_LENGTH) problems.push('password:too_short');
  if (!confirmPassword) problems.push('confirmPassword:missing');
  else if (confirmPassword !== password) problems.push('confirmPassword:mismatch');
  return problems;
}
