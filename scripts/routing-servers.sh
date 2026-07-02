#!/usr/bin/env bash
# Local OSRM backup servers (NYC extract): car :5001, bike :5002, foot :5003.
# Build graphs first if routing/ is empty — see README "Local routing backup".
set -euo pipefail
cd "$(dirname "$0")/../routing"

start() {
  local dir=$1 port=$2
  if [ ! -f "$dir/NewYork.osrm.mldgr" ]; then
    echo "missing graph in routing/$dir — build it first (README)" >&2
    return 1
  fi
  if lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "port $port already serving ($dir)"
    return 0
  fi
  (cd "$dir" && nohup osrm-routed --algorithm mld --port "$port" --max-table-size 200 NewYork.osrm > "osrm-$port.log" 2>&1 &)
  echo "started $dir on :$port"
}

start car 5001
start bicycle 5002
start foot 5003
sleep 1
for port in 5001 5002 5003; do
  curl -sf "http://127.0.0.1:$port/nearest/v1/driving/-73.98,40.75" >/dev/null && echo ":$port healthy" || echo ":$port NOT responding" >&2
done
