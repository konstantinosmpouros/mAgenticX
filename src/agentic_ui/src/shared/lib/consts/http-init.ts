// Convenience wrapper ensuring every fetch includes credentials.
export const withCredentials = (init: RequestInit = {}): RequestInit => ({
  ...init,
  credentials: "include",
});
