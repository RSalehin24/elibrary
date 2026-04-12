export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

export function getEmailValidationState(value) {
  const normalizedEmail = normalizeEmail(value);

  return {
    normalizedEmail,
    hasEmailInput: normalizedEmail.length > 0,
    emailLooksValid: EMAIL_PATTERN.test(normalizedEmail),
  };
}
