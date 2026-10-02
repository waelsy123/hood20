#!/usr/bin/env bash
# Verify a contract on Robinhood Chain through Etherscan V2 (robin.etherscan.io). forge's own verifier rejects chain
# 4663, so this submits the standard JSON input forge generates. Usage:
#   ETHERSCAN_API_KEY=… script/verify-etherscan.sh <address> src/File.sol:Contract [constructor-args-hex-without-0x]
# Constructor args: cast abi-encode "constructor(address,address,uint256)" 0x… 0x… 90000 | cut -c3-
set -euo pipefail
ADDR=$1; NAME=$2; ARGS=${3:-}
: "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY}"
TMP=$(mktemp)
forge verify-contract "$ADDR" "$NAME" --chain 1 --show-standard-json-input > "$TMP"
API="https://api.etherscan.io/v2/api?chainid=4663"
R=$(curl -s -X POST "$API" --data-urlencode "apikey=$ETHERSCAN_API_KEY" --data-urlencode "module=contract" --data-urlencode "action=verifysourcecode" \
  --data-urlencode "codeformat=solidity-standard-json-input" --data-urlencode "sourceCode@$TMP" --data-urlencode "contractaddress=$ADDR" \
  --data-urlencode "contractname=$NAME" --data-urlencode "compilerversion=v0.8.28+commit.7893614a" --data-urlencode "constructorArguements=$ARGS")
rm -f "$TMP"
echo "submit: $R"
GUID=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result'] if d['status']=='1' else '')")
[ -n "$GUID" ] || exit 1
for _ in $(seq 1 10); do
  sleep 8
  ST=$(curl -s "$API&module=contract&action=checkverifystatus&guid=$GUID&apikey=$ETHERSCAN_API_KEY")
  echo "status: $ST"
  echo "$ST" | grep -q -E "Pass|Already Verified|Fail" && break
done
