# MQTT+UDP to WebSocket bridge

## Overview

This project adapts the open-source [MQTT+UDP to WebSocket bridge](https://github.com/78/xiaozhi-mqtt-gateway) for [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server).

## Deployment

Follow the [gateway deployment guide](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/main/docs/mqtt-gateway-integration.md).

## Device management APIs

### Authentication

Include a valid `Authorization: Bearer xxx` header in API requests. Generate the token as follows:

1. Get the current date in `yyyy-MM-dd` format, for example `2025-09-15`.
2. Read `MQTT_SIGNATURE_KEY` from `.env`.
3. Concatenate the date string and key, with no separator: `date+MQTT_SIGNATURE_KEY`.
4. Calculate the SHA256 hash of that string.
5. Use the hexadecimal hash as that day's Bearer token.

The server uses its local calendar date. At startup, it calculates and prints the temporary daily key for testing. Treat the resulting token and logs as sensitive.

### API 1: Dispatch device commands

The command API sends MCP commands and returns the device's response:

``` shell
curl --location --request POST 'http://localhost:8007/api/commands/lichuang-dev@@@a0_85_e3_f4_49_34@@@aeebef32-f0ef-4bce-9d8a-894d91bc6932' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer your_daily_token' \
--data-raw '{"type": "mcp", "payload": {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "self.get_device_status", "arguments": {}}}}'
```

### API 2: Query device online status

Original request example:

``` shell
curl --location --request POST 'http://localhost:8007/api/devices/status' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer your_daily_token' \
--data-raw '{
    "deviceIds": [
        "lichuang-dev@@@a0_85_e3_f4_49_34@@@aeebef32-f0ef-4bce-9d8a-894d91bc6932"
    ]
}'
```

Compatibility note: this original example uses `deviceIds`, while the current `/api/devices/status` handler reads `clientIds`. For the current handler, send the array under `clientIds`. The example remains unchanged so this translation does not silently rewrite an existing request fixture or API key.

## Translation and compatibility

Comments, maintainer documentation, local diagnostics, and the package description are in English. Chinese wire-response messages and the incoming-call speech template remain unchanged because devices and server clients consume them. See [translation notes](TRANSLATION_NOTES.md) for exact literals, English meanings, source-line hashes, consumer evidence, and static verification.

This is a translation-only change. It does not alter protocols, authentication, dependencies, endpoints, provider support, or deployment.
