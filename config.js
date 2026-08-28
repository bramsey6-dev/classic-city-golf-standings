// ---------------------------------------------------------------
// CONFIGURATION - fill in the values below, then save this file.
// ---------------------------------------------------------------

const CONFIG = {
  // Your Google Sheet's ID - the long string in the sheet's URL between
  // /d/ and /edit. Already filled in based on the sheet you've been using.
  SHEET_ID: '11Wa1SQ0tQFGY96sJ18tNLGfT9mm8ugOB5XnPXCbuGFg',

  // Each tab's "gid" (a number in the URL after #gid= when that tab is
  // open). To find these:
  //   1. Open your Google Sheet
  //   2. Click the "Standings" tab - look at the URL, copy the number
  //      after #gid=
  //   3. Do the same for the "Teams" tab
  //   4. Do the same for the "Leaderboard" tab
  // Paste each number below (as a plain number, no quotes).
  STANDINGS_GID: 789865304,      // <-- replace with real gid
  TEAMS_GID: 123444465,          // <-- replace with real gid
  LEADERBOARD_GID: 1599043310,    // <-- replace with real gid

  // IMPORTANT: your Google Sheet must be shared as "Anyone with the link
  // can view" for this page to read it. In the Sheet, click "Share" (top
  // right) > change "General access" to "Anyone with the link" > Viewer.
  // Without this, the CSV fetches below will fail.

  // How many golfers each team drafts (must match the Apps Script setting).
  GOLFERS_PER_TEAM: 8,

  // How often (in milliseconds) to auto-refresh in the background.
  // 300000 = 5 minutes. Set to 0 to disable auto-refresh (manual only).
  AUTO_REFRESH_MS: 300000
};