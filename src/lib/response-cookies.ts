export function copyResponseCookies<T>(
  cookies: readonly T[],
  setCookie: (cookie: T) => unknown,
): void {
  for (const cookie of cookies) setCookie(cookie);
}
