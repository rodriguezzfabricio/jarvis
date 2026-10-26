// Credential-shaped test values, built at run time and never written out whole: the repository is public
// (decision 112), and a literal fake token in the source looks real to a secret scanner.
/** An npm access token's shape (npm_ and 36 letters or digits); not a real token. */
export const FAKE_NPM_TOKEN = `npm_${"q8Zr2vLm0TxSynth".repeat(3).slice(0, 36)}`;
