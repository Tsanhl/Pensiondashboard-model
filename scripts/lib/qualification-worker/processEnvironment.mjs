const SAFE_HOST_KEYS = Object.freeze([
  "HOME","PATH","TMPDIR","TMP","TEMP","LANG","LC_ALL","LC_CTYPE","USER","LOGNAME","SHELL",
  "SSL_CERT_FILE","SSL_CERT_DIR","REQUESTS_CA_BUNDLE","CURL_CA_BUNDLE","NO_PROXY","no_proxy",
]);

export function safeHostEnvironment(source = process.env) {
  return Object.fromEntries(SAFE_HOST_KEYS.filter((key) => source[key] != null).map((key) => [key,String(source[key])]));
}
