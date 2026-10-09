/*
 * Spoootify — shared settings for the installer, auto-reapplier and updater.
 *
 * Updates are pulled from this repo's latest GitHub release and are only applied if the
 * release zip carries a valid Ed25519 signature from the private key that lives on the
 * publisher's PC (never in the repo). PUBLIC_KEY below is the matching public half.
 */
export const NAME = 'Spoootify';
export const REPO = 'Chronyyx/Spoootify';
export const ASSET = 'Spoootify.zip';
export const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAp+jIKlcPbVFBk0FZQNDlV89TMQXixBCMRzOH4fqDT2A=
-----END PUBLIC KEY-----`;
export const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000; // also checked once shortly after every boot
