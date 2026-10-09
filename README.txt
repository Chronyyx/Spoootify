SPOOOTIFY — mods for the Spotify desktop app (Windows)
First feature: Fluid Lyrics — Apple Music-style word-by-word lyrics with a living album-art background.

INSTALL
  1. Download Spoootify.zip from https://github.com/Chronyyx/Spoootify/releases/latest and unzip it.
  2. Double-click install.bat.
     - Needs Node.js 18+; if it's missing, the installer offers to install it for you.
     - Windows may warn about running a downloaded .bat - choose "More info" > "Run anyway".
  3. Open Spotify and click the lyrics button (microphone icon) in the player bar.

STAYS WORKING BY ITSELF
  A tiny background helper starts with Windows and:
  - checks for a new Spoootify release shortly after boot (and every 6 h). Updates are only
    installed if they carry the publisher's digital signature;
  - re-applies itself within seconds after Spotify updates (Spotify restarts once).
  Its log: %LOCALAPPDATA%Spoootifywatch.log

USING FLUID LYRICS
  - Click a line to jump to it. Scroll freely; "Back to lyrics" (or Esc) returns to the live line.
  - The ... menu has a sync offset (if a song feels early/late), depth blur, and an option to
    leave Spotify's own lyrics button alone (a ✦ button then opens Fluid Lyrics instead).
  - Alt+click the lyrics button for Spotify's normal lyrics.

UNINSTALL
  Run uninstall.bat (from this folder, or from %LOCALAPPDATA%Spoootify).
  It stops the helper, restores Spotify's original files and deletes everything.

NOTES
  - Only works with Spotify from spotify.com (the Microsoft Store version can't be modified).
  - Lyrics come from Spotify (your own login), then LRCLIB, NetEase Cloud Music and
    lyrics.ovh as fallbacks. Word timing is estimated when no word-synced lyrics exist.
  - The background helper serves the NetEase lookup on 127.0.0.1 (local only, answers
    only Spotify's own page).
  - Modding the Spotify client is against Spotify's terms of use. Use at your own discretion.
