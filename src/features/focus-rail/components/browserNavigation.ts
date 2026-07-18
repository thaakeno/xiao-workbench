export const BROWSER_HOME_URL = "https://www.google.com/";

const localHostPattern = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#].*)?$/i;
const ipAddressPattern = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;

const parseWebUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

export function toBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) return BROWSER_HOME_URL;

  const directUrl = parseWebUrl(value);
  if (directUrl) return directUrl;

  if (localHostPattern.test(value) || ipAddressPattern.test(value)) {
    const localUrl = parseWebUrl(`http://${value}`);
    if (localUrl) return localUrl;
  }
  if (domainPattern.test(value)) {
    const domainUrl = parseWebUrl(`https://${value}`);
    if (domainUrl) return domainUrl;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
