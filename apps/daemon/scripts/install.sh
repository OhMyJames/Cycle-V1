#!/bin/sh
# Installs the daemon from this folder (the one in the tarball) for the current user:
#
#   <prefix>/share/cycle/{cycle,claude}   the program and the Claude it drives
#   <prefix>/bin/cycle                           a one-line launcher that runs it
#
# <prefix> is $CYCLE_PREFIX, or ~/.local. Nothing needs root, and nothing is started: the daemon
# starts itself, detached, when a client connects (`cycle proxy`, which is what the app runs over
# ssh). A daemon that is already running keeps running the old files until it is stopped.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
prefix=${CYCLE_PREFIX:-$HOME/.local}
dest=$prefix/share/cycle
mkdir -p "$dest" "$prefix/bin"

for file in cycle claude; do
  [ -f "$here/$file" ] || { echo "$here/$file is missing: run this from the unpacked tarball" >&2; exit 1; }
  # Copy beside, then rename over: replacing a file a running daemon is executing would fail otherwise.
  cp "$here/$file" "$dest/.$file.new"
  chmod 755 "$dest/.$file.new"
  mv -f "$dest/.$file.new" "$dest/$file"
done

# A launcher, not a symlink: the daemon finds its Claude beside its own real path.
cat > "$prefix/bin/cycle.new" <<EOF
#!/bin/sh
exec "$dest/cycle" "\$@"
EOF
chmod 755 "$prefix/bin/cycle.new"
mv -f "$prefix/bin/cycle.new" "$prefix/bin/cycle"

echo "Installed: $dest"
echo "Launcher:  $prefix/bin/cycle"
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) echo "Note: $prefix/bin is not on this shell's PATH. In the app's host, give the command as the full path: $prefix/bin/cycle proxy" ;;
esac
echo "Next: put Claude's credentials in ${CYCLE_HOME:-~/.cycle}/config.json, or run: $prefix/bin/cycle login"
