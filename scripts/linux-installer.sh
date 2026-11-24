#!/bin/sh
# @APP_NAME@ @APP_VERSION@ installer for Linux (x86-64).
# (Source: scripts/linux-installer.sh. The build fills in the @...@ placeholders and appends the
# app's files; see linux-installer.mjs.)
#
#   sh @APP_ID@-@APP_VERSION@-linux-x64-install.sh                  install (or update) for this user
#   sh @APP_ID@-@APP_VERSION@-linux-x64-install.sh --journaldir DIR  ... reading journals from DIR
#   sh @APP_ID@-@APP_VERSION@-linux-x64-install.sh --service         ... running in the background from login
#   sh @APP_ID@-@APP_VERSION@-linux-x64-install.sh --uninstall       remove it again
#
# Installs the program into ~/.local/bin, its icon and a menu entry (no root needed), and with
# --service a systemd user service. The app's own files follow the last line of this script as a
# gzipped tar archive.
set -eu

APP_ID='@APP_ID@'
APP_NAME='@APP_NAME@'
APP_VERSION='@APP_VERSION@'
APP_COMMENT='@APP_COMMENT@'

BIN_DIR="$HOME/.local/bin"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
BINARY="$BIN_DIR/$APP_ID"
DESKTOP_FILE="$APPS_DIR/$APP_ID.desktop"
ICON_FILE="$ICON_DIR/$APP_ID.png"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
SERVICE_DIR="$CONFIG_HOME/systemd/user"
SERVICE_NAME="$APP_ID.service"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME"
# The choices made at install time, so an update keeps them.
SETTINGS_FILE="$CONFIG_HOME/$APP_ID/installer.conf"
DASHBOARD_URL='http://localhost:4267'

usage() {
  cat <<USAGE
$APP_NAME $APP_VERSION installer

Usage: sh $0 [--journaldir DIR] [--service | --no-service] [--uninstall]

  (no options)          Install or update $APP_NAME for this user:
                          program    $BINARY
                          icon       $ICON_FILE
                          menu entry $DESKTOP_FILE
                        An update keeps the options chosen before.
  -j, --journaldir DIR  The game's journal folder, if it isn't found on its own (Steam/Proton,
                        Heroic, Lutris, Bottles and Wine folders are searched). An empty DIR
                        goes back to searching.
  --service             Also run it in the background from login, as a systemd user service
                        ($SERVICE_FILE), so it keeps
                        running whatever's on screen (on a Steam Deck, Game Mode too). The
                        menu entry then opens the dashboard.
  --no-service          Stop running it in the background (the default).
  --uninstall           Remove the program, icon, menu entry and service. The app's data (its
                        database) is kept.
  -h, --help            Show this help.
USAGE
}

ACTION=install
JOURNAL_DIR=''
JOURNAL_DIR_GIVEN=no
SERVICE=keep
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION=uninstall ;;
    -j|--journaldir)
      if [ $# -lt 2 ]; then echo "$1 needs a folder." >&2; exit 2; fi
      shift
      JOURNAL_DIR=$1
      JOURNAL_DIR_GIVEN=yes
      ;;
    --journaldir=*) JOURNAL_DIR=${1#--journaldir=}; JOURNAL_DIR_GIVEN=yes ;;
    --service) SERVICE=on ;;
    --no-service) SERVICE=off ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

refresh_menus() {
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q "$APPS_DIR" 2>/dev/null || true; fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" 2>/dev/null || true; fi
}

has_user_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

remove_service() {
  [ -f "$SERVICE_FILE" ] || return 0
  if has_user_systemd; then
    systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload || true
  else
    rm -f "$SERVICE_FILE"
  fi
}

if [ "$ACTION" = uninstall ]; then
  remove_service
  rm -f "$BINARY" "$DESKTOP_FILE" "$ICON_FILE" "$SETTINGS_FILE"
  rmdir "$CONFIG_HOME/$APP_ID" 2>/dev/null || true
  refresh_menus
  echo "$APP_NAME has been removed."
  echo "Its data (the journal database) is still in $DATA_HOME/edjt; delete that folder to remove it too."
  exit 0
fi

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "This installer is for Linux on x86-64; this computer is $(uname -s) $(uname -m)." >&2
  exit 1
fi
for tool in tar gzip awk tail; do
  if ! command -v "$tool" >/dev/null 2>&1; then echo "The installer needs '$tool', which isn't installed." >&2; exit 1; fi
done

# What was chosen last time, for anything not given now.
SAVED_JOURNAL_DIR=''
if [ -f "$SETTINGS_FILE" ]; then
  SAVED_JOURNAL_DIR=$(sed -n 's/^journaldir=//p' "$SETTINGS_FILE")
fi
if [ "$JOURNAL_DIR_GIVEN" = no ]; then JOURNAL_DIR=$SAVED_JOURNAL_DIR; fi
if [ "$SERVICE" = keep ]; then
  if [ -f "$SERVICE_FILE" ]; then SERVICE=on; else SERVICE=off; fi
fi
if [ "$SERVICE" = on ] && ! has_user_systemd; then
  echo "--service needs systemd's user session (systemctl --user), which isn't available here." >&2
  echo "Install without --service, and start $APP_NAME from the menu instead." >&2
  exit 1
fi
if [ "$(printf '%s' "$JOURNAL_DIR" | wc -l)" -gt 0 ]; then
  echo "The journal folder can't have a line break in its name." >&2
  exit 2
fi

# A value quoted for a systemd ExecStart line: \ and " escaped, % and $ doubled.
systemd_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g; s/\$/$$/g')"
}

# A value quoted for a desktop entry's Exec line: " ` $ escaped, \ written as four, % doubled.
desktop_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\\\\\/g; s/["`$]/\\&/g; s/%/%%/g')"
}

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

if [ -n "$JOURNAL_DIR" ] && [ ! -d "$JOURNAL_DIR" ]; then
  printf 'Note: the journal folder %s does not exist (yet).\n' "$JOURNAL_DIR"
fi

# The app's files, from after the marker line at the end of this script.
PAYLOAD_LINE=$(awk '/^__EDJT_PAYLOAD_BELOW__$/ { print NR + 1; exit }' "$0")
if [ -z "$PAYLOAD_LINE" ]; then echo "This installer is damaged (no app files found)." >&2; exit 1; fi
tail -n +"$PAYLOAD_LINE" "$0" | tar -xzf - -C "$WORK_DIR"

mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR"
# Copied in beside the old one and then swapped in, so a running copy isn't disturbed.
cp "$WORK_DIR/$APP_ID" "$BINARY.new"
chmod 755 "$BINARY.new"
mv -f "$BINARY.new" "$BINARY"
cp "$WORK_DIR/$APP_ID.png" "$ICON_FILE"
chmod 644 "$ICON_FILE"

mkdir -p "$CONFIG_HOME/$APP_ID"
printf 'journaldir=%s\n' "$JOURNAL_DIR" > "$SETTINGS_FILE"

if [ "$SERVICE" = on ]; then
  # It's already running in the background, so the menu entry just opens the dashboard.
  EXEC_LINE="xdg-open $DASHBOARD_URL"
  TERMINAL=false
else
  EXEC_LINE=$(desktop_quote "$BINARY")
  if [ -n "$JOURNAL_DIR" ]; then EXEC_LINE="$EXEC_LINE --journaldir $(desktop_quote "$JOURNAL_DIR")"; fi
  TERMINAL=true
fi
cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=$APP_COMMENT
Exec=$EXEC_LINE
Icon=$APP_ID
Terminal=$TERMINAL
Categories=Game;Utility;
Keywords=Elite;Dangerous;Journal;
X-AppVersion=$APP_VERSION
DESKTOP
chmod 644 "$DESKTOP_FILE"
refresh_menus

SERVICE_STATE=''
if [ "$SERVICE" = on ]; then
  START_LINE=$(systemd_quote "$BINARY")
  if [ -n "$JOURNAL_DIR" ]; then START_LINE="$START_LINE --journaldir $(systemd_quote "$JOURNAL_DIR")"; fi
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=$APP_NAME: $APP_COMMENT

[Service]
ExecStart=$START_LINE
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
SERVICE
  chmod 644 "$SERVICE_FILE"
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1
  # Restarted, so an update runs the new version.
  systemctl --user restart "$SERVICE_NAME"
  sleep 2
  SERVICE_STATE=$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)
else
  remove_service
fi

echo "$APP_NAME $APP_VERSION is installed."
echo "  program:    $BINARY"
echo "  menu entry: $DESKTOP_FILE"
if [ "$SERVICE" = on ]; then echo "  service:    $SERVICE_FILE ($SERVICE_STATE)"; fi
if [ -n "$JOURNAL_DIR" ]; then
  printf '  journals:   %s\n' "$JOURNAL_DIR"
else
  echo "  journals:   found by the program when it starts (Steam/Proton, Heroic, Lutris, Bottles"
  echo "              or Wine). If it can't find them, it says so; then run this installer again"
  echo "              with --journaldir DIR."
fi
if [ "$SERVICE" = on ]; then
  if [ "$SERVICE_STATE" = active ]; then
    echo "It's running in the background, and starts whenever you log in. The dashboard is at $DASHBOARD_URL"
    echo "(the menu entry opens it), or from another device at http://<this computer's address>:4267."
  else
    echo "The service didn't start; see: journalctl --user -u $SERVICE_NAME"
    echo "(Another copy already running, from a terminal say, holds the port: close it first.)"
  fi
  echo "Its log: journalctl --user -u $SERVICE_NAME. To stop running it in the background: sh $0 --no-service"
  # systemd stops a user's services when their last session ends. Lingering keeps them running
  # regardless: across a Steam Deck's switch between Desktop and Game Mode, or with nobody logged in.
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
    echo
    echo "Tip: to keep it running even while you're logged out (and through a Steam Deck's switch"
    echo "between Desktop and Game Mode), turn on lingering for your user:"
    echo "  loginctl enable-linger"
    echo "(If that asks for a password it can't take, use: sudo loginctl enable-linger $(id -un))"
  fi
else
  case ":$PATH:" in
    *":$BIN_DIR:"*) echo "Start it from your applications menu, or run: $APP_ID" ;;
    *) echo "Start it from your applications menu, or run: $BINARY ($BIN_DIR isn't on your PATH)" ;;
  esac
  echo "It runs in a terminal window; the dashboard is at $DASHBOARD_URL."
  echo "To run it in the background from login instead: sh $0 --service"
fi
echo "To remove it: sh $0 --uninstall"
exit 0
__EDJT_PAYLOAD_BELOW__
